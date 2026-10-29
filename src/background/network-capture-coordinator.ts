import { inspectChatGPTResponseShape } from '../adapters/chatgpt/network-response'
import { ChatGPTNetworkEvidence } from '../adapters/chatgpt/network-evidence'
import { GeminiNetworkEvidence } from '../adapters/gemini/network-evidence'
import { getGeminiSourceId, getGeminiSourceUrl, getGeminiAccountContext, normalizeGeminiShareUrl, resolveGeminiShareUrl } from '../adapters/gemini/capture-urls'
import { getSettings } from '../db/settings'
import { getSavedConversationBySource, savePendingNetworkConversation, saveVerifiedNetworkConversation, supplementVerifiedNetworkAttachments, updateConversationFileAttachmentPermission, updateConversationImageAttachmentPermission } from '../services/conversation-service'
import { isChatMessage, hasValidConversationAttachments } from '../services/validation'
import type { Conversation, ConversationSavePayload, ExtractedConversation, PendingCapture } from '../shared/models'
import { findShareAnchor } from '../shared/share-capture'
import { createContentHash, createAccountId } from '../utils/hash'
import { getCaptureReadiness } from './runtime-readiness'
import { deleteNetworkCaptureJob, putNetworkCaptureJob, readNetworkCaptureJobs } from '../db/network-capture-jobs'
import { EXTENSION_BUILD_ID } from '../shared/build-id'
import {
  isNetworkCaptureActive, NETWORK_PAGE_CONTEXT, NETWORK_PAGE_PROBE, NETWORK_PAGE_REFRESH, NETWORK_TASK_CHANGED, NETWORK_VERIFY_TASK,
  type CaptureBlocker, type NetworkCaptureRequest, type NetworkCaptureResponse, type NetworkCaptureStatus, type NetworkPageProbe,
} from '../shared/network-capture'
import { getChatGPTSourceId, normalizeChatGPTShareUrl } from '../shared/share-capture'
import { detachInterruptedNetworkSession, NetworkDebugSession } from './network-debug-session'
import { hasActiveShareCapture } from './share-capture-coordinator'

interface Job {
  status: NetworkCaptureStatus
  sourceToken: string
  sourceDocumentId?: string
  captureToken?: string
  captureDocumentId?: string
  branchRevision: number
  branchId?: string
  url: string
  ownsTab: boolean
  navigationCount: number
  allowedNavigation: boolean
  rebound: boolean
  session?: NetworkDebugSession
  finishing?: Promise<void>
  launch?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  evidence?: ChatGPTNetworkEvidence | GeminiNetworkEvidence
  accountContext?: string
  accountId?: string
  source?: ExtractedConversation
  sourceRendered?: boolean
  saved?: Conversation
  attachmentPlan?: NetworkCaptureResponse['attachmentPlan']
  allowFiles?: boolean
  saveImages?: boolean
  review?: { payload: ConversationSavePayload; issue: PendingCapture }
  preparingReview?: Promise<void>
}
const jobs = new Map<number, Job>()
let initialization: Promise<void> | null = null

const jobPlatform = (job: Job): 'chatgpt' | 'gemini' => job.status.platform ?? 'chatgpt'
const getSourceId = (url: string, platform: string): string | null => platform === 'gemini' ? getGeminiSourceId(url) : getChatGPTSourceId(url)
const shareUrl = (url: unknown, platform: string): string | null => platform === 'gemini' ? normalizeGeminiShareUrl(url) : normalizeChatGPTShareUrl(url)

function activeJob(conversationId: string, platform = 'chatgpt'): Job | undefined {
  return [...jobs.values()].find((job) => jobPlatform(job) === platform && job.status.conversationId === conversationId && isNetworkCaptureActive(job.status))
}

/** The lock is conservative across local accounts with the same source ID.
 * Persistence separately rechecks the originating rendered account. */
export function isNetworkSavePaused(platform: string, conversationId: string): boolean {
  return !!activeJob(conversationId, platform)
}

async function notify(job: Job): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [])
  await Promise.allSettled(tabs.flatMap((tab) => tab.id === undefined ? [] : [chrome.tabs.sendMessage(tab.id, { type: NETWORK_TASK_CHANGED, status: job.status })]))
  await chrome.runtime.sendMessage({ type: NETWORK_TASK_CHANGED, status: job.status }).catch(() => undefined)
}

async function persist(job: Job): Promise<void> {
  job.status.updatedAt = Date.now()
  await putNetworkCaptureJob({ ...job.status })
}

async function probe(tabId: number, jobId?: string, documentToken?: string, documentId?: string): Promise<NetworkPageProbe> {
  const value: unknown = await chrome.tabs.sendMessage(tabId, { type: NETWORK_PAGE_PROBE, jobId, documentToken }, documentId ? { documentId } : { frameId: 0 })
  if (typeof value !== 'object' || value === null) throw new Error('无法核对原对话页面，请刷新后重试')
  const state = value as NetworkPageProbe
  if (state.contentScriptBuildId !== EXTENSION_BUILD_ID || !state.documentToken || typeof state.url !== 'string' || getSourceId(state.url, state.platform ?? 'chatgpt') !== state.conversationId || !state.conversationId || !Array.isArray(state.blockers) || !Number.isSafeInteger(state.branchRevision) || state.platform === 'gemini' && (!state.accountContext || state.accountContext !== getGeminiAccountContext(state.url))) throw new Error('原对话页面版本或身份不一致，请刷新后重试')
  if (documentToken && documentToken !== state.documentToken) throw new Error('原对话已刷新，本次任务已停止')
  return state
}

function validSource(job: Job, state: NetworkPageProbe): boolean {
  return (state.platform ?? 'chatgpt') === jobPlatform(job) && state.accountContext === job.accountContext && state.conversationId === job.status.conversationId && state.documentToken === job.sourceToken && state.branchRevision === job.branchRevision
}

