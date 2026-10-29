import { deleteShareCaptureJob, putShareCaptureJob, readShareCaptureJobs } from '../db/share-capture-jobs'
import { getSavedConversationBySource } from '../services/conversation-service'
import { isChatMessage } from '../services/validation'
import type { ChatMessage, ConversationSavePayload, ExtractedConversation } from '../shared/models'
import type { RuntimeRequest } from '../shared/runtime-messages'
import { findShareAnchor, getChatGPTSourceId, normalizeChatGPTShareUrl, SHARE_SOURCE_CONTEXT_REQUEST, SHARE_TASK_STATUS_EVENT, type ShareCaptureResponse, type ShareCaptureStatus } from '../shared/share-capture'
import { EXTENSION_BUILD_ID } from '../shared/build-id'
import { getGeminiSourceId, getGeminiAccountContext, normalizeGeminiShareUrl, resolveGeminiShareUrl } from '../adapters/gemini/capture-urls'
import { alignGeminiDomShare, hasGeminiDomHead, mergeGeminiDomShare, portableGeminiDomCapture, retainGeminiDomShareText } from '../adapters/gemini/dom-share'
import { createAccountId, createContentHash } from '../utils/hash'
import { NETWORK_PAGE_PROBE, type NetworkPageProbe } from '../shared/network-capture'

type Request = Extract<RuntimeRequest, { type: 'SHARE_CAPTURE' }>
interface Job {
  status: ShareCaptureStatus
  url?: string
  sourceMessages?: ChatMessage[]
  capture?: ExtractedConversation
  documentId?: string
  ownsTab?: boolean
  originDocumentId?: string
  lastHeartbeatAt?: number
  captureNavigated?: boolean
  sourceContext?: { capture: ExtractedConversation; accountId: string; token: string; revision: number; accountContext: string }
  accountId?: string
}
const jobs = new Map<number, Job>()
const platformOf = (job: Job): 'chatgpt' | 'gemini' => job.status.platform ?? 'chatgpt'
const normalizeShare = (url: unknown, platform: string): string | null => platform === 'gemini' ? normalizeGeminiShareUrl(url) : normalizeChatGPTShareUrl(url)
const sourceIdFor = (url: string, platform: string): string | null => platform === 'gemini' ? getGeminiSourceId(url) : getChatGPTSourceId(url)
export function hasActiveShareCapture(conversationId: string, platform = 'chatgpt'): boolean {
  return [...jobs.values()].some((job) => platformOf(job) === platform && job.status.conversationId === conversationId && !terminal(job.status))
}
let initialization: Promise<void> | null = null
const terminal = (status: ShareCaptureStatus): boolean => ['complete', 'failed', 'cancelled'].includes(status.phase)

/** Ask this exact content-script document for its current SPA route. The
 * sender URL can describe the document's initial route after client navigation. */
async function currentSourceId(sender: chrome.runtime.MessageSender, platform = 'chatgpt'): Promise<string | null> {
  if (sender.tab?.id === undefined || sender.frameId !== 0) return null
  try {
    if (new URL(sender.url ?? '').origin !== (platform === 'gemini' ? 'https://gemini.google.com' : 'https://chatgpt.com')) return null
    const response: unknown = await chrome.tabs.sendMessage(sender.tab.id,
      { type: SHARE_SOURCE_CONTEXT_REQUEST },
      sender.documentId ? { documentId: sender.documentId } : { frameId: 0 })
    if (typeof response !== 'object' || response === null) return null
    const context = response as { platform?: unknown; conversationId?: unknown; url?: unknown; contentScriptBuildId?: unknown }
    const id = typeof context.url === 'string' ? sourceIdFor(context.url, platform) : null
    return context.platform === platform && context.contentScriptBuildId === EXTENSION_BUILD_ID && context.conversationId === id ? id : null
  } catch { return null }
}

