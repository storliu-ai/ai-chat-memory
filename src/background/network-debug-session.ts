import { matchChatGPTCaptureEndpoint, type CaptureEndpoint, type CaptureEndpointTarget } from '../adapters/chatgpt/network-response'
import { readChatGPTPaginationRequest, type NetworkRequestEvidence } from '../adapters/chatgpt/network-evidence'
import { matchGeminiCaptureEndpoint } from '../adapters/gemini/capture-urls'

const MAX_RESOURCE_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_PENDING_REQUESTS = 128
const MAX_CONCURRENT_READS = 4
const COMMANDS = ['Page.enable', 'Page.getFrameTree', 'Network.enable', 'Network.getResponseBody', 'Network.streamResourceContent'] as const
type Command = typeof COMMANDS[number]
type Fields = Record<string, unknown>
const fields = (value: unknown): Fields => typeof value === 'object' && value !== null ? value as Fields : {}

interface PendingRequest {
  endpoint: CaptureEndpoint; loaderId: string; response: boolean; pagination: NetworkRequestEvidence
  stream?: { chunks: Uint8Array[]; bytes: number; prefix?: Uint8Array; pending: boolean; ended: boolean; finalized: boolean; fallback?: boolean }
}
export interface DebugSessionCallbacks {
  response: (body: string, endpoint: CaptureEndpoint, bytes: number, pagination: NetworkRequestEvidence) => void
  failure: (message: string) => void
  navigation: (url: string, sameDocument: boolean) => boolean
}

/** The sole debugger API owner. No runtime-supplied commands, target IDs,
 * execution, credentials, request replay, extra-header events or child sessions. */
export class NetworkDebugSession {
  private attached = false
  private closed = false
  private failed = false
  private frameId = ''
  private loaderId = ''
  private frameUrl = ''
  private captureNavigationSeen = false
  private totalBytes = 0
  private reading = 0
  private readonly requests = new Map<string, PendingRequest>()
  private readonly seenRequests = new Set<string>()
  private readonly tabId: number
  private readonly target: CaptureEndpointTarget
  private readonly callbacks: DebugSessionCallbacks

  constructor(tabId: number, target: CaptureEndpointTarget, callbacks: DebugSessionCallbacks) {
    this.tabId = tabId; this.target = target; this.callbacks = callbacks
  }

  get pendingCount(): number { return this.requests.size + this.reading }

  private match(url: string): CaptureEndpoint | null {
    return this.target.platform === 'gemini' ? matchGeminiCaptureEndpoint(url, this.target) : matchChatGPTCaptureEndpoint(url, this.target)
  }