async function verifyOwnership(tabId: number, jobId: string): Promise<boolean> {
  const value: unknown = await chrome.tabs.sendMessage(tabId, { type: NETWORK_VERIFY_TASK, jobId }, { frameId: 0 }).catch(() => null)
  return typeof value === 'object' && value !== null && (value as { jobId?: unknown }).jobId === jobId
}

async function finish(job: Job, phase: 'verified' | 'complete' | 'partial' | 'failed' | 'cancelled', message: string): Promise<void> {
  if (job.finishing) return job.finishing
  if (!isNetworkCaptureActive(job.status)) return
  job.status.phase = 'stopping'
  if (job.timer) clearTimeout(job.timer)
  job.finishing = (async () => {
    try {
      // If cancellation raced attach/create, wait for those ownership results
      // before cleanup. launch never waits for finish, so this cannot deadlock.
      await job.launch?.catch(() => undefined)
      await job.session?.disconnect()
      if (job.ownsTab && job.status.captureTabId !== null && job.status.captureTabId !== job.status.originTabId) {
        await chrome.tabs.remove(job.status.captureTabId).catch(() => undefined)
      }
    } finally {
      job.status.captureTabId = null
      job.status.phase = phase
      job.status.message = job.status.bodySaved && !['complete', 'partial'].includes(phase) ? `${message.replace(/本次未保存对话[，；]?/g, '')}；已保存的正文和既有附件已保留` : message
      job.branchId = undefined
      job.url = ''
      job.session = undefined
      job.launch = undefined
      job.sourceToken = ''
      job.sourceDocumentId = undefined
      job.captureToken = undefined
      job.captureDocumentId = undefined
      job.evidence?.clear()
      job.evidence = undefined
      job.source = undefined
      job.saved = undefined
      job.attachmentPlan = undefined
      job.review = undefined
      // Releasing the in-memory lock does not depend on a successful IDB write.
      await persist(job).catch(() => undefined)
      await notify(job)
      const old = [...jobs.values()].filter((candidate) => !isNetworkCaptureActive(candidate.status)).sort((a, b) => b.status.updatedAt - a.status.updatedAt).slice(64)
      for (const candidate of old) {
        jobs.delete(candidate.status.originTabId)
        await deleteNetworkCaptureJob(candidate.status.originTabId).catch(() => undefined)
      }
    }
  })()
  return job.finishing
}

async function reviewAuthorized(job: Job): Promise<boolean> {
  if (job.finishing || job.status.phase !== 'awaiting-confirmation' || !(await getCaptureReadiness(EXTENSION_BUILD_ID)).ready) return false
  const current = await probe(job.status.originTabId, undefined, job.sourceToken, job.sourceDocumentId).catch(() => null)
  if (!current || !validSource(job, current) || current.blockers.some((blocker) => ['generating', 'editing'].includes(blocker))) return false
  const source = await readContext(job.status.originTabId, job.sourceToken, job.sourceDocumentId).catch(() => null)
  return !!source && source.platform === jobPlatform(job) && await createAccountId(source.platform, source.accountIdentifier) === job.accountId && !job.finishing
}

/** Only normalized text stays in memory while the owner decides. Identity and
 * branch failures still cancel; confirmation never bypasses those checks. */
async function failOrReview(job: Job, message: string, capture?: ExtractedConversation): Promise<void> {
  if (job.finishing) return job.finishing
  if (jobPlatform(job) === 'gemini') return finish(job, 'failed', message)
  if (job.preparingReview) return job.preparingReview
  if (job.status.phase === 'awaiting-confirmation') return
  if (job.status.operation !== 'save' || job.status.bodySaved || !job.rebound) return finish(job, 'failed', message)
  job.status.phase = 'awaiting-confirmation'
  if (job.timer) clearTimeout(job.timer)
  job.status.message = '采集遇到异常，正在整理可确认的内容…'
  job.preparingReview = (async () => {
    await job.launch?.catch(() => undefined)
    await job.session?.disconnect()
    if (!await reviewAuthorized(job)) throw new Error('原对话身份或分支已变化')
    const source = await readContext(job.status.originTabId, job.sourceToken, job.sourceDocumentId)
    if (!source || source.conversationId !== job.status.conversationId) throw new Error('原对话无法核对')
    const rendered = capture ?? (job.status.mode === 'share' && job.status.captureTabId !== null && job.captureToken
      ? await readContext(job.status.captureTabId, job.captureToken, job.captureDocumentId) : source)
    if (!rendered || rendered.platform !== 'chatgpt' || !Array.isArray(rendered.messages) || !rendered.messages.every(isChatMessage) || rendered.messages.length > 10_000 || JSON.stringify(rendered.messages).length > 12_000_000 || (job.status.mode === 'share'
      ? normalizeChatGPTShareUrl(rendered.url) !== job.url
      : getChatGPTSourceId(rendered.url) !== job.status.conversationId || rendered.conversationId !== job.status.conversationId)) throw new Error('候选内容身份无法核对')
    let messages: ExtractedConversation['messages'] | null = null
    try { messages = job.evidence?.reviewCandidate(rendered.messages) ?? null } catch { /* An incomplete chain can use only rendered page text. */ }
    const candidateSource = messages ? 'network' : 'page'
    messages ??= rendered.messages.map((entry) => ({ ...entry }))
    const firstUser = messages.findIndex((entry) => entry.role === 'user')
    if (firstUser < 0) throw new Error('没有可保存的用户消息')
    messages = messages.slice(firstUser)
    const existing = await getSavedConversationBySource('chatgpt', job.status.conversationId, job.accountId)
    if (job.status.mode === 'share' && ![source.messages, job.source?.messages ?? [], existing?.messages ?? []].some((entries) => findShareAnchor(entries, messages!, candidateSource === 'network'))) throw new Error('分享内容缺少原对话唯一锚点')
    if (!await reviewAuthorized(job)) throw new Error('确认保存授权已撤销')
    messages = messages.map((entry) => {
      const clean = { ...entry }
      delete clean.contentSource
      delete clean.networkWidgetSource
      if (candidateSource === 'network') { delete clean.sentAt; delete clean.sentAtPrecision }
      return clean
    })
    const issue = { reason: message.slice(0, 300), source: candidateSource } as const
    job.review = { issue, payload: {
      platform: 'chatgpt', accountId: job.accountId ?? 'unknown', accountLabel: source.accountLabel, accountSource: source.accountIdentifier ? 'detected' : 'unknown',
      conversationId: job.status.conversationId, url: `https://chatgpt.com/c/${job.status.conversationId}`, title: source.title,
      messages, pinned: existing?.pinned ?? false, contentHash: await createContentHash(source.title, messages),
    } }
    const ownedTab = job.ownsTab ? job.status.captureTabId : null
    job.status.captureTabId = null
    job.ownsTab = false
    if (ownedTab !== null) await chrome.tabs.remove(ownedTab).catch(() => undefined)
    job.evidence?.clear(); job.evidence = undefined; job.session = undefined
    job.status.candidateCount = messages.length
    job.status.candidateSource = candidateSource
    job.status.issue = issue.reason
    job.status.message = `已取得 ${messages.length} 条${candidateSource === 'network' ? '接口' : '网页'}消息，尚未保存。可确认保存为待补全，或取消本次结果。`
    if (job.finishing) { job.review = undefined; return }
    await persist(job); await notify(job)
  })().catch(async () => { await finish(job, 'failed', `${message}；没有可安全确认的候选内容，本次未保存`) })
  return job.preparingReview
}

