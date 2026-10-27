import { deleteShareCaptureJob, putShareCaptureJob, readShareCaptureJobs } from '../db/share-capture-jobs'
import { getSavedConversationBySource } from '../services/conversation-service'
import { isChatMessage } from '../services/validation'
import type { ChatMessage, ExtractedConversation } from '../shared/models'
import type { RuntimeRequest } from '../shared/runtime-messages'
import { findShareAnchor, getChatGPTSourceId, normalizeChatGPTShareUrl, SHARE_SOURCE_CONTEXT_REQUEST, SHARE_TASK_STATUS_EVENT, type ShareCaptureResponse, type ShareCaptureStatus } from '../shared/share-capture'
import { EXTENSION_BUILD_ID } from '../shared/build-id'

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
}
const jobs = new Map<number, Job>()
export function hasActiveShareCapture(conversationId: string): boolean {
  return [...jobs.values()].some((job) => job.status.conversationId === conversationId && !terminal(job.status))
}
let initialization: Promise<void> | null = null
const terminal = (status: ShareCaptureStatus): boolean => ['complete', 'failed', 'cancelled'].includes(status.phase)

/** Ask this exact content-script document for its current SPA route. The
 * sender URL can describe the document's initial route after client navigation. */
async function currentSourceId(sender: chrome.runtime.MessageSender): Promise<string | null> {
  if (sender.tab?.id === undefined || sender.frameId !== 0) return null
  try {
    if (new URL(sender.url ?? '').origin !== 'https://chatgpt.com') return null
    const response: unknown = await chrome.tabs.sendMessage(sender.tab.id,
      { type: SHARE_SOURCE_CONTEXT_REQUEST },
      sender.documentId ? { documentId: sender.documentId } : { frameId: 0 })
    if (typeof response !== 'object' || response === null) return null
    const context = response as { platform?: unknown; conversationId?: unknown; url?: unknown; contentScriptBuildId?: unknown }
    const id = typeof context.url === 'string' ? getChatGPTSourceId(context.url) : null
    return context.platform === 'chatgpt' && context.contentScriptBuildId === EXTENSION_BUILD_ID && context.conversationId === id ? id : null
  } catch { return null }
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
  const tabId = sender.tab?.id
  if (tabId === undefined || sender.frameId !== 0 && sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('panel.html')) throw new Error('分享采集仅允许原对话面板或采集页操作')
  const isPanel = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('panel.html')
  if (request.action === 'start') {
    const url = normalizeChatGPTShareUrl(request.shareUrl)
    if (!url) throw new Error('分享链接格式无效，请粘贴 https://chatgpt.com/share/ 开头的完整链接')
    const sourceId = await currentSourceId(sender)
    if (!sourceId || sourceId !== request.conversationId) throw new Error('原对话身份核对失败，请刷新原对话后重新启动采集')
    if (!validMessages(request.sourceMessages)) throw new Error('原对话没有有效的核对消息，或内容超出采集容量，请等待提问和回答显示后重试')
    // The explicit start action authorizes this task. The Manager setting is
    // only a default; a conversation panel may independently select sharing.
    const previous = jobs.get(tabId)
    if (previous && !terminal(previous.status)) throw new Error('当前对话已有分享采集任务，请先取消或等待结束')
    const active = [...jobs.values()].filter((job) => !terminal(job.status))
    if (active.length >= 3) throw new Error('请等待其他分享采集结束后重试')
    const job: Job = {
      status: { id: crypto.randomUUID(), originTabId: tabId, captureTabId: null, conversationId: sourceId, phase: 'loading', messageCount: 0, progress: 3, message: '正在打开分享采集页…', updatedAt: Date.now() },
      url, sourceMessages: request.sourceMessages, originDocumentId: sender.documentId, lastHeartbeatAt: Date.now(),
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
    if (!job || terminal(job.status) || normalizeChatGPTShareUrl(sender.url) !== job.url) throw new Error('这不是插件授权的分享采集页')
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
    if (request.error || !capture || capture.platform !== 'chatgpt' || normalizeChatGPTShareUrl(capture.url) !== job.url || capture.conversationId !== job.url?.split('/').at(-1) || capture.captureComplete !== true || !validMessages(capture.messages) || !validMessageOrder(capture) || capture.messages[0]?.role !== 'user' || (capture.attachmentCandidates?.length ?? 0) > 100) {
      await finishJob(job, 'failed', request.error ? request.error.slice(0, 400) : '分享页未通过完整性核对，未保存；请打开采集页重试或更新分享链接')
    } else {
      const saved = await getSavedConversationBySource('chatgpt', job.status.conversationId)
      if (!findShareAnchor(job.sourceMessages ?? [], capture.messages) && !findShareAnchor(saved?.messages ?? [], capture.messages)) {
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
  if (!job || job.status.conversationId !== request.conversationId) return { status: null }
  if (!isPanel && await currentSourceId(sender) !== job.status.conversationId) throw new Error('原对话已切换，无法操作采集任务')
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
      if (normalizeChatGPTShareUrl(url) === job.url) job.captureNavigated = true
    }
    if (job.status.originTabId === tabId && getChatGPTSourceId(url) !== job.status.conversationId || job.status.captureTabId === tabId && normalizeChatGPTShareUrl(url) !== job.url) await finishJob(job, 'cancelled', '页面已离开原对话或分享链接，采集已停止')
  }
}

export async function isShareSaveAuthorized(sender: chrome.runtime.MessageSender, conversationId: string): Promise<boolean> {
  const job = sender.tab?.id === undefined ? undefined : jobs.get(sender.tab.id)
  if (!job || job.status.phase !== 'ready' || job.status.conversationId !== conversationId || job.originDocumentId && sender.documentId !== job.originDocumentId) return false
  const id = await currentSourceId(sender)
  return job.status.phase === 'ready' && id === conversationId
}

export async function cancelShareCaptureJobs(conversationId?: string): Promise<void> {
  await initializeShareCaptureJobs()
  for (const job of jobs.values()) {
    if (!conversationId || job.status.conversationId === conversationId) {
      if (!terminal(job.status)) await finishJob(job, 'cancelled', '本地对话已删除，分享采集已停止')
      jobs.delete(job.status.originTabId)
      await deleteShareCaptureJob(job.status.originTabId)
    }
  }
}
