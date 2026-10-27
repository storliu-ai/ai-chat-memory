import { ChatGPTAdapter } from '../adapters/chatgpt/chatgpt-adapter'
import { ChatGPTShareAdapter } from '../adapters/chatgpt/chatgpt-share-adapter'
import { mergeExtractedConversations } from '../adapters/dom-scroll-collector'
import { captureAttachments } from './attachment-capture'
import type { ConversationAttachment, ExtractedConversation } from '../shared/models'
import { getChatGPTCaptureBlockers, isChatGPTBranchAction, isChatGPTConversationSubmission } from '../adapters/chatgpt/capture-page-state'
import { EXTENSION_BUILD_ID } from '../shared/build-id'
import {
  isNetworkCaptureActive, NETWORK_PAGE_CONTEXT, NETWORK_PAGE_PROBE, NETWORK_PAGE_REFRESH, NETWORK_TASK_CHANGED, NETWORK_VERIFY_TASK,
  type NetworkCaptureResponse, type NetworkPageProbe, type NetworkCaptureStatus,
} from '../shared/network-capture'
import { sendRuntimeRequest } from '../shared/runtime-client'
import { RUNTIME_MESSAGE_TYPE } from '../shared/runtime-messages'

interface ObserverControl {
  setNetworkCapturePaused: (paused: boolean) => void
  hasActiveCompleteCapture: () => boolean
}