async function geminiSourceContext(sender: chrome.runtime.MessageSender): Promise<NonNullable<Job['sourceContext']>> {
  if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.documentId || !sender.url?.startsWith('https://gemini.google.com/')) throw new Error('Gemini 原对话文档无效')
  const [context, state] = await Promise.all([
    chrome.tabs.sendMessage(sender.tab.id, { type: SHARE_SOURCE_CONTEXT_REQUEST, includeCapture: true }, { documentId: sender.documentId }) as Promise<{ capture?: ExtractedConversation; contentScriptBuildId?: string }>,
    chrome.tabs.sendMessage(sender.tab.id, { type: NETWORK_PAGE_PROBE }, { documentId: sender.documentId }) as Promise<NetworkPageProbe>,
  ])
  const capture = context?.capture
  if (context?.contentScriptBuildId !== EXTENSION_BUILD_ID || !capture || capture.platform !== 'gemini' || !validMessages(capture.messages) || capture.messages.length % 2 !== 0 || capture.messages.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user')) || !capture.accountIdentifier || capture.conversationId !== getGeminiSourceId(capture.url) || state?.platform !== 'gemini' || state.contentScriptBuildId !== EXTENSION_BUILD_ID || state.conversationId !== capture.conversationId || !state.documentToken || !Number.isSafeInteger(state.branchRevision) || !state.accountContext || state.accountContext !== getGeminiAccountContext(capture.url) || state.accountContext !== getGeminiAccountContext(state.url) || state.blockers.some((blocker) => ['editing', 'generating'].includes(blocker)) || JSON.stringify(capture).length > 12_000_000) throw new Error('Gemini 原页、账号或回答状态无法核对，请等待页面稳定后重试')
  return { capture: portableGeminiDomCapture(capture), accountId: await createAccountId('gemini', capture.accountIdentifier), token: state.documentToken, revision: state.branchRevision, accountContext: state.accountContext }
}

async function chatgptSourceAccount(sender: chrome.runtime.MessageSender): Promise<string | null> {
  if (sender.tab?.id === undefined) return null
  const context = await chrome.tabs.sendMessage(sender.tab.id, { type: SHARE_SOURCE_CONTEXT_REQUEST },
    sender.documentId ? { documentId: sender.documentId } : { frameId: 0 }) as { platform?: string; accountIdentifier?: string | null; contentScriptBuildId?: string } | null
  if (context?.platform !== 'chatgpt' || context.contentScriptBuildId !== EXTENSION_BUILD_ID || context.accountIdentifier !== undefined && context.accountIdentifier !== null && typeof context.accountIdentifier !== 'string') return null
  return createAccountId('chatgpt', context.accountIdentifier ?? null)
}

async function notifyCapturePage(job: Job): Promise<void> {
  if (job.status.captureTabId !== null && job.documentId) {
    await chrome.tabs.sendMessage(job.status.captureTabId,
      { type: SHARE_TASK_STATUS_EVENT, status: job.status }, { documentId: job.documentId }).catch(() => undefined)
  }
}

async function closeCaptureTab(job: Job): Promise<void> {
  const id = job.status.captureTabId
  job.status.captureTabId = null
  if (id !== null) {
    const verified = job.ownsTab || await chrome.tabs.sendMessage(id, { type: 'AI_CHAT_MEMORY_VERIFY_SHARE_TASK', jobId: job.status.id }).then((response: unknown) => typeof response === 'object' && response !== null && (response as { jobId?: unknown }).jobId === job.status.id).catch(() => false)
    if (verified) await chrome.tabs.remove(id).catch(() => undefined)
  }
}

async function finishJob(job: Job, phase: 'failed' | 'cancelled' | 'complete', message: string): Promise<void> {
  job.status.phase = phase
  job.status.message = message
  job.status.updatedAt = Date.now()
  // Persist before closing: tab-removal events cannot replace a finished result.
  await putShareCaptureJob(job.status)
  await notifyCapturePage(job)
  await closeCaptureTab(job)
  delete job.capture
  delete job.sourceMessages
  delete job.sourceContext
  delete job.url
  await putShareCaptureJob(job.status)
  const finished = [...jobs.values()].filter((candidate) => terminal(candidate.status)).sort((left, right) => right.status.updatedAt - left.status.updatedAt)
  for (const expired of finished.slice(64)) {
    jobs.delete(expired.status.originTabId)
    await deleteShareCaptureJob(expired.status.originTabId)
  }
}

export function initializeShareCaptureJobs(): Promise<void> {
  initialization ??= (async () => {
    for (const status of await readShareCaptureJobs()) {
      const job: Job = { status }
      jobs.set(status.originTabId, job)
      if (!terminal(status)) {
        // Content and source anchors are intentionally never persisted. A worker
        // restart cannot authorize a stale scan or report it as saved.
        await finishJob(job, 'failed', '插件后台已重启，采集已安全停止；请重新发起分享采集')
      }
    }
  })()
  return initialization
}

function validMessages(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 10_000 && value.every(isChatMessage) && JSON.stringify(value).length <= 12_000_000
}

