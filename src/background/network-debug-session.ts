import { matchChatGPTCaptureEndpoint, type CaptureEndpoint, type CaptureEndpointTarget } from '../adapters/chatgpt/network-response'
import { readChatGPTPaginationRequest, type NetworkRequestEvidence } from '../adapters/chatgpt/network-evidence'

const MAX_RESOURCE_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_PENDING_REQUESTS = 128
const MAX_CONCURRENT_READS = 4
const COMMANDS = ['Page.enable', 'Page.getFrameTree', 'Network.enable', 'Network.getResponseBody'] as const
type Command = typeof COMMANDS[number]
type Fields = Record<string, unknown>
const fields = (value: unknown): Fields => typeof value === 'object' && value !== null ? value as Fields : {}

interface PendingRequest { endpoint: CaptureEndpoint; loaderId: string; response: boolean; pagination: NetworkRequestEvidence }
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
      const endpoint = typeof request.url === 'string' ? matchChatGPTCaptureEndpoint(request.url, this.target) : null
      if (event.redirectResponse || this.seenRequests.has(requestId)) {
        if (endpoint || this.requests.has(requestId)) this.fail('目标响应发生重定向或请求 ID 重用，验证已停止')
        this.requests.delete(requestId)
        return
      }
      if (!endpoint || request.method !== 'GET' || event.frameId !== this.frameId || event.loaderId !== this.loaderId || !['Fetch', 'XHR'].includes(String(event.type))) return
      if (this.seenRequests.size >= 2048 || this.pendingCount >= MAX_PENDING_REQUESTS) { this.fail('响应数量超出本次验证容量'); return }
      let pagination: NetworkRequestEvidence
      try { pagination = readChatGPTPaginationRequest(String(request.url)) }
      catch { this.fail('目标接口使用无法核对的分页游标，未保存对话'); return }
      this.seenRequests.add(requestId)
      this.requests.set(requestId, { endpoint, loaderId: this.loaderId, response: false, pagination })
    } else if (method === 'Network.responseReceived') {
      const pending = this.requests.get(requestId)
      if (!pending) return
      const response = fields(event.response)
      if (event.frameId !== this.frameId || event.loaderId !== pending.loaderId || pending.loaderId !== this.loaderId || typeof response.url !== 'string' || matchChatGPTCaptureEndpoint(response.url, this.target) !== pending.endpoint || response.status !== 200 || !/^application\/json(?:;|$)/i.test(String(response.mimeType))) {
        this.fail(response.status === 429 ? '网站接口已限流（HTTP 429），本次未保存；请稍后重新采集' : '目标接口未返回有效 JSON 响应，本次验证未通过')
        return
      }
      pending.response = true
    } else if (method === 'Network.loadingFailed' && this.requests.has(requestId)) {
      this.requests.delete(requestId)
      this.fail('目标接口加载失败，本次验证未通过')
    } else if (method === 'Network.loadingFinished') {
      const pending = this.requests.get(requestId)
      if (!pending) return
      this.requests.delete(requestId)
      if (!pending.response || pending.loaderId !== this.loaderId) { this.fail('响应来源已失效，本次验证未通过'); return }
      if (typeof event.encodedDataLength === 'number' && event.encodedDataLength > MAX_RESOURCE_BYTES) { this.fail('单个响应超过 128 MiB，本次验证已停止'); return }
      if (this.reading >= MAX_CONCURRENT_READS) { this.fail('同时读取的响应超过本次验证容量，请重新发起'); return }
      this.reading += 1
      void this.readBody(requestId, pending).finally(() => { this.reading -= 1 })
    }
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