/** Install before any ordinary observer starts. Only the adapter reads host DOM. */
export async function initializeNetworkCapturePage(): Promise<{ ownedPage: boolean; bindObserver: (observer: ObserverControl) => void }> {
  if (location.hostname !== 'chatgpt.com') return { ownedPage: false, bindObserver: () => undefined }
  const adapter = location.pathname.startsWith('/share/') ? new ChatGPTShareAdapter() : new ChatGPTAdapter()
  const documentToken = crypto.randomUUID()
  const base = { type: RUNTIME_MESSAGE_TYPE.NETWORK_CAPTURE, contentScriptBuildId: EXTENSION_BUILD_ID, documentToken } as const
  let observer: ObserverControl | null = null
  let boundJobId: string | undefined
  let branchRevision = 0
  let paused = true
  let ownedPage = false
  let stopped = false
  let polling = false
  let statusText: HTMLElement | null = null
  let driving = false
  let awaitingDecision = false
  const attachmentCache = new Map<string, ConversationAttachment>()
  const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

  const pageState = (): NetworkPageProbe => ({
    url: location.href, conversationId: adapter.getConversationId(), documentToken,
    contentScriptBuildId: EXTENSION_BUILD_ID, branchRevision,
    blockers: getChatGPTCaptureBlockers(observer?.hasActiveCompleteCapture() ?? true),
  })
  const apply = (response: NetworkCaptureResponse): void => {
    paused = response.paused
    awaitingDecision = response.status?.phase === 'awaiting-confirmation'
    if (response.status && isNetworkCaptureActive(response.status)) boundJobId = response.status.id
    else if (!paused) boundJobId = undefined
    observer?.setNetworkCapturePaused(paused)
    if (statusText && response.status) statusText.textContent = response.status.message
    if (response.drive && response.status?.operation === 'save' && response.status.phase !== 'awaiting-confirmation' && !driving && isNetworkCaptureActive(response.status)) void drive(response.status)
  }

  async function drive(status: NetworkCaptureStatus): Promise<void> {
    if (driving) return
    driving = true
    const jobId = status.id
    const revision = branchRevision
    const targetId = adapter.getConversationId()
    const request = { ...base, jobId, conversationId: status.conversationId }
    let capture: ExtractedConversation | null = null
    const current = (): boolean => !stopped && !awaitingDecision && paused && boundJobId === jobId && branchRevision === revision && adapter.getConversationId() === targetId
    const check = (): void => { if (!current()) throw new Error('采集已取消，或页面及分支已切换') }
    let lastReport = 0
    const progress = (messageCount: number): void => {
      if (Date.now() - lastReport < 1000) return
      lastReport = Date.now()
      void sendRuntimeRequest({ ...request, action: 'progress', messageCount }).then(apply).catch(() => undefined)
    }
    const foreground = async (): Promise<void> => {
      if (!document.hidden) return
      apply(await sendRuntimeRequest({ ...request, action: 'progress', needsForeground: true }))
      while (document.hidden) { check(); await delay(500) }
      check()
    }
    try {
      const started = Date.now()
      while (!adapter.getMessages().length) {
        check()
        if (Date.now() - started > 30_000) {
          if (document.hidden) await foreground()
          else throw new Error('目标页未显示可核对消息，请检查页面加载后重新采集')
        }
        await delay(300)
      }
      let state = await sendRuntimeRequest({ ...request, action: 'status' })
      apply(state)
      // A complete plain-text share tree needs only its rendered anchor; files
      // and images still require the existing rendered-candidate sweep.
      if (ownedPage && state.networkComplete && !state.needsAttachmentScan && !(adapter.extractConversation()?.attachmentCandidates?.length)) capture = adapter.extractConversation()
      else {
        while (true) {
          check()
          capture = adapter instanceof ChatGPTShareAdapter
            ? await adapter.collectShareConversation(async () => { check() }, progress)
            : await adapter.collectConversation(progress, () => !current())
          check()
          if (!document.hidden || capture?.captureComplete) break
          await foreground()
        }
      }
      if (!capture?.messages.length) throw new Error('页面未提供可核对的原生消息，未保存接口正文')
      // The DOM may settle at a temporary virtual-list edge before a slower
      // history page arrives. Continue natural scrolling within this same job;
      // a DOM boundary never substitutes for the independent cursor proof.
      for (let pass = 0; pass < 4; pass += 1) {
        for (let round = 0; round < 20; round += 1) {
          check()
          state = await sendRuntimeRequest({ ...request, action: 'status' })
          apply(state)
          if (state.networkComplete) break
          await delay(500)
        }
        if (state.networkComplete || pass === 3) break
        await foreground()
        const next = adapter instanceof ChatGPTShareAdapter
          ? await adapter.collectShareConversation(async () => { check() }, progress)
          : await adapter.collectConversation(progress, () => !current())
        check()
        if (!next?.messages.length) continue
        const merged = mergeExtractedConversations(capture, next)
        if (!merged) throw new Error('连续扫描的页面消息身份或顺序冲突，未保存接口正文')
        capture = merged
      }
      check()
      if (!state.networkComplete) throw new Error('接口历史仍有缺页或游标链未接续，未保存；请重新采集')
      // Rendered binary fallbacks stay in this document. The worker receives
      // only the DOM cross-check and attachment metadata, never their URLs/bytes.
      const proof = { ...capture, attachmentCandidates: capture.attachmentCandidates?.map((candidate) => ({ ...candidate, sourceUrl: null, renderedDataUrl: undefined })) }
      const serialized = JSON.stringify(proof)
      if (serialized.length > 12_500_000 || new TextEncoder().encode(serialized).byteLength > 40 * 1024 * 1024) throw new Error('页面核对信息超出通信容量，未保存接口正文')
      const committed = await sendRuntimeRequest({ ...request, action: 'commit', capture: proof })
      apply(committed)
      if (committed.status?.phase === 'awaiting-confirmation') return
      check()
      if (!committed.attachmentPlan || !committed.attachmentPolicy) throw new Error('正文已保存，但附件阶段未获得授权')
      const attachmentCapture = capture
      const candidates = (attachmentCapture.attachmentCandidates ?? []).map((candidate) => {
        const localIndex = candidate.messageIndex ?? attachmentCapture.messages.findIndex((message) => message.sourceTurnId === candidate.sourceTurnId)
        const plan = committed.attachmentPlan!.find((entry) => entry.localIndex === localIndex)
        if (!plan) throw new Error('正文已保存，但有附件无法与原生消息对应')
        return { ...candidate, messageIndex: plan.networkIndex, sourceTurnId: plan.sourceTurnId }
      })
      const attachments = await captureAttachments(candidates, committed.attachmentPolicy, attachmentCache)
      check()
      const done = await sendRuntimeRequest({ ...request, action: 'attachments', attachments })
      apply(done)
      if (!done.status || !['complete', 'partial'].includes(done.status.phase)) throw new Error('接口采集保存未确认')
    } catch (error: unknown) {
      if (boundJobId === jobId) {
        const proof = capture ? { ...capture, attachmentCandidates: undefined } : undefined
        await sendRuntimeRequest({ ...request, action: 'error', capture: proof, error: error instanceof Error ? error.message : '接口采集未完成' }).then(apply).catch(() => undefined)
      }
    } finally { driving = false; attachmentCache.clear() }
  }
  const update = async (): Promise<void> => {
    if (stopped || polling) return
    polling = true
    try {
      const id = adapter.getConversationId()
      const response = await sendRuntimeRequest({ ...base, action: ownedPage ? 'status' : 'pause', conversationId: id ?? undefined, jobId: boundJobId })
      apply(response)
      if (!ownedPage && boundJobId && response.status?.originTabId !== undefined) {
        // A source status read rechecks its exact document, route and branch.
        await sendRuntimeRequest({ ...base, action: 'status', conversationId: id ?? undefined, jobId: boundJobId }).then(apply)
      }
    } catch {
      // Fail closed until the background can tell us that its lock is released.
      observer?.setNetworkCapturePaused(true)
    } finally { polling = false }
  }

  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null) return false
    const request = message as Record<string, unknown>
    if (request.type === NETWORK_PAGE_PROBE) {
      if (request.documentToken && request.documentToken !== documentToken) { respond(null); return false }
      if (typeof request.jobId === 'string') {
        boundJobId = request.jobId
        paused = true
        observer?.setNetworkCapturePaused(true)
      }
      respond(pageState())
    } else if (request.type === NETWORK_PAGE_CONTEXT) {
      if (request.documentToken !== documentToken) { respond(null); return false }
      const capture = adapter.extractConversation() ?? {
        platform: 'chatgpt', conversationId: adapter.getConversationId(), title: adapter.getTitle(), url: location.href,
        messages: adapter.getMessages(), accountIdentifier: adapter.getAccountIdentifier(), accountLabel: adapter.getAccountLabel(),
      }
      respond({ ...capture, attachmentCandidates: undefined, nativePinned: adapter.isCurrentConversationPinned() })
    } else if (request.type === NETWORK_PAGE_REFRESH) {
      const state = pageState()
      const accepted = request.jobId === boundJobId && request.documentToken === documentToken && request.conversationId === state.conversationId && request.branchRevision === branchRevision && state.blockers.length === 0
      respond({ accepted })
      if (accepted) location.reload()
    } else if (request.type === NETWORK_VERIFY_TASK) {
      if (request.jobId === boundJobId) respond({ jobId: boundJobId })
    } else if (request.type === NETWORK_TASK_CHANGED) {
      // Do not trust a status broadcast as authorization; query the worker gate.
      void update()
    }
    return false
  })

  const claimed = await sendRuntimeRequest({ ...base, action: 'claim', conversationId: adapter.getConversationId() ?? undefined })
  ownedPage = claimed.ownedPage === true
  apply(claimed)
  if (!ownedPage && adapter.getConversationId()) await update()

  if (ownedPage) {
    const statusHost = document.createElement('div')
    statusHost.setAttribute('data-extension-ui', 'ai-chat-memory')
    const shadow = statusHost.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = ':host{all:initial}section{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:12px;border:1px solid #bbb;background:#fff;color:#292333;border-radius:12px;font:13px/1.5 system-ui}p{margin:3px 0}button{margin-top:6px;padding:5px 10px;font:inherit}'
    const section = document.createElement('section')
    section.setAttribute('role', 'status')
    const title = document.createElement('strong')
    title.textContent = claimed.status?.operation === 'save' ? '接口采集 · 保存到原对话' : '接口连接验证 · 本次不保存对话'
    statusText = document.createElement('p')
    statusText.textContent = claimed.status?.message ?? '正在等待目标响应'
    const button = document.createElement('button')
    button.textContent = '返回原对话查看'
    button.onclick = () => { void sendRuntimeRequest({ ...base, action: 'return', jobId: boundJobId }).catch(() => undefined) }
    section.append(title, statusText, button)
    shadow.append(style, section)
    ;(document.body ?? document.documentElement).append(statusHost)
  }

  const branchAction = (event: Event): void => {
    if (!event.isTrusted || !(event.type === 'submit' ? isChatGPTConversationSubmission(event.target) : isChatGPTBranchAction(event.target))) return
    branchRevision += 1
    if (boundJobId && !ownedPage) void sendRuntimeRequest({ ...base, action: 'invalidate', conversationId: adapter.getConversationId() ?? undefined, jobId: boundJobId }).then(apply).catch(() => undefined)
  }
  document.addEventListener('click', branchAction, true)
  document.addEventListener('submit', branchAction, true)
  const timer = window.setInterval(() => { if (paused || boundJobId) void update() }, 5_000)
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    if (!event.persisted) { stopped = true; window.clearInterval(timer); document.removeEventListener('click', branchAction, true); document.removeEventListener('submit', branchAction, true) }
  })
  return { ownedPage, bindObserver: (next) => { observer = next; observer.setNetworkCapturePaused(paused) } }
}