function validMessageOrder(capture: ExtractedConversation): boolean {
  const skipped = capture.captureSkippedSourceOrders ?? []
  if (!Array.isArray(skipped) || skipped.length > 10_000) return false
  const messageOrders = capture.messages.map((message) => message.sourceOrder)
  const all = [...messageOrders, ...skipped]
  if (!all.every((order) => Number.isSafeInteger(order) && order! >= 0 && order! <= 20_000)) return false
  if (messageOrders.some((order, index) => index > 0 && order! <= messageOrders[index - 1]!)) return false
  if (skipped.some((order) => messageOrders.includes(order))) return false
  const orders = [...new Set(all)].sort((left, right) => left! - right!)
  return orders.every((order, index) => index === 0 ? order === 0 || order === 1 : order === orders[index - 1]! + 1)
}

export async function handleShareCapture(request: Request, sender: chrome.runtime.MessageSender): Promise<ShareCaptureResponse> {
  await initializeShareCaptureJobs()
  const platform = request.platform ?? 'chatgpt'
  if (!['chatgpt', 'gemini'].includes(platform)) throw new Error('不支持的分享采集平台')
  const tabId = sender.tab?.id
  if (tabId === undefined || sender.frameId !== 0 && sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('panel.html')) throw new Error('分享采集仅允许原对话面板或采集页操作')
  const isPanel = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('panel.html')
  if (request.action === 'start') {
    const url = platform === 'gemini' ? await resolveGeminiShareUrl(request.shareUrl) : normalizeChatGPTShareUrl(request.shareUrl)
    if (!url) throw new Error('分享链接格式无效，请粘贴 https://chatgpt.com/share/ 开头的完整链接')
    const sourceId = await currentSourceId(sender, platform)
    if (!sourceId || sourceId !== request.conversationId) throw new Error('原对话身份核对失败，请刷新原对话后重新启动采集')
    if (!validMessages(request.sourceMessages)) throw new Error('原对话没有有效的核对消息，或内容超出采集容量，请等待提问和回答显示后重试')
    const sourceContext = platform === 'gemini' ? await geminiSourceContext(sender) : undefined
    const accountId = sourceContext?.accountId ?? await chatgptSourceAccount(sender)
    if (accountId === null) throw new Error('原对话账号无法核对，请刷新后重试')
    if (sourceContext && sourceContext.capture.conversationId !== sourceId) throw new Error('Gemini 原对话已切换')
    // The explicit start action authorizes this task. The Manager setting is
    // only a default; a conversation panel may independently select sharing.
    const previous = jobs.get(tabId)
    if (previous && !terminal(previous.status)) throw new Error('当前对话已有分享采集任务，请先取消或等待结束')
    const active = [...jobs.values()].filter((job) => !terminal(job.status))
    if (active.length >= 3) throw new Error('请等待其他分享采集结束后重试')
    const job: Job = {
      status: { platform, id: crypto.randomUUID(), originTabId: tabId, captureTabId: null, conversationId: sourceId, phase: 'loading', messageCount: 0, progress: 3, message: '正在打开分享采集页…', updatedAt: Date.now() },
      url, accountId, sourceMessages: sourceContext?.capture.messages ?? request.sourceMessages, sourceContext, originDocumentId: sender.documentId, lastHeartbeatAt: Date.now(),
    }
    jobs.set(tabId, job)
    try {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
      if (tab.id === undefined) throw new Error('无法创建采集页')
      job.status.captureTabId = tab.id
      job.ownsTab = true
      await putShareCaptureJob(job.status)
      await chrome.tabs.update(tab.id, { url })
    } catch {
      await finishJob(job, 'failed', '无法打开分享采集页，请检查链接后重试')
    }
    return { status: job.status }
  }

  const captureJob = [...jobs.values()].find((job) => job.status.captureTabId === tabId)
  if (['claim', 'progress', 'finish', 'return'].includes(request.action) || request.action === 'status' && captureJob) {
    const job = captureJob
    if (!job || platformOf(job) !== platform || terminal(job.status) || normalizeShare(sender.url, platform) !== job.url) throw new Error('这不是插件授权的分享采集页')
    if (request.action === 'claim') {
      if (job.documentId && job.documentId !== sender.documentId) {
        await finishJob(job, 'failed', '采集页已刷新，请从原对话重新发起采集')
        throw new Error('采集页已刷新，请从原对话重试')
      }
      job.documentId = sender.documentId
      return { status: job.status }
    }
    if (request.jobId !== job.status.id || job.documentId !== sender.documentId) throw new Error('采集任务已失效')
    if (request.action === 'return') {
      await chrome.tabs.update(job.status.originTabId, { active: true })
      return { status: job.status }
    }
    if (request.action === 'status') return { status: job.status }
    if (request.action === 'progress') {
      if (job.status.phase === 'ready') return { status: job.status }
      if (!Number.isInteger(request.messageCount) || request.messageCount! < 0 || request.messageCount! > 10_000 || !['scanning', 'needs-foreground'].includes(request.phase ?? '')) throw new Error('无效的采集进度')
      if (request.progress !== undefined && (!Number.isInteger(request.progress) || request.progress < 0 || request.progress > 85)) throw new Error('无效的采集进度')
      job.status.phase = request.phase!
      job.status.messageCount = Math.max(job.status.messageCount, request.messageCount!)
      job.status.progress = Math.max(job.status.progress ?? 3, request.progress ?? 3)
      job.status.message = request.phase === 'needs-foreground' ? '任务和已读进度已保留。请打开分享采集页并保持该页可见，完成后返回原对话' : `已读取 ${job.status.messageCount} 条消息，正在核对完整历史…`
      job.status.updatedAt = Date.now()
      job.lastHeartbeatAt = Date.now()
      await putShareCaptureJob(job.status)
      return { status: job.status }
    }
    const capture = request.capture
    if (request.error || !capture || capture.platform !== platform || normalizeShare(capture.url, platform) !== job.url || capture.conversationId !== job.url?.split('/').at(-1) || capture.captureComplete !== true || !validMessages(capture.messages) || !validMessageOrder(capture) || capture.messages[0]?.role !== 'user' || (capture.attachmentCandidates?.length ?? 0) > 100 || JSON.stringify(capture).length > 12_000_000 || platform === 'gemini' && (capture.messages.length % 2 !== 0 || capture.messages.some((message, index) => message.sourceOrder !== index || message.role !== (index % 2 ? 'assistant' : 'user')))) {
      await finishJob(job, 'failed', request.error ? request.error.slice(0, 400) : '分享页未通过完整性核对，未保存；请打开采集页重试或更新分享链接')
    } else {
      const saved = await getSavedConversationBySource(platform, job.status.conversationId, job.accountId)
      if (platform === 'gemini' ? !hasGeminiDomHead(job.sourceMessages ?? [], capture.messages) : !findShareAnchor(job.sourceMessages ?? [], capture.messages) && !findShareAnchor(saved?.messages ?? [], capture.messages)) {
        await finishJob(job, 'failed', '分享内容与原对话无法核对，请确认链接属于这条完整对话并更新分享快照')
      } else {
        job.capture = capture
        job.status.phase = 'ready'
        job.status.progress = 95
        job.status.messageCount = capture.messages.length
        job.status.message = '完整历史已核对，正在保存到原对话…'
        job.status.updatedAt = Date.now()
        await putShareCaptureJob(job.status)
        await notifyCapturePage(job)
      }
    }
    return { status: job.status }
  }

  const job = jobs.get(tabId)
  if (!job || platformOf(job) !== platform || job.status.conversationId !== request.conversationId) return { status: null }
  if (!isPanel && await currentSourceId(sender, platform) !== job.status.conversationId) throw new Error('原对话已切换，无法操作采集任务')
  if (!isPanel && job.originDocumentId && sender.documentId !== job.originDocumentId) throw new Error('原对话已刷新，请重新发起采集')
  if (request.action === 'status') {
    if (!terminal(job.status) && job.status.phase !== 'ready' && Date.now() - (job.lastHeartbeatAt ?? job.status.updatedAt) > 20_000 && job.status.phase !== 'needs-foreground') {
      job.status.phase = 'needs-foreground'
      job.status.message = '暂未收到采集页响应。请打开分享采集页并保持该页可见，完成后返回原对话；若链接不可用，请取消后重试'
      await putShareCaptureJob(job.status)
    }
    return { status: job.status, ...(!isPanel && job.capture ? { capture: job.capture } : {}) }
  }
  if (request.jobId !== job.status.id) throw new Error('采集任务已失效')
  if (request.action === 'cancel' && !terminal(job.status)) await finishJob(job, 'cancelled', '分享采集已取消')
  else if (request.action === 'open' && !terminal(job.status) && job.status.captureTabId !== null) await chrome.tabs.update(job.status.captureTabId, { active: true })
  else if (request.action === 'release' && !isPanel && job.status.phase === 'ready') await finishJob(job, request.error ? 'failed' : 'complete', request.error ? `保存失败：${request.error.slice(0, 350)}` : '分享补全已保存到原对话')
  else if (!['cancel', 'open', 'release'].includes(request.action)) throw new Error('未知的采集操作')
  return { status: job.status }
}