  private command(method: Command, parameters?: Fields): Promise<unknown> {
    if (this.closed || this.failed || !this.attached || !COMMANDS.includes(method)) return Promise.reject(new Error('调试连接已结束'))
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, parameters)
  }

  async connect(): Promise<void> {
    chrome.debugger.onEvent.addListener(this.onEvent)
    chrome.debugger.onDetach.addListener(this.onDetach)
    try {
      // attach refuses occupied targets. Never detach an existing debugger to retry.
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3')
      this.attached = true
      if (this.closed) { await this.disconnect(); throw new Error('采集已取消') }
      await this.command('Page.enable')
      const tree = fields(fields(await this.command('Page.getFrameTree')).frameTree)
      const frame = fields(tree.frame)
      if (typeof frame.id !== 'string') throw new Error('无法绑定主页面')
      this.frameId = frame.id
      this.loaderId = typeof frame.loaderId === 'string' ? frame.loaderId : ''
      this.frameUrl = typeof frame.url === 'string' ? frame.url : ''
      await this.command('Network.enable', { maxResourceBufferSize: MAX_RESOURCE_BYTES, maxTotalBufferSize: MAX_TOTAL_BYTES })
    } catch {
      await this.disconnect()
      throw new Error('无法建立接口验证连接，请关闭该页 DevTools 或其他调试工具后重试')
    }
  }

  private readonly onDetach = (source: chrome.debugger.Debuggee, reason: string): void => {
    if (source.tabId !== this.tabId || this.closed) return
    this.attached = false
    this.fail(reason === 'target_closed' ? '验证页面已关闭，本次未保存对话；请重新发起验证' : '调试连接被终止（如打开 DevTools 或停止调试），本次未保存对话；请重新发起验证')
  }

  private fail(message: string): void {
    if (this.closed || this.failed) return
    this.failed = true
    this.requests.clear()
    this.callbacks.failure(message)
  }

  private readonly onEvent = (source: chrome.debugger.Debuggee, method: string, data?: object): void => {
    if (this.closed || this.failed || source.tabId !== this.tabId || 'sessionId' in source) return
    const event = fields(data)
    if (method === 'Page.frameNavigated') {
      const frame = fields(event.frame)
      if (frame.parentId) return
      // CDP may repeat a notification for the already bound document. A real
      // reload has a new loader; duplicate notifications must not consume the
      // single authorized navigation or invalidate an in-flight response.
      if (frame.id === this.frameId && frame.loaderId && frame.loaderId === this.loaderId && frame.url === this.frameUrl) return
      if (this.captureNavigationSeen) { this.fail('页面已切换或再次刷新，采集已停止'); return }
      if (typeof frame.url !== 'string' || !this.callbacks.navigation(frame.url, false)) { this.fail('页面已切换或再次刷新，验证已停止'); return }
      this.captureNavigationSeen = true
      this.frameId = String(frame.id ?? '')
      this.loaderId = String(frame.loaderId ?? '')
      this.frameUrl = frame.url
      return
    }
    if (method === 'Page.navigatedWithinDocument') {
      if (event.frameId === this.frameId && (typeof event.url !== 'string' || !this.callbacks.navigation(event.url, true))) this.fail('页面已切换，验证已停止')
      return
    }
    const requestId = typeof event.requestId === 'string' ? event.requestId : ''
    if (!requestId) return
    if (method === 'Network.requestWillBeSent') {
      // Enabling Network before the controlled reload also observes requests
      // from the old document. They never belong to this capture generation.
      if (!this.captureNavigationSeen) return
      // Only inspect URL/method; never read headers, cookies or postData.
      const request = fields(event.request)
      const endpoint = typeof request.url === 'string' ? this.match(request.url) : null
      if (event.redirectResponse || this.seenRequests.has(requestId)) {
        if (endpoint || this.requests.has(requestId)) this.fail('目标响应发生重定向或请求 ID 重用，验证已停止')
        this.requests.delete(requestId)
        return
      }
      if (!endpoint || request.method !== (this.target.platform === 'gemini' ? 'POST' : 'GET') || event.frameId !== this.frameId || event.loaderId !== this.loaderId || !['Fetch', 'XHR'].includes(String(event.type))) return
      if (this.seenRequests.size >= 2048 || this.pendingCount >= MAX_PENDING_REQUESTS) { this.fail('响应数量超出本次验证容量'); return }
      let pagination: NetworkRequestEvidence
      try { pagination = this.target.platform === 'gemini' ? {} : readChatGPTPaginationRequest(String(request.url)) }
      catch { this.fail('目标接口使用无法核对的分页游标，未保存对话'); return }
      this.seenRequests.add(requestId)
      this.requests.set(requestId, { endpoint, loaderId: this.loaderId, response: false, pagination })
    } else if (method === 'Network.responseReceived') {
      const pending = this.requests.get(requestId)
      if (!pending) return
      const response = fields(event.response)
      const mime = this.target.platform === 'gemini' ? /^(?:application\/json|text\/plain)(?:;|$)/i : /^application\/json(?:;|$)/i
      if (event.frameId !== this.frameId || event.loaderId !== pending.loaderId || pending.loaderId !== this.loaderId || typeof response.url !== 'string' || this.match(response.url) !== pending.endpoint || response.status !== 200 || !mime.test(String(response.mimeType))) {
        this.fail(response.status === 429 ? '网站接口已限流（HTTP 429），本次未保存；请稍后重新采集' : '目标接口未返回有效 JSON 响应，本次验证未通过')
        return
      }
      pending.response = true
      if (this.target.platform === 'gemini') {
        if (this.reading >= MAX_CONCURRENT_READS) { this.fail('同时读取的响应超过本次验证容量'); return }
        pending.stream = { chunks: [], bytes: 0, pending: true, ended: false, finalized: false }
        this.reading += 1
        void this.startStream(requestId, pending).finally(() => { this.reading -= 1 })
      }
    } else if (method === 'Network.dataReceived') {
      const pending = this.requests.get(requestId)
      if (!pending?.stream || typeof event.data !== 'string') return
      try {
        const chunk = this.decodeBase64(event.data)
        pending.stream.bytes += chunk.byteLength
        this.totalBytes += chunk.byteLength
        if (pending.stream.bytes > MAX_RESOURCE_BYTES || this.totalBytes > MAX_TOTAL_BYTES) throw new Error()
        pending.stream.chunks.push(chunk)
      } catch { this.fail('接口流超过容量或包含无效编码，本次未保存') }
    } else if (method === 'Network.loadingFailed' && this.requests.has(requestId)) {
      const pending = this.requests.get(requestId)!
      if (pending.stream && event.canceled === true && event.errorText === 'net::ERR_ABORTED') {
        pending.stream.ended = true
        this.finishStream(requestId, pending)
        return
      }
      this.requests.delete(requestId)
      this.fail('目标接口加载失败，本次验证未通过')
    } else if (method === 'Network.loadingFinished') {
      const pending = this.requests.get(requestId)
      if (!pending) return
      if (pending.stream) { pending.stream.ended = true; this.finishStream(requestId, pending); return }
      this.requests.delete(requestId)
      if (!pending.response || pending.loaderId !== this.loaderId) { this.fail('响应来源已失效，本次验证未通过'); return }
      if (typeof event.encodedDataLength === 'number' && event.encodedDataLength > MAX_RESOURCE_BYTES) { this.fail('单个响应超过 128 MiB，本次验证已停止'); return }
      if (this.reading >= MAX_CONCURRENT_READS) { this.fail('同时读取的响应超过本次验证容量，请重新发起'); return }
      this.reading += 1
      void this.readBody(requestId, pending).finally(() => { this.reading -= 1 })
    }
  }

  private decodeBase64(value: string): Uint8Array {
    if (value.length > MAX_RESOURCE_BYTES * 2) throw new Error()
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  }

  private async startStream(requestId: string, pending: PendingRequest): Promise<void> {
    try {
      let result: Fields
      try { result = fields(await this.command('Network.streamResourceContent', { requestId })) }
      catch {
        if (this.closed || this.failed || pending.loaderId !== this.loaderId) return
        // A small native pagination response can finish before Chrome enables
        // streaming. Read that same cached response once, never replay it.
        const stream = pending.stream!
        stream.pending = false; stream.fallback = true; stream.chunks.length = 0
        this.finishStream(requestId, pending)
        return
      }
      if (this.closed || this.failed || pending.loaderId !== this.loaderId) return
      if (typeof result.bufferedData !== 'string') throw new Error()
      const stream = pending.stream!
      stream.prefix = this.decodeBase64(result.bufferedData)
      stream.bytes += stream.prefix.byteLength
      this.totalBytes += stream.prefix.byteLength
      if (stream.bytes > MAX_RESOURCE_BYTES || this.totalBytes > MAX_TOTAL_BYTES) throw new Error()
      stream.pending = false
      this.finishStream(requestId, pending)
    } catch { this.fail('Chrome 无法读取完整 Gemini 响应流，请升级浏览器或使用 DOM 采集') }
  }

  private finishStream(requestId: string, pending: PendingRequest): void {
    const stream = pending.stream!
    if (stream.pending || !stream.ended || stream.finalized || this.closed || this.failed) return
    stream.finalized = true
    this.requests.delete(requestId)
    if (stream.fallback) {
      if (this.reading >= MAX_CONCURRENT_READS) { this.fail('同时读取的响应超过本次验证容量'); return }
      this.reading += 1
      void this.readBody(requestId, pending).finally(() => { this.reading -= 1 })
      return
    }
    try {
      if (!pending.response || pending.loaderId !== this.loaderId || !stream.prefix || !stream.bytes) throw new Error()
      const data = new Uint8Array(stream.bytes)
      data.set(stream.prefix)
      let offset = stream.prefix.byteLength
      for (const chunk of stream.chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(data)
      stream.chunks.length = 0; stream.prefix = undefined
      this.callbacks.response(body, pending.endpoint, data.byteLength, pending.pagination)
    } catch { this.fail('Gemini 响应流不完整，本次未保存对话') }
  }

  private async readBody(requestId: string, pending: PendingRequest): Promise<void> {
    try {
      const result = fields(await this.command('Network.getResponseBody', { requestId }))
      if (this.closed || this.failed || pending.loaderId !== this.loaderId) return
      if (typeof result.body !== 'string' || result.body.length > MAX_RESOURCE_BYTES * 2) throw new Error()
      const body = result.base64Encoded === true ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0))) : result.body
      const bytes = new TextEncoder().encode(body).byteLength
      this.totalBytes += bytes
      if (bytes > MAX_RESOURCE_BYTES || this.totalBytes > MAX_TOTAL_BYTES) { this.fail('响应超过本次验证容量，未保存对话'); return }
      this.callbacks.response(body, pending.endpoint, bytes, pending.pagination)
    } catch {
      this.fail('未能读取目标响应，可能已超出调试缓存；本次验证未通过，请重新发起')
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true
    chrome.debugger.onEvent.removeListener(this.onEvent)
    chrome.debugger.onDetach.removeListener(this.onDetach)
    this.requests.clear(); this.seenRequests.clear()
    if (this.attached) {
      this.attached = false
      await chrome.debugger.detach({ tabId: this.tabId }).catch(() => undefined)
    }
  }
}

/** Called only after a persisted job's exact content-document ownership handshake.
 * Chrome restricts detach to this extension's own debugging session. */
export async function detachInterruptedNetworkSession(tabId: number): Promise<void> {
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
}