export function initializeNetworkCaptureJobs(): Promise<void> {
  initialization ??= (async () => {
    for (const status of await readNetworkCaptureJobs()) {
      const job: Job = { status, sourceToken: '', branchRevision: 0, url: '', ownsTab: false, navigationCount: 0, allowedNavigation: false, rebound: false }
      jobs.set(status.originTabId, job)
      if (!isNetworkCaptureActive(status)) continue
      const target = status.mode === 'share' ? status.captureTabId : status.originTabId
      if (target !== null && await verifyOwnership(target, status.id)) {
        await detachInterruptedNetworkSession(target)
        if (status.mode === 'share' && target !== status.originTabId) job.ownsTab = true
      }
      await finish(job, 'failed', '插件后台已重启，采集已停止，请重新发起')
    }
  })()
  return initialization
}

async function launch(job: Job): Promise<void> {
  try {
    if (job.finishing) return
    const { status } = job
    let tabId = status.originTabId
    if (status.mode === 'share') {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
      if (tab.id === undefined) throw new Error('无法创建接口采集页')
      tabId = tab.id
      status.captureTabId = tabId
      job.ownsTab = true
      await persist(job)
      if (job.finishing) return
    }
    job.session = new NetworkDebugSession(tabId, { platform: jobPlatform(job), mode: status.mode, id: status.mode === 'share' ? job.url.split('/').at(-1)! : status.conversationId, sourceId: status.conversationId }, {
      navigation: (url, sameDocument) => {
        if (job.finishing) return false
        const same = status.mode === 'share' ? shareUrl(url, jobPlatform(job)) === job.url : getSourceId(url, jobPlatform(job)) === status.conversationId && (jobPlatform(job) !== 'gemini' || getGeminiAccountContext(url) === job.accountContext)
        if (!same) return false
        if (sameDocument) return job.navigationCount === 1
        if (!job.allowedNavigation) return false
        job.allowedNavigation = false
        job.navigationCount += 1
        return job.navigationCount === 1
      },
      failure: (message) => { void failOrReview(job, message) },
      response: (body, endpoint, bytes, pagination) => {
        if (job.finishing || job.status.phase === 'awaiting-confirmation' || job.navigationCount !== 1) return
        try {
          const summary = jobPlatform(job) === 'gemini' ? { nodeCount: 0, branchId: null } : inspectChatGPTResponseShape(body, endpoint)
          if (summary.branchId && job.branchId && summary.branchId !== job.branchId) { void finish(job, 'cancelled', '当前分支已变化，请重新发起采集'); return }
          if (summary.branchId) job.branchId = summary.branchId
          if (job.status.operation === 'save' || jobPlatform(job) === 'gemini') {
            const target = { mode: status.mode, id: status.mode === 'share' ? job.url.split('/').at(-1)! : status.conversationId, sourceId: status.conversationId }
            job.evidence ??= jobPlatform(job) === 'gemini' ? new GeminiNetworkEvidence(target) : new ChatGPTNetworkEvidence(target)
            job.evidence.add(body, endpoint, pagination)
          }
          status.responseCount += 1
          status.responseBytes += bytes
          status.largestResponseBytes = Math.max(status.largestResponseBytes, bytes)
          status.nodeCount += summary.nodeCount
          if (!['saving', 'attachments'].includes(status.phase)) status.phase = 'reading'
          status.messageCount = job.evidence?.messageCount ?? 0
          status.message = status.operation === 'save' ? `已读取 ${status.messageCount} 条候选消息，正在滑动核对历史…` : '已读取目标响应，可继续滑动验证分页；本次不保存对话'
          void persist(job).then(() => notify(job)).catch(() => { void finish(job, 'failed', '无法记录验证状态，连接已停止') })
        } catch (error: unknown) {
          void failOrReview(job, error instanceof Error ? error.message : '响应结构验证失败，本次未保存对话')
        }
      },
    })
    await job.session.connect()
    if (job.finishing) return
    const latest = await probe(status.originTabId, status.id, job.sourceToken, job.sourceDocumentId)
    if (!validSource(job, latest)) throw new Error('原对话身份或分支已变化，请重新发起验证')
    if (status.mode === 'conversation' && latest.blockers.length) throw new Error('页面输入或回答状态已变化，未刷新；请处理后重新发起')
    status.phase = 'loading'
    status.message = status.operation === 'save'
      ? status.mode === 'conversation' ? '即将刷新页面，刷新后继续采集…' : '正在加载分享采集页…'
      : status.mode === 'conversation' ? '即将刷新页面，刷新后继续验证；本次不保存对话' : '正在加载分享验证页；本次不保存对话'
    await persist(job)
    await notify(job)
    if (job.finishing) return
    job.allowedNavigation = true
    if (status.mode === 'share') await chrome.tabs.update(tabId, { url: job.url })
    else {
      // The isolated content script checks again and reloads synchronously in
      // that same callback, leaving no async gap after its final draft check.
      const result: unknown = await chrome.tabs.sendMessage(tabId, { type: NETWORK_PAGE_REFRESH, jobId: status.id, documentToken: job.sourceToken, conversationId: status.conversationId, branchRevision: job.branchRevision }, { frameId: 0 })
      if (typeof result !== 'object' || result === null || (result as { accepted?: unknown }).accepted !== true) throw new Error('页面状态已变化，未刷新；请处理后重新发起验证')
    }
    if (!job.finishing) job.timer = setTimeout(() => {
      if (!job.rebound || status.responseCount === 0) {
        if (status.mode === 'share' && status.operation === 'save') {
          status.phase = 'needs-foreground'
          status.message = '分享页后台加载暂停，请打开分享采集页继续；任务已保留'
          void persist(job).then(() => notify(job)).catch(() => { void finish(job, 'failed', '无法记录采集状态') })
        } else void failOrReview(job, '尚未收到目标页的有效响应，采集已停止；请检查页面加载后重试')
      }
    }, 60_000)
  } catch (error: unknown) {
    // Do not await finish here: cleanup waits for launch's resource ownership.
    void finish(job, 'failed', error instanceof Error ? error.message : '接口验证启动失败，本次未保存对话')
  }
}