export async function handleShareTabRemoved(tabId: number): Promise<void> {
  await initializeShareCaptureJobs()
  for (const job of jobs.values()) {
    if (!terminal(job.status) && (job.status.originTabId === tabId || job.status.captureTabId === tabId)) await finishJob(job, 'cancelled', '原对话或采集页已关闭，未确认保存')
    if (job.status.originTabId === tabId) {
      jobs.delete(tabId)
      await deleteShareCaptureJob(tabId)
    }
  }
}

export async function handleShareTabNavigated(tabId: number, url: string): Promise<void> {
  await initializeShareCaptureJobs()
  for (const job of jobs.values()) {
    if (terminal(job.status)) continue
    if (job.status.captureTabId === tabId) {
      // Creating the owned tab deliberately uses about:blank before its URL
      // is assigned. Its queued first update must not cancel the new job.
      if (url === 'about:blank' && !job.captureNavigated && !job.documentId) continue
      if (normalizeShare(url, platformOf(job)) === job.url) job.captureNavigated = true
    }
    if (job.status.originTabId === tabId && (sourceIdFor(url, platformOf(job)) !== job.status.conversationId || job.sourceContext && getGeminiAccountContext(url) !== job.sourceContext.accountContext) || job.status.captureTabId === tabId && normalizeShare(url, platformOf(job)) !== job.url) await finishJob(job, 'cancelled', '页面已离开原对话或分享链接，采集已停止')
  }
}