function result(job?: Job, blockers?: CaptureBlocker[], ownedPage = false): NetworkCaptureResponse {
  return { status: job ? { ...job.status } : null, ...(job?.saved ? { savedConversationId: job.saved.id } : {}), paused: !!job && isNetworkCaptureActive(job.status), networkComplete: job?.status.phase !== 'awaiting-confirmation' && job?.evidence?.complete === true && !job.session?.pendingCount, needsAttachmentScan: job?.evidence?.needsAttachmentScan ?? true, ...(blockers?.length ? { blockers } : {}), ...(ownedPage ? { ownedPage: true } : {}) }
}

async function readContext(tabId: number, token: string, documentId?: string): Promise<(ExtractedConversation & { nativePinned?: boolean }) | null> {
  const response: unknown = await chrome.tabs.sendMessage(tabId, { type: NETWORK_PAGE_CONTEXT, documentToken: token }, documentId ? { documentId } : { frameId: 0 })
  if (!response || typeof response !== 'object') return null
  const capture = response as ExtractedConversation & { nativePinned?: boolean }
  if (!['chatgpt', 'gemini'].includes(capture.platform) || !Array.isArray(capture.messages) || capture.messages.length > 10_000 || !capture.messages.every(isChatMessage) || JSON.stringify(capture.messages).length > 12_000_000 || typeof capture.title !== 'string' || typeof capture.accountLabel !== 'string') throw new Error('页面核对信息无效或超出容量')
  return capture
}

async function authorized(job: Job): Promise<boolean> {
  if (job.finishing || !['reading', 'saving', 'attachments'].includes(job.status.phase) || !job.rebound || job.session?.pendingCount || !job.evidence?.complete) return false
  if (!(await getCaptureReadiness(EXTENSION_BUILD_ID)).ready) return false
  const state = await probe(job.status.originTabId, undefined, job.sourceToken, job.sourceDocumentId).catch(() => null)
  if (!state || !validSource(job, state) || state.blockers.some((blocker) => ['generating', 'editing'].includes(blocker)) || job.finishing) return false
  if (job.status.operation === 'save') {
    const context = await readContext(job.status.originTabId, job.sourceToken, job.sourceDocumentId).catch(() => null)
    if (!context || context.platform !== jobPlatform(job) || await createAccountId(context.platform, context.accountIdentifier) !== job.accountId) return false
  }
  return !job.finishing
}

async function saveNetworkResult(job: Job, request: NetworkCaptureRequest): Promise<NetworkCaptureResponse> {
  const platform = jobPlatform(job)
  if (job.status.operation !== 'save' || !await authorized(job)) throw new Error('接口历史、文档或分支尚未通过独立核对')
  if (request.action === 'commit') {
    if (job.status.bodySaved) throw new Error('本轮接口正文已经提交，不能重复保存')
    const capture = request.capture
    if (!capture || capture.platform !== platform || !Array.isArray(capture.messages) || capture.messages.length > 10_000 || !capture.messages.every(isChatMessage) || JSON.stringify(capture).length > 12_500_000 || (capture.attachmentCandidates?.length ?? 0) > 100) throw new Error('页面核对消息无效或超出容量')
    if (job.status.mode === 'share' ? shareUrl(capture.url, platform) !== job.url : getSourceId(capture.url, platform) !== job.status.conversationId || capture.conversationId !== job.status.conversationId) throw new Error('接口核对页身份不一致')
    const messages = job.evidence instanceof GeminiNetworkEvidence ? job.evidence.verify(capture.messages, true, capture.networkEvidence) : job.evidence!.verify(capture.messages)
    const current = await readContext(job.status.originTabId, job.sourceToken, job.sourceDocumentId)
    const existing = await getSavedConversationBySource(platform, job.status.conversationId, job.accountId)
    const source = current ?? job.source
    if (!source || source.platform !== platform || source.conversationId !== job.status.conversationId) throw new Error('原对话身份无法核对')
    const shareSourceMatches = (rendered: ExtractedConversation['messages']): boolean => {
      const ids = new Set(messages.map((message) => message.sourceMessageId))
      const overlap = rendered.filter((message) => message.sourceMessageId && ids.has(message.sourceMessageId))
      if (!overlap.length) return !!findShareAnchor(rendered, messages)
      // An older public snapshot may disagree with newer local text outside
      // the anchor. Bind one unique adjacent question/answer pair, then let
      // the conservative supplement merge retain the rest of the local text.
      for (let index = 0; index + 1 < rendered.length; index += 1) {
        const pair = rendered.slice(index, index + 2)
        if (pair[0].role !== 'user' || pair[1].role !== 'assistant' || pair.some((message) => !message.sourceMessageId || !ids.has(message.sourceMessageId))) continue
        try {
          job.evidence!.verify(pair, false)
          if (findShareAnchor(pair, messages, true)) return true
        } catch { /* Another unchanged native pair may bind this snapshot. */ }
      }
      return false
    }
    if (job.evidence instanceof GeminiNetworkEvidence) {
      const share = job.status.mode === 'share'
      if (!job.evidence.matchesSource(source, false, share) || !job.source || !job.evidence.matchesSource(job.source, !share, share)) throw new Error('Gemini 原对话与接口分支无法绑定；分享采集需在原页显示分享末轮，或更新整条对话分享')
    } else {
      if (job.status.mode === 'share' && ![source.messages, job.source?.messages ?? [], existing?.messages ?? []].some(shareSourceMatches)) throw new Error('分享接口正文与原对话缺少唯一消息锚点，请更新正确的整条对话分享')
      if (job.status.mode === 'conversation' && job.sourceRendered && job.source?.messages.length) job.evidence!.verify(job.source.messages.filter((message) => !!message.sourceMessageId), false)
    }
    job.attachmentPlan = capture.messages.map((message, localIndex) => {
      const networkIndex = platform === 'gemini' ? localIndex : messages.findIndex((entry) => entry.sourceMessageId === message.sourceMessageId)
      return { localIndex, networkIndex, sourceMessageId: messages[networkIndex]?.sourceMessageId ?? '', sourceTurnId: messages[networkIndex]?.sourceTurnId }
    }).filter((entry) => entry.networkIndex >= 0)
    const legacyBindings = platform === 'gemini' ? (existing?.messages ?? []).flatMap((previous) => {
      if (messages.some((message) => message.sourceMessageId === previous.sourceMessageId && message.role === previous.role)) return []
      const candidates = capture.messages.flatMap((message, index) => message.role === previous.role && message.content === previous.content ? [index] : [])
      return candidates.length === 1 && existing!.messages.filter((message) => message.role === previous.role && message.content === previous.content).length === 1
        ? [{ previous, sourceMessageId: messages[candidates[0]].sourceMessageId! }] : []
    }) : []
    if (platform === 'gemini' && job.status.mode === 'conversation' && existing?.attachments?.some((attachment) => {
      const previous = existing.messages[attachment.messageIndex ?? -1]
      return !previous || !messages.some((message) => message.sourceMessageId === previous.sourceMessageId && message.role === previous.role) && !legacyBindings.some((binding) => binding.previous === previous)
    })) throw new Error('已有附件无法与本次 Gemini 消息唯一对应，已保留原记录；请使用 DOM 更新')
    job.status.phase = 'saving'; job.status.message = '接口历史已完整核对，正在保存正文…'
    await persist(job); await notify(job)
    const saved = await saveVerifiedNetworkConversation({
      platform, accountId: job.accountId ?? 'unknown', accountLabel: source.accountLabel, accountSource: source.accountIdentifier ? 'detected' : 'unknown',
      conversationId: job.status.conversationId, url: platform === 'gemini' ? getGeminiSourceUrl(source.url)! : `https://chatgpt.com/c/${job.status.conversationId}`, title: source.title,
      messages, pinned: existing?.pinned ?? current?.nativePinned ?? false, contentHash: await createContentHash(source.title, messages), ...(job.status.mode === 'share' ? { supplementOnly: true } : {}),
    }, () => authorized(job), legacyBindings)
    if (!saved) throw new Error('接口正文保存未确认')
    job.status.bodySaved = true
    if (job.finishing) {
      await job.finishing
      job.status.message = '采集已终止；终止前已提交的完整正文已保留'
      if (jobs.get(job.status.originTabId) === job) { await persist(job); await notify(job) }
      return result(job)
    }
    job.saved = saved.conversation
    job.attachmentPlan = job.attachmentPlan.map((entry) => ({ ...entry, networkIndex: job.saved!.messages.findIndex((message) => message.sourceMessageId === entry.sourceMessageId) }))
    if (!existing) {
      if (job.allowFiles) job.saved = await updateConversationFileAttachmentPermission(job.saved.id, true)
      if (job.saveImages !== undefined) job.saved = await updateConversationImageAttachmentPermission(job.saved.id, job.saveImages)
    }
    job.status.phase = 'attachments'; job.status.messageCount = job.saved.messages.length; job.status.message = '正文已保存，正在确认附件…'
    await persist(job); await notify(job)
    const settings = await getSettings()
    return { ...result(job), attachmentPlan: job.attachmentPlan, attachmentPolicy: {
      saveImages: job.saved.imageAttachmentPermission ?? settings.saveImages,
      allowFiles: settings.fileSavePolicy === 'per-conversation' && job.saved.fileAttachmentPermission,
      skippedFileStatus: settings.fileSavePolicy === 'never' ? 'not-saved' : 'confirmation-required', maximumBytes: settings.attachmentMaxSizeMb * 1024 * 1024,
    } }
  }
  if (request.action === 'attachments') {
    if (!job.saved || job.status.phase !== 'attachments' || !hasValidConversationAttachments(request.attachments)) throw new Error('接口附件阶段或附件数据无效')
    const latest = await getSavedConversationBySource(platform, job.status.conversationId, job.accountId)
    if (!latest || latest.id !== job.saved.id) throw new Error('原对话已删除，不能恢复记录')
    const settings = await getSettings()
    const incoming = (request.attachments ?? []).map((attachment) => {
      const message = latest.messages[attachment.messageIndex ?? -1]
      const plan = job.attachmentPlan?.find((entry) => entry.networkIndex === attachment.messageIndex && entry.sourceMessageId === message?.sourceMessageId)
      if (!plan || !message?.attachmentNames?.includes(attachment.name)) throw new Error('附件不属于本轮已核实的消息')
      const allowed = attachment.kind === 'image' ? latest.imageAttachmentPermission ?? settings.saveImages : settings.fileSavePolicy === 'per-conversation' && latest.fileAttachmentPermission
      return allowed ? attachment : { ...attachment, status: attachment.kind === 'file' && settings.fileSavePolicy === 'per-conversation' ? 'confirmation-required' as const : 'not-saved' as const, dataUrl: undefined }
    })
    const saved = await supplementVerifiedNetworkAttachments(latest.id, incoming, () => authorized(job))
    job.status.savedAttachmentCount = (saved.attachments ?? []).filter((entry) => entry.status === 'saved').length
    job.status.failedAttachmentCount = incoming.filter((entry) => ['unavailable', 'too-large'].includes(entry.status)).length
    const reason = job.status.failedAttachmentCount ? `；${job.status.failedAttachmentCount} 个附件未复制（不可读取或超出容量），已保留正文和既有附件` : ''
    await finish(job, saved.pendingCapture ? 'partial' : 'complete', `接口采集已保存 ${saved.messages.length} 条消息、${job.status.savedAttachmentCount} 个本地附件${reason}${saved.pendingCapture ? '；旧快照未覆盖全部待补全消息，请更新分享或使用本页采集' : ''}`)
    return { ...result(job), savedConversationId: saved.id }
  }
  throw new Error('未知的接口保存操作')
}