export async function isShareSaveAuthorized(sender: chrome.runtime.MessageSender, conversationId: string, platform = 'chatgpt', accountId?: string): Promise<boolean> {
  const job = sender.tab?.id === undefined ? undefined : jobs.get(sender.tab.id)
  if (!job || platformOf(job) !== platform || job.status.phase !== 'ready' || job.status.conversationId !== conversationId || job.originDocumentId && sender.documentId !== job.originDocumentId) return false
  const id = await currentSourceId(sender, platform)
  if (platform === 'chatgpt' && (accountId !== job.accountId || await chatgptSourceAccount(sender).catch(() => null) !== job.accountId)) return false
  if (platform === 'gemini') {
    const current = await geminiSourceContext(sender).catch(() => null), initial = job.sourceContext
    if (!current || !initial || accountId !== initial.accountId || current.accountId !== initial.accountId || current.token !== initial.token || current.revision !== initial.revision || current.accountContext !== initial.accountContext || !hasGeminiDomHead(current.capture.messages.slice(-2), initial.capture.messages.slice(-2)) || !job.capture || !hasGeminiDomHead(current.capture.messages, job.capture.messages)) return false
  }
  return job.status.phase === 'ready' && id === conversationId
}

export async function prepareShareSavePayload(sender: chrome.runtime.MessageSender, payload: ConversationSavePayload): Promise<ConversationSavePayload> {
  if (payload.platform !== 'gemini') return payload
  if (!await isShareSaveAuthorized(sender, payload.conversationId, payload.platform, payload.accountId)) throw new Error('Gemini 分享采集文档、分支或账号授权已失效')
  const job = jobs.get(sender.tab!.id!)!
  const source = job.sourceContext!.capture, shared = alignGeminiDomShare(source, portableGeminiDomCapture(job.capture!))
  const expected = mergeGeminiDomShare(source, shared)
  if (payload.messages.length !== expected.messages.length || payload.messages.some((message, index) => message.role !== expected.messages[index].role || message.content !== expected.messages[index].content)) throw new Error('Gemini 分享保存正文不属于本轮已核对的 DOM')
  const existing = await getSavedConversationBySource('gemini', payload.conversationId, payload.accountId)
  const retained = retainGeminiDomShareText(payload, existing?.messages ?? [], [source, shared])
  const scanned = findShareAnchor(expected.messages, shared.messages)
  const scannedIds = scanned && scanned.length === shared.messages.length ? retained.messages.slice(scanned.source, scanned.source + scanned.length).flatMap((message) => message.sourceMessageId ? [message.sourceMessageId] : []) : []
  return { ...retained, url: source.url, title: source.title, accountLabel: source.accountLabel, accountSource: source.accountIdentifier ? 'detected' : 'unknown', supplementVerifiedMessageIds: scannedIds, contentHash: await createContentHash(source.title, retained.messages, retained.attachments) }
}

export async function cancelShareCaptureJobs(conversationId?: string, platform?: string): Promise<void> {
  await initializeShareCaptureJobs()
  for (const job of jobs.values()) {
    if ((!conversationId || job.status.conversationId === conversationId) && (!platform || platformOf(job) === platform)) {
      if (!terminal(job.status)) await finishJob(job, 'cancelled', '本地对话已删除，分享采集已停止')
      jobs.delete(job.status.originTabId)
      await deleteShareCaptureJob(job.status.originTabId)
    }
  }
}