export async function handleNetworkCapture(request: NetworkCaptureRequest, sender: chrome.runtime.MessageSender): Promise<NetworkCaptureResponse> {
  await initializeNetworkCaptureJobs()
  const platform = request.platform ?? 'chatgpt'
  if (!['chatgpt', 'gemini'].includes(platform)) throw new Error('不支持的接口采集平台')
  const tabId = sender.tab?.id
  const isPanel = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('panel.html')
  const host = platform === 'gemini' ? 'https://gemini.google.com/' : 'https://chatgpt.com/'
  if (tabId === undefined || !isPanel && (sender.frameId !== 0 || !sender.url?.startsWith(host))) throw new Error('接口验证只能从原对话面板或授权页面操作')
  if (request.action === 'claim' && !isPanel) {
    const job = [...jobs.values()].find((candidate) => jobPlatform(candidate) === platform && isNetworkCaptureActive(candidate.status) && (candidate.status.originTabId === tabId || candidate.status.captureTabId === tabId))
    if (!job || job.finishing) return result()
    if (typeof request.documentToken !== 'string' || request.documentToken.length > 128 || !sender.documentId) throw new Error('无法绑定验证文档')
    if (job.status.captureTabId === tabId) {
      if (shareUrl(sender.url, platform) !== job.url || job.captureToken && job.captureToken !== request.documentToken) {
        await finish(job, 'failed', '分享验证页已刷新或切换，请重新发起'); return result(job)
      }
      job.captureToken = request.documentToken
      job.captureDocumentId = sender.documentId
      job.rebound = true
      return { ...result(job, undefined, true), drive: job.status.operation === 'save' && job.status.phase !== 'awaiting-confirmation' }
    }
    if (getSourceId(sender.url ?? '', platform) !== job.status.conversationId || request.conversationId !== job.status.conversationId || platform === 'gemini' && getGeminiAccountContext(sender.url ?? '') !== job.accountContext) {
      await finish(job, 'cancelled', '原对话已切换，验证已停止'); return result(job)
    }
    if (request.documentToken !== job.sourceToken) {
      if (job.status.mode !== 'conversation' || job.rebound || !job.navigationCount) { await finish(job, 'failed', '原对话再次刷新，验证已停止'); return result(job) }
      job.sourceToken = request.documentToken
      job.branchRevision = 0
      job.rebound = true
    }
    job.sourceDocumentId = sender.documentId
    return { ...result(job), drive: job.status.operation === 'save' && job.status.mode === 'conversation' && job.rebound && job.status.phase !== 'awaiting-confirmation' }
  }
  const captureJob = [...jobs.values()].find((job) => job.status.captureTabId === tabId && isNetworkCaptureActive(job.status))
  if (captureJob && !isPanel) {
    if (jobPlatform(captureJob) !== platform || sender.documentId !== captureJob.captureDocumentId || request.documentToken !== captureJob.captureToken || request.jobId !== captureJob.status.id || shareUrl(sender.url, platform) !== captureJob.url) throw new Error('分享验证文档已失效')
    if (request.action === 'commit' || request.action === 'attachments') return saveNetworkResult(captureJob, request)
    if (request.action === 'error') { await failOrReview(captureJob, captureJob.status.bodySaved ? `正文已保存，附件阶段未完成：${request.error?.slice(0, 250) ?? '请重试'}` : request.error?.slice(0, 300) ?? '接口采集未完成', request.capture); return result(captureJob) }
    if (request.action === 'progress') {
      if (!['saving', 'attachments', 'awaiting-confirmation'].includes(captureJob.status.phase)) {
        captureJob.status.phase = request.needsForeground ? 'needs-foreground' : 'reading'
        captureJob.status.message = request.needsForeground ? '请打开分享采集页并保持可见，任务已保留' : '正在滑动加载并核对分享接口历史…'
        await persist(captureJob)
      }
    } else if (request.action === 'return') await chrome.tabs.update(captureJob.status.originTabId, { active: true })
    else if (request.action === 'cancel') await finish(captureJob, 'cancelled', '接口任务已取消')
    else if (request.action !== 'status') throw new Error('无效的分享验证操作')
    return result(captureJob, undefined, true)
  }
  const sourceId = request.conversationId
  if (!sourceId || sourceId.length > 256) throw new Error('缺少原对话身份')
  if (request.action === 'pause') {
    const paused = activeJob(sourceId, platform)
    return { ...result(paused), drive: paused?.status.operation === 'save' && paused.status.originTabId === tabId && paused.status.mode === 'conversation' && paused.rebound && paused.status.phase !== 'awaiting-confirmation' }
  }
  const state = await probe(tabId)
  if ((state.platform ?? 'chatgpt') !== platform || state.conversationId !== sourceId) throw new Error('当前页面不是任务的原对话')
  if (request.action === 'start') {
    if (!['conversation', 'share'].includes(request.mode ?? '') || request.method !== 'network') throw new Error('无效的采集组合')
    const occupied = activeJob(sourceId, platform)
    if (occupied || hasActiveShareCapture(sourceId, platform) || state.blockers.includes('busy')) return { ...result(occupied, ['busy']), canControl: occupied?.status.originTabId === tabId }
    if ([...jobs.values()].some((job) => isNetworkCaptureActive(job.status) && job.status.originTabId === tabId)) return result(undefined, ['busy'])
    if (request.mode === 'conversation' && state.blockers.length) return result(undefined, state.blockers)
    if ([...jobs.values()].filter((job) => isNetworkCaptureActive(job.status)).length >= 3) throw new Error('请等待其他接口验证结束后重试')
    const url = request.mode === 'share' ? platform === 'gemini' ? await resolveGeminiShareUrl(request.shareUrl) : normalizeChatGPTShareUrl(request.shareUrl) : platform === 'gemini' ? getGeminiSourceUrl(state.url) : `https://chatgpt.com/c/${sourceId}`
    if (!url) throw new Error('请先粘贴当前完整对话的有效分享链接')
    let source: ExtractedConversation | null = null
    let sourceRendered = false
    let accountId = 'unknown'
    if (request.operation === 'save') {
      source = await readContext(tabId, state.documentToken)
      if (source?.platform !== platform) throw new Error('原对话平台已切换')
      accountId = await createAccountId(platform, source.accountIdentifier)
      if (platform === 'gemini' && !source.accountIdentifier) throw new Error('Gemini 账号尚未可辨识，请等待页面加载后重试')
      sourceRendered = !!source?.messages.length
      const saved = await getSavedConversationBySource(platform, sourceId, accountId)
      if (source && !source.messages.length && saved) source = { ...source, messages: saved.messages, title: saved.title }
      if (!source || source.conversationId !== sourceId || !source.messages.length) throw new Error('原对话没有可核对的页面或本地消息，请显示对话后重试')
    }
    const job: Job = {
      status: { platform, id: crypto.randomUUID(), originTabId: tabId, captureTabId: null, conversationId: sourceId, mode: request.mode!, method: 'network', operation: request.operation === 'save' ? 'save' : 'probe', phase: 'connecting', responseCount: 0, responseBytes: 0, largestResponseBytes: 0, nodeCount: 0, message: request.operation === 'save' ? '正在连接接口采集…' : '连接验证模式，本次不保存对话', updatedAt: Date.now() },
      accountId, accountContext: state.accountContext,
      sourceToken: state.documentToken, branchRevision: state.branchRevision, url, ownsTab: false, navigationCount: 0, allowedNavigation: false, rebound: false,
      ...(source ? { source, sourceRendered } : {}), allowFiles: request.allowFiles, saveImages: request.saveImages,
    }
    if (activeJob(sourceId, platform) || [...jobs.values()].some((candidate) => isNetworkCaptureActive(candidate.status) && candidate.status.originTabId === tabId)) return result(undefined, ['busy'])
    jobs.set(tabId, job)
    try { await persist(job); await notify(job) }
    catch { await finish(job, 'failed', '无法记录验证任务，本次未启动'); return result(job) }
    job.launch = launch(job)
    return result(job)
  }
  const localJob = jobs.get(tabId)
  const job = activeJob(sourceId, platform) ?? (localJob && jobPlatform(localJob) === platform && localJob.status.conversationId === sourceId ? localJob : undefined)
  if (!job || job.status.conversationId !== sourceId) return result()
  // Other tabs share the save lock, not the originating document or controls.
  // Their status polling must never invalidate the owner's document binding.
  if (job.status.originTabId !== tabId) {
    if (request.action !== 'status') throw new Error('请在发起接口验证的原对话标签页操作')
    return { ...result(job), canControl: false }
  }
  if (!isPanel && (request.documentToken !== state.documentToken || job.sourceDocumentId && sender.documentId !== job.sourceDocumentId)) throw new Error('原对话验证文档已失效')
  if (isNetworkCaptureActive(job.status) && !(job.status.mode === 'conversation' && job.navigationCount === 1 && !job.rebound)) {
    const current = await probe(tabId, undefined, job.sourceToken, job.sourceDocumentId).catch(() => null)
    if (!current || !validSource(job, current)) await finish(job, 'cancelled', '原对话文档或分支已变化，验证已停止')
  }
  if (request.action === 'status') return { ...result(job), drive: job.status.operation === 'save' && job.status.mode === 'conversation' && job.rebound && job.status.phase !== 'awaiting-confirmation' }
  if (job.status.originTabId !== tabId || request.jobId !== job.status.id) throw new Error('验证任务不属于当前页面')
  if (request.action === 'confirm') {
    if (!isPanel) throw new Error('请在发起页的插件面板确认保存')
    await job.preparingReview
    if (!job.review || !await reviewAuthorized(job)) {
      await finish(job, 'cancelled', '原对话账号、文档或分支已变化，候选内容已丢弃')
      throw new Error('候选内容已失效，请重新采集')
    }
    const existing = await getSavedConversationBySource('chatgpt', job.status.conversationId, job.accountId)
    const saved = await savePendingNetworkConversation(job.review.payload, job.review.issue, () => reviewAuthorized(job))
    if (!saved) throw new Error('待补全保存未确认')
    if (job.finishing) {
      await job.finishing
      job.status.message = '采集已停止；终止前已确认保存的待补全内容和既有附件已保留'
      await persist(job); await notify(job)
      return result(job)
    }
    if (saved.changed && !existing) {
      if (job.allowFiles) await updateConversationFileAttachmentPermission(saved.conversation.id, true)
      if (job.saveImages !== undefined) await updateConversationImageAttachmentPermission(saved.conversation.id, job.saveImages)
    }
    job.status.bodySaved = saved.changed
    job.status.messageCount = saved.conversation.messages.length
    await finish(job, 'partial', saved.conversation.pendingCapture
      ? `已确认保存 ${saved.conversation.messages.length} 条消息，标记为待补全；可用本页 DOM 或更新后的分享页再次采集。已有正文和附件均保留。`
      : '本地已有更完整副本，已保留其正文和附件；本次异常候选未覆盖已有内容。')
    return result(job)
  }
  if (request.action === 'commit' || request.action === 'attachments') {
    if (isPanel || job.status.mode !== 'conversation') throw new Error('接口保存结果必须由本次采集文档提交')
    return saveNetworkResult(job, request)
  }
  if (request.action === 'error') {
    if (isPanel) throw new Error('异常候选必须由本次采集文档提交')
    await failOrReview(job, job.status.bodySaved ? `正文已保存，附件阶段未完成：${request.error?.slice(0, 250) ?? '请重试'}` : request.error?.slice(0, 300) ?? '接口采集未完成', request.capture)
    return result(job)
  }
  if (request.action === 'progress') return result(job)
  if (request.action === 'cancel' || request.action === 'invalidate') await finish(job, 'cancelled', request.action === 'invalidate' ? '当前分支或回答状态已变化，采集已停止；请重新发起' : '接口任务已取消')
  else if (request.action === 'open' && job.ownsTab && job.status.captureTabId !== null) await chrome.tabs.update(job.status.captureTabId, { active: true })
  else if (request.action === 'finish' && isNetworkCaptureActive(job.status)) {
    if (job.status.operation === 'save') throw new Error('接口采集会在正文和附件确认后自动完成')
    if (!job.rebound || !job.status.responseCount || job.session?.pendingCount) throw new Error('页面尚未接续或目标响应仍在读取，请稍后结束验证')
    if (job.status.mode === 'conversation' && state.blockers.some((blocker) => blocker !== 'busy')) { await finish(job, 'failed', '页面输入或回答状态已变化，本次未保存对话'); return result(job) }
    await finish(job, 'verified', '响应读取验证通过；本次未保存对话')
  } else if (request.action === 'return') await chrome.tabs.update(job.status.originTabId, { active: true })
  return result(job)
}

export async function cancelNetworkCaptureJobs(conversationId?: string, platform?: string): Promise<void> {
  await initializeNetworkCaptureJobs()
  for (const job of jobs.values()) if ((!conversationId || job.status.conversationId === conversationId) && (!platform || jobPlatform(job) === platform)) {
    await finish(job, 'cancelled', '本地对话已删除，接口验证已停止')
    jobs.delete(job.status.originTabId)
    await deleteNetworkCaptureJob(job.status.originTabId)
  }
}

export async function handleNetworkTabRemoved(tabId: number): Promise<void> {
  await initializeNetworkCaptureJobs()
  for (const job of jobs.values()) {
    if (job.status.originTabId === tabId || job.status.captureTabId === tabId) {
      if (job.status.captureTabId === tabId) job.ownsTab = false
      await finish(job, 'cancelled', '原对话或验证页已关闭，本次未保存对话')
    }
  }
}

export async function handleNetworkTabNavigated(tabId: number, url: string): Promise<void> {
  await initializeNetworkCaptureJobs()
  for (const job of jobs.values()) {
    if (!isNetworkCaptureActive(job.status)) continue
    if (job.status.originTabId === tabId && (getSourceId(url, jobPlatform(job)) !== job.status.conversationId || jobPlatform(job) === 'gemini' && getGeminiAccountContext(url) !== job.accountContext) || job.status.captureTabId === tabId && url !== 'about:blank' && shareUrl(url, jobPlatform(job)) !== job.url) await finish(job, 'cancelled', '页面已离开原对话或分享链接，验证已停止')
  }
}
