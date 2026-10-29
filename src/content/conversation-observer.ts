import { createAdapter } from '../adapters/adapter-factory'
import type { AIAdapter } from '../adapters/types'
import type {
  ChatMessage,
  Conversation,
  ConversationAttachment,
  ExtractedAttachmentCandidate,
  ExtractedConversation,
} from '../shared/models'
import {
  hasStableMessageIdentity,
  mergeCompleteConversationMessages,
  mergeRenderedConversationMessages,
  reconcileRenderedConversationMessages,
  type ConversationReconciliation,
} from '../shared/conversation-reconciliation'
import type {
  HostConversationContext,
  HostConversationLiveState,
  ManualSaveResult,
  ConversationSyncStatus,
} from '../shared/panel-messages'
import { sendRuntimeRequest } from '../shared/runtime-client'
import {
  RUNTIME_MESSAGE_TYPE,
  type CaptureReadinessReason,
} from '../shared/runtime-messages'
import { EXTENSION_BUILD_ID } from '../shared/build-id'
import {
  createAccountId,
  createContentHash,
} from '../utils/hash'
import { Logger } from '../utils/logger'
import {
  captureAttachments,
  getAttachmentMaximumBytes,
} from './attachment-capture'
import { canAutomaticallyCaptureConversation } from './auto-save-policy'
import { normalizeChatGPTShareUrl, supplementShareCapture } from '../shared/share-capture'
import { normalizeGeminiShareUrl } from '../adapters/gemini/capture-urls'
import { alignGeminiDomShare, mergeGeminiDomShare, portableGeminiDomCapture } from '../adapters/gemini/dom-share'

const EXTRACTION_DEBOUNCE_MS = 1_500
const MAX_ACCUMULATED_CONVERSATIONS = 6
const MAX_ACCUMULATED_MESSAGES = 10_000
const MAX_ACCUMULATED_ATTACHMENTS = 100
const CONTAINER_LOOKUP_MS = 750
const CONTAINER_LOOKUP_MAX_MS = 30_000
const NAVIGATION_CHECK_MS = 1_500
const PIN_ACTION_EVIDENCE_MS = 5 * 60_000
const SIDEBAR_ACTION_CONTEXT_MS = 2 * 60_000
const PENDING_PIN_CONTEXT_MS = 5 * 60_000
const PIN_RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000] as const
const LIVE_PREVIEW_CONTENT_MAX_LENGTH = 1_000
const MANUAL_SAVE_RETRY_DELAYS_MS = [0, 750, 2_000] as const

interface ConversationClickContext {
  conversationId: string
  observedAt: number
}

interface AccumulatedCapture extends ExtractedConversation {
  observedAt: number
}

type CompleteCaptureFailure = 'boundary' | 'gap' | 'error'

interface CompleteCaptureResult {
  failure: CompleteCaptureFailure | null
  messageCount: number
  snapshotVerified: boolean
}

interface CompleteCaptureTask {
  conversationId: string
  generation: number
  promise: Promise<CompleteCaptureResult>
}

type ConversationCaptureTrigger = 'passive' | 'manual' | 'pin'

interface ConversationSaveRequest {
  trigger: ConversationCaptureTrigger
  scheduledGeneration: number
  expectedConversationId: string
  scheduledCaptureRevision: number
  completeSnapshotVerified?: boolean
  manuallyAllowFiles?: boolean
  manuallySaveImages?: boolean
  deferSyncStatus?: boolean
  extractedOverride?: ExtractedConversation
  supplementOnly?: boolean
  supplementVerifiedMessageIds?: string[]
}

interface PinnedCaptureTask {
  conversationId: string
  generation: number
  promise: Promise<void>
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return (
    error instanceof Error &&
    /extension context invalidated/i.test(error.message)
  )
}

function waitForManualSaveRetry(delayMs: number): Promise<void> {
  return delayMs === 0
    ? Promise.resolve()
    : new Promise((resolve) => window.setTimeout(resolve, delayMs))
}

type SuccessfulSaveReconciliation = Exclude<
  ConversationReconciliation,
  { status: 'mismatch' }
>

function isSuccessfulSaveReconciliation(
  reconciliation: ConversationReconciliation | null,
): reconciliation is SuccessfulSaveReconciliation {
  return (
    reconciliation?.status === 'exact' ||
    reconciliation?.status === 'local-history-suffix' ||
    reconciliation?.status === 'local-history-window'
  )
}

function accumulatedCaptureKey(platform: Conversation['platform'], conversationId: string, accountIdentifier: string | null = null): string {
  return JSON.stringify([platform, conversationId, accountIdentifier])
}

function candidateKey(candidate: ExtractedAttachmentCandidate): string {
  return [
    candidate.kind,
    candidate.name.normalize('NFKC').trim().toLocaleLowerCase(),
    candidate.sourceUrl ?? '',
    candidate.sourceTurnId ?? '',
    String(candidate.messageIndex ?? -1),
  ].join('\0')
}

function remapCandidate(
  candidate: ExtractedAttachmentCandidate,
  finalMessages: readonly ChatMessage[],
  startIndex: number | null,
): ExtractedAttachmentCandidate {
  if (candidate.sourceTurnId !== undefined) {
    const finalIndex = finalMessages.findIndex(
      (message) => message.sourceTurnId === candidate.sourceTurnId,
    )
    if (finalIndex >= 0) {
      return { ...candidate, messageIndex: finalIndex }
    }
  }
  if (candidate.messageIndex !== undefined && startIndex !== null) {
    return { ...candidate, messageIndex: candidate.messageIndex + startIndex }
  }
  // A source-index-less candidate is still useful metadata. It is retained and
  // validated later against the final message list.
  return candidate
}

function mergeAccumulatedCapture(
  previous: AccumulatedCapture | undefined,
  incoming: ExtractedConversation,
): AccumulatedCapture | null {
  if (previous === undefined || previous.accountIdentifier !== incoming.accountIdentifier) {
    return { ...incoming, observedAt: Date.now() }
  }
  if (
    incoming.captureComplete === true &&
    incoming.messages.length <= MAX_ACCUMULATED_MESSAGES
  ) {
    const previousCandidates = new Map(
      (previous.attachmentCandidates ?? []).map((candidate) => [
        candidateKey(candidate),
        candidate,
      ]),
    )
    const authoritativeCandidates = (incoming.attachmentCandidates ?? [])
      .slice(0, MAX_ACCUMULATED_ATTACHMENTS)
      .map((candidate) => {
        const cached = previousCandidates.get(candidateKey(candidate))
        return candidate.renderedDataUrl === undefined &&
          cached?.renderedDataUrl !== undefined
          ? { ...candidate, renderedDataUrl: cached.renderedDataUrl }
          : candidate
      })
    return {
      ...incoming,
      messages: mergeCompleteConversationMessages(
        previous.messages,
        incoming.messages,
      ),
      ...(authoritativeCandidates.length > 0
        ? { attachmentCandidates: authoritativeCandidates }
        : { attachmentCandidates: undefined }),
      title: incoming.title.trim() === '' ? previous.title : incoming.title,
      url: incoming.url || previous.url,
      accountIdentifier: incoming.accountIdentifier ?? previous.accountIdentifier,
      accountLabel: incoming.accountLabel === 'Unknown'
        ? previous.accountLabel
        : incoming.accountLabel,
      observedAt: Date.now(),
    }
  }
  const messageMerge = mergeRenderedConversationMessages(
    previous.messages,
    incoming.messages,
  )
  if (messageMerge.status === 'conflict') {
    return null
  }
  if (messageMerge.messages.length > MAX_ACCUMULATED_MESSAGES) {
    return null
  }

  const previousCandidates = previous.attachmentCandidates ?? []
  const incomingCandidates = incoming.attachmentCandidates ?? []
  const remappedPrevious = previousCandidates.map((candidate) =>
    remapCandidate(
      candidate,
      messageMerge.messages,
      messageMerge.existingStartIndex,
    ),
  )
  const remappedIncoming = incomingCandidates.map((candidate) =>
    remapCandidate(
      candidate,
      messageMerge.messages,
      messageMerge.incomingStartIndex,
    ),
  )
  const candidatesByKey = new Map<string, ExtractedAttachmentCandidate>()
  for (const candidate of [...remappedPrevious, ...remappedIncoming]) {
    const key = candidateKey(candidate)
    const previous = candidatesByKey.get(key)
    candidatesByKey.set(key, candidate.renderedDataUrl === undefined &&
      previous?.renderedDataUrl !== undefined
      ? { ...candidate, renderedDataUrl: previous.renderedDataUrl }
      : candidate)
  }
  const candidates = [...candidatesByKey.values()].slice(0, MAX_ACCUMULATED_ATTACHMENTS)
  const captureComplete = incoming.captureComplete ?? previous.captureComplete

  return {
    ...incoming,
    messages: messageMerge.messages,
    ...(captureComplete === undefined ? {} : { captureComplete }),
    ...(candidates.length > 0 ? { attachmentCandidates: candidates } : {}),
    title: incoming.title.trim() === '' ? previous.title : incoming.title,
    url: incoming.url || previous.url,
    accountIdentifier: incoming.accountIdentifier ?? previous.accountIdentifier,
    accountLabel: incoming.accountLabel === 'Unknown'
      ? previous.accountLabel
      : incoming.accountLabel,
    observedAt: Date.now(),
  }
}

export class ConversationObserver {
  private shareAbort: AbortController | null = null

  cancelShareCapture(): void { this.shareAbort?.abort() }

  async saveWithShare(requestedConversationId: string | undefined, allowFiles: boolean | undefined, saveImages: boolean | undefined, shareUrl: string | undefined): Promise<ManualSaveResult> {
    const adapter = this.adapter
    const id = adapter?.getConversationId()
    if (!adapter || !['chatgpt', 'gemini'].includes(adapter.platform) || !id || id !== requestedConversationId || this.shareAbort !== null || this.completeCaptureInProgress || this.networkCapturePaused) return { ok: false, reason: 'not-conversation', message: '请在原 ChatGPT 或 Gemini 对话中启动；已有任务时请先等待或取消' }
    const platform = adapter.platform as 'chatgpt' | 'gemini'
    const abort = new AbortController()
    this.shareAbort = abort
    const generation = this.generation
    const accountIdentifier = adapter.getAccountIdentifier()
    const current = (): boolean => !abort.signal.aborted && !this.destroyed && generation === this.generation && adapter.getConversationId() === id && adapter.getAccountIdentifier() === accountIdentifier
    let jobId: string | undefined
    let savedSuccessfully = false
    let readyToSave = false
    const base = { type: RUNTIME_MESSAGE_TYPE.SHARE_CAPTURE, contentScriptBuildId: EXTENSION_BUILD_ID, conversationId: id, platform } as const
    try {
      if (!current()) throw new Error('采集已取消或原对话已切换')
      const url = platform === 'gemini' ? normalizeGeminiShareUrl(shareUrl) : normalizeChatGPTShareUrl(shareUrl)
      if (shareUrl?.trim() && !url) throw new Error('分享链接格式无效，请使用对应平台的整条对话分享链接')
      if (!url) throw new Error('请手动创建或更新整条对话的分享，并在面板粘贴链接')
      if (!current()) throw new Error('采集已取消或原对话已切换')
      this.clearDebounce()
      this.captureRevision += 1
      this.completeCaptureInProgress = true
      this.setSyncStatus('pending')
      // A transient empty DOM window is exactly why the user may choose share
      // capture. Preserve source identity without requiring a fresh full DOM
      // extraction: previously rendered messages or the saved copy can anchor
      // the result. The worker still checks the link against those messages.
      const renderedSource = platform === 'gemini' ? adapter.extractDomShareConversation?.() ?? null : adapter.extractConversation()
      let source: ExtractedConversation = (renderedSource ? platform === 'gemini' ? portableGeminiDomCapture(renderedSource) : this.accumulateExtractedConversation(renderedSource) : null)
        ?? (platform === 'chatgpt' ? this.getObservedCapture(platform, id) : null)
        ?? {
          platform, conversationId: id, url: location.href,
          title: adapter.getTitle(), messages: adapter.getMessages(),
          accountIdentifier: adapter.getAccountIdentifier(), accountLabel: adapter.getAccountLabel(),
        }
      if (source.platform !== platform || source.conversationId !== id) throw new Error('原对话已切换，请重新打开对应对话的面板')
      if (source.messages.length === 0 && platform === 'chatgpt') {
        const local = await sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_SAVED_CONVERSATION, accountId: await this.getCurrentAccountId(), platform: 'chatgpt', conversationId: id })
        if (!current()) throw new Error('采集已取消或原对话已切换')
        if (local?.platform === 'chatgpt' && local.conversationId === id && local.messages.length > 0) source = { ...source, title: local.title, messages: local.messages }
      }
      if (source.messages.length === 0) throw new Error('当前网页、已观察历史和本地副本均无可核对消息；请在这条原对话显示提问和回答后重试，以确认分享链接归属')
      if (!current()) throw new Error('采集已取消或原对话已切换')
      const started = await sendRuntimeRequest({ ...base, action: 'start', shareUrl: url, sourceMessages: source.messages })
      if (!started.status) throw new Error('分享任务未启动')
      jobId = started.status.id
      let capture: ExtractedConversation | undefined
      while (current()) {
        const state = await sendRuntimeRequest({ ...base, action: 'status' })
        if (!state.status || state.status.id !== jobId) throw new Error('分享任务已失效，请重试')
        if (state.status.phase === 'ready' && state.capture) { capture = state.capture; readyToSave = true; break }
        if (['failed', 'cancelled', 'complete'].includes(state.status.phase)) throw new Error(state.status.message)
        await waitForManualSaveRetry(1_000)
      }
      if (!current() || !capture) throw new Error('采集已取消或原对话已切换')
      if (platform === 'gemini') capture = alignGeminiDomShare(source, portableGeminiDomCapture(capture))
      const accountIdentifier = adapter.getAccountIdentifier()
      if (accountIdentifier !== null) source = { ...source, accountIdentifier, accountLabel: adapter.getAccountLabel() }
      const saved = await this.queueConversationSave({
        trigger: 'manual', scheduledGeneration: generation, expectedConversationId: id, scheduledCaptureRevision: ++this.captureRevision,
        completeSnapshotVerified: true, manuallyAllowFiles: allowFiles, manuallySaveImages: saveImages,
        extractedOverride: platform === 'gemini' ? mergeGeminiDomShare(source, capture) : supplementShareCapture(source, capture),
        supplementOnly: true, deferSyncStatus: true,
        supplementVerifiedMessageIds: capture.messages.flatMap((message) => message.sourceMessageId ? [message.sourceMessageId] : []),
      })
      if (!saved || !current()) throw new Error('分享已完整读取，但原对话保存未确认，请重试')
      const verified = platform === 'gemini'
        ? await sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATION, id: saved.id })
        : await sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_SAVED_CONVERSATION, accountId: await this.getCurrentAccountId(), platform, conversationId: id })
      if (!current() || !verified || verified.id !== saved.id || verified.contentHash !== saved.contentHash) throw new Error('保存后的本地副本已变化或任务已取消，请重新核对')
      const released = await sendRuntimeRequest({ ...base, action: 'release', jobId })
      if (released.status?.phase !== 'complete') throw new Error('任务已取消，未确认本次分享保存')
      savedSuccessfully = true
      this.lastSyncedAt = Date.now()
      this.setSyncStatus('synced')
      return { ok: true, conversationId: id, verification: 'local-history-window' }
    } catch (error: unknown) {
      if (generation === this.generation) this.setSyncStatus('error')
      const message = error instanceof Error ? error.message : '分享采集失败，请重试'
      if (jobId && readyToSave) await sendRuntimeRequest({ ...base, action: 'release', jobId, error: message }).catch(() => undefined)
      return { ok: false, reason: 'failed', message }
    } finally {
      if (jobId && !savedSuccessfully) await sendRuntimeRequest({ ...base, action: 'cancel', jobId }).catch(() => undefined)
      if (this.shareAbort === abort) this.shareAbort = null
      if (generation === this.generation) {
        this.completeCaptureInProgress = false
        this.runSafely(() => {
          this.captureRenderedWindow()
          this.scheduleExtraction()
        })
      }
    }
  }
  private readonly adapter: AIAdapter | null = createAdapter()
  private conversationObserver: MutationObserver | null = null
  private observedContainer: Element | null = null
  private observedScrollTargets: Array<Element | Window> = []
  private observedScrollHandler: (() => void) | null = null
  private observedDocumentScrollHandler: (() => void) | null = null
  private titleObserver: MutationObserver | null = null
  private stopMessageTimeObservation: (() => void) | null = null
  private sidebarObserver: MutationObserver | null = null
  private observedSidebar: Element | null = null
  private currentPinnedState = false
  private readonly pinActionEvidence = new Map<string, number>()
  private recentSidebarConversation: ConversationClickContext | null = null
  private pendingPinConversation: ConversationClickContext | null = null
  private readonly pinRetryTimers = new Set<number>()
  private readonly pinnedCompleteCaptureRequired = new Set<string>()
  private readonly pinnedCompleteCaptureForced = new Set<string>()
  private readonly pinnedCompleteCaptureAttempted = new Set<string>()
  private pinnedCaptureTask: PinnedCaptureTask | null = null
  private readonly attachmentCache = new Map<string, ConversationAttachment>()
  private readonly accumulatedCaptures = new Map<string, AccumulatedCapture>()
  private captureWindowQueued = false
  private completeCaptureInProgress = false
  private networkCapturePaused = false

  hasActiveCompleteCapture(): boolean { return this.completeCaptureInProgress || this.shareAbort !== null }

  setNetworkCapturePaused(paused: boolean): void {
    if (paused === this.networkCapturePaused) return
    this.networkCapturePaused = paused
    this.captureRevision += 1
    if (paused) this.clearDebounce()
    else if (!this.destroyed) this.scheduleExtraction()
  }
  private completeCaptureTask: CompleteCaptureTask | null = null
  private currentConversationSaved: boolean | null = null
  private lastSyncedAccountSignature = ''
  private lastObservedAccountIdentifier: string | null = null
  private lastAccountSyncSignature = ''
  private lastAccountSyncAttemptAt = 0
  private debounceTimer: number | null = null
  private containerLookupTimer: number | null = null
  private navigationTimer: number | null = null
  /** Keep captures in page order so an older async attachment read cannot
   * finish after a newer snapshot and overwrite it. */
  private captureQueue: Promise<void> = Promise.resolve()
  /** A newer scheduled capture invalidates any older in-flight snapshot. */
  private captureRevision = 0
  private generation = 0
  private currentUrl = ''
  private destroyed = false
  private syncStatus: ConversationSyncStatus = 'observing'
  private lastSyncedAt: number | null = null
  private readonly onRuntimeUnavailable: (reason: CaptureReadinessReason) => void
  private readonly onLiveStateChanged: () => void

  constructor(
    onRuntimeUnavailable: (reason: CaptureReadinessReason) => void = () => undefined,
    onLiveStateChanged: () => void = () => undefined,
  ) {
    this.onRuntimeUnavailable = onRuntimeUnavailable
    this.onLiveStateChanged = onLiveStateChanged
  }

  start(): void {
    try {
      if (this.destroyed || this.adapter === null) {
        return
      }

      this.observeDocumentTitle()
      this.stopMessageTimeObservation = this.adapter.observeMessageTimes?.(() => {
        this.runSafely(() => this.scheduleExtraction())
      }) ?? null
      this.ensureSidebarObservation()
      this.currentUrl = location.href
      this.handleConversationLocation()
      this.navigationTimer = window.setInterval(
        () => this.runSafely(() => this.checkNavigation()),
        NAVIGATION_CHECK_MS,
      )
      window.addEventListener('popstate', this.handleNavigationEvent)
      window.addEventListener('hashchange', this.handleNavigationEvent)
      document.addEventListener('click', this.handleDocumentClick, true)
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    } catch (error: unknown) {
      Logger.error('Conversation observer failed to start safely', error)
    }
  }

  async saveCurrentConversation(
    requestedConversationId?: string,
    allowFiles = false,
    saveImages?: boolean,
  ): Promise<ManualSaveResult> {
    if (this.networkCapturePaused) return { ok: false, reason: 'failed', message: '接口验证进行中，请结束验证后再保存' }
    if (this.adapter === null) {
      return {
        ok: false,
        reason: 'not-conversation',
        message: '当前页面不是支持的 AI 对话页面',
      }
    }
    const currentConversationId = this.adapter.getConversationId()
    if (currentConversationId === null) {
      return {
        ok: false,
        reason: 'not-conversation',
        message: '当前页面不是可保存的 AI 对话',
      }
    }
    if (
      requestedConversationId !== undefined &&
      requestedConversationId !== currentConversationId
    ) {
      return {
        ok: false,
        reason: 'not-conversation',
        message: '当前网页打开的不是这条对话；请先打开原对话再允许文件保存',
      }
    }

    const completeCapture = await this.collectCompleteConversation(
      currentConversationId,
    )

    // A manual sweep that did not reach both ends of the virtual list is a
    // partial window, even if that window happens to reconcile with a local
    // record. Do not report a false successful update (or create a new local
    // copy) until the user can retry with a boundary-verified DOM traversal.
    if (completeCapture.failure !== null) {
      if (this.adapter.getConversationId() !== currentConversationId) {
        return {
          ok: false,
          reason: 'not-conversation',
          message: '页面已切换到另一条对话，未继续更新本地副本',
        }
      }
      this.setSyncStatus('error')
      const detail = completeCapture.failure === 'gap'
        ? `已读取到 ${completeCapture.messageCount} 条消息，但扫描结果仍存在消息序号缺口`
        : completeCapture.failure === 'boundary'
          ? `已读取到 ${completeCapture.messageCount} 条消息，但完整滚动未到达对话的顶部和底部`
          : '完整读取网页对话时发生异常'
      return {
        ok: false,
        reason: 'incomplete',
        message: `${detail}；为避免把局部窗口当作完整历史，本次未确认保存。请等待页面稳定后重试。`,
      }
    }

    this.runSafely(() => this.captureRenderedWindow())
    let renderedMessageCount = this.getObservedMessages(
      this.adapter.platform,
      currentConversationId,
    )?.length ?? this.adapter.getMessages().length
    let savedAnyLocalCopy = false
    let lastReconciliation: ConversationReconciliation | null = null
    let localHistoryKnown = false
    let localHistoryChecked = false

    for (
      let attemptIndex = 0;
      attemptIndex < MANUAL_SAVE_RETRY_DELAYS_MS.length;
      attemptIndex += 1
    ) {
      const retryDelay = MANUAL_SAVE_RETRY_DELAYS_MS[attemptIndex]
      if (retryDelay > 0) {
        this.setSyncStatus('pending')
        await waitForManualSaveRetry(retryDelay)
      }
      if (
        this.destroyed ||
        this.adapter === null ||
        this.adapter.getConversationId() !== currentConversationId
      ) {
        return {
          ok: false,
          reason: 'not-conversation',
          message: '页面已切换到另一条对话，未继续更新本地副本',
        }
      }
      this.runSafely(() => this.captureRenderedWindow())
      const renderedMessages = this.getObservedMessages(
        this.adapter.platform,
        currentConversationId,
      ) ?? this.adapter.getMessages()
      renderedMessageCount = renderedMessages.length
      if (renderedMessages[0]?.role === 'assistant') {
        if (!localHistoryChecked) {
          localHistoryChecked = true
          try {
            localHistoryKnown = await sendRuntimeRequest({
              type: RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION,
              accountId: await this.getCurrentAccountId(),
              platform: this.adapter.platform,
              conversationId: currentConversationId,
            })
          } catch {
            localHistoryKnown = false
          }
        }
        const canEnrichExistingHistory = localHistoryKnown &&
          renderedMessages.every(hasStableMessageIdentity)
        if (!canEnrichExistingHistory) {
          this.setSyncStatus('error')
          return {
            ok: false,
            reason: 'incomplete',
            message: `已读取到 ${renderedMessageCount} 条消息，但最早一条仍是回答；网站没有把对应问题挂载到页面。请等待页面完成加载后再更新。`,
          }
        }
      }

      // A manual request is explicit and must not sit behind a pending passive
      // debounce. Same-conversation DOM mutations may continue while ChatGPT or
      // Gemini settles; identity and generation checks below remain mandatory.
      this.clearDebounce()
      const scheduledCaptureRevision = ++this.captureRevision
      const saved = await this.queueConversationSave({
        trigger: 'manual',
        scheduledGeneration: this.generation,
        expectedConversationId: currentConversationId,
        scheduledCaptureRevision,
        completeSnapshotVerified: completeCapture.snapshotVerified,
        manuallyAllowFiles: allowFiles,
        manuallySaveImages: saveImages,
        deferSyncStatus: true,
      })
      if (saved === null) {
        continue
      }
      savedAnyLocalCopy = true

      const reconciliation = await this.verifySavedConversation(
        currentConversationId,
        saved.id,
      )
      if (isSuccessfulSaveReconciliation(reconciliation)) {
        this.lastSyncedAt = Date.now()
        this.setSyncStatus('synced')
        this.pinnedCompleteCaptureRequired.delete(currentConversationId)
        this.pinnedCompleteCaptureForced.delete(currentConversationId)
        this.pinnedCompleteCaptureAttempted.delete(currentConversationId)
        return {
          ok: true,
          conversationId: saved.conversationId,
          verification: reconciliation.status,
        }
      }
      if (reconciliation !== null) {
        lastReconciliation = reconciliation
      }
    }

    this.setSyncStatus('error')
    if (lastReconciliation !== null) {
      return {
        ok: false,
        reason: 'incomplete',
        message: `未确认本地副本已更新：网页当前渲染 ${lastReconciliation.pageMessageCount} 条消息，本地 ${lastReconciliation.localMessageCount} 条。页面可能还在加载完整历史；为避免不完整内容覆盖本地记录，请等待页面稳定后再试。`,
      }
    }
    return {
      ok: false,
      reason: savedAnyLocalCopy || renderedMessageCount > 0 ? 'failed' : 'incomplete',
      message: savedAnyLocalCopy
        ? '本地副本写入后无法重新读取并核对网页内容，请稍后重试'
        : renderedMessageCount === 0
          ? '已识别当前对话，但页面尚未匹配到消息结构，请等待页面加载后再试'
          : `已识别 ${renderedMessageCount} 条消息，但保存请求未返回本地记录。请等待回答停止生成后重试；如果刚更新过插件，请先刷新当前标签页。`,
    }
  }

  /**
   * The single complete-DOM collection entry point. Both an explicit manual
   * update and a first save caused by a trusted native pin action join this
   * task, so neither path can drift to a different boundary/gap policy.
   */
  private collectCompleteConversation(
    expectedConversationId: string,
  ): Promise<CompleteCaptureResult> {
    const generation = this.generation
    const activeTask = this.completeCaptureTask
    if (
      activeTask !== null &&
      activeTask.generation === generation &&
      activeTask.conversationId === expectedConversationId
    ) {
      return activeTask.promise
    }

    // Reserve the page before the collector starts. A passive debounce may
    // already be queued, and an in-flight passive capture must not write a
    // virtual-list window while the complete collector is moving the page.
    this.clearDebounce()
    this.captureRevision += 1
    const hasCompleteCollector = this.adapter?.collectConversation !== undefined
    this.completeCaptureInProgress = hasCompleteCollector
    if (hasCompleteCollector) {
      this.setSyncStatus('saving')
    }

    const promise = this.performCompleteConversationCollection(
      expectedConversationId,
      generation,
    ).finally(() => {
      if (this.completeCaptureTask?.promise !== promise) {
        return
      }
      this.completeCaptureTask = null
      this.completeCaptureInProgress = false
      this.runSafely(() => this.captureRenderedWindow())
    })
    const task: CompleteCaptureTask = {
      conversationId: expectedConversationId,
      generation,
      promise,
    }
    this.completeCaptureTask = task
    return promise
  }

  private async performCompleteConversationCollection(
    expectedConversationId: string,
    expectedGeneration: number,
  ): Promise<CompleteCaptureResult> {
    const adapter = this.adapter
    const expectedAccountIdentifier = adapter?.getAccountIdentifier() ?? null
    if (
      adapter === null ||
      this.destroyed ||
      expectedGeneration !== this.generation ||
      adapter.getConversationId() !== expectedConversationId
    ) {
      return {
        failure: 'error',
        messageCount: 0,
        snapshotVerified: false,
      }
    }

    if (adapter.collectConversation === undefined) {
      this.runSafely(() => this.captureRenderedWindow())
      return {
        failure: null,
        messageCount: this.getObservedMessages(
          adapter.platform,
          expectedConversationId,
        )?.length ?? adapter.getMessages().length,
        snapshotVerified: false,
      }
    }

    try {
      const complete = await adapter.collectConversation((messageCount) => {
        if (
          !this.destroyed &&
          expectedGeneration === this.generation &&
          this.adapter?.getConversationId() === expectedConversationId
        ) {
          if (messageCount > 0) {
            this.syncStatus = 'saving'
          }
          this.notifyLiveStateChanged()
        }
      }, () => this.destroyed || expectedGeneration !== this.generation || this.adapter !== adapter || adapter.getConversationId() !== expectedConversationId || adapter.getAccountIdentifier() !== expectedAccountIdentifier || this.shareAbort?.signal.aborted === true)
      if (
        complete === null ||
        complete.conversationId !== expectedConversationId ||
        complete.accountIdentifier !== expectedAccountIdentifier ||
        adapter.getAccountIdentifier() !== expectedAccountIdentifier ||
        expectedGeneration !== this.generation ||
        adapter.getConversationId() !== expectedConversationId
      ) {
        return {
          failure: 'error',
          messageCount: this.getObservedMessages(
            adapter.platform,
            expectedConversationId,
          )?.length ?? 0,
          snapshotVerified: false,
        }
      }

      const accumulated = this.accumulateExtractedConversation(complete)
      return {
        failure: complete.captureComplete === true
          ? null
          : complete.captureIncompleteReason ?? 'boundary',
        messageCount: accumulated.messages.length,
        snapshotVerified: complete.captureComplete === true,
      }
    } catch (error: unknown) {
      Logger.warn('Complete DOM collection failed', error)
      return {
        failure: 'error',
        messageCount: this.getObservedMessages(
          adapter.platform,
          expectedConversationId,
        )?.length ?? 0,
        snapshotVerified: false,
      }
    }
  }

  private async verifySavedConversation(
    expectedConversationId: string,
    expectedLocalConversationId: string,
  ): Promise<ConversationReconciliation | null> {
    try {
      if (
        this.destroyed ||
        this.adapter === null ||
        this.adapter.getConversationId() !== expectedConversationId
      ) {
        return null
      }
      this.runSafely(() => this.captureRenderedWindow())
      const pageMessages: ChatMessage[] = this.getObservedMessages(
        this.adapter.platform,
        expectedConversationId,
      ) ?? this.adapter.getMessages()
      if (pageMessages.length === 0) {
        return null
      }
      const localConversation = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.GET_SAVED_CONVERSATION,
        accountId: await this.getCurrentAccountId(),
        platform: this.adapter.platform,
        conversationId: expectedConversationId,
      })
      if (
        this.destroyed ||
        this.adapter === null ||
        this.adapter.getConversationId() !== expectedConversationId ||
        localConversation === null ||
        localConversation.id !== expectedLocalConversationId
      ) {
        return null
      }
      return reconcileRenderedConversationMessages(
        pageMessages,
        localConversation.messages,
      )
    } catch {
      return null
    }
  }

  getShareSourceCapture(): ExtractedConversation | null {
    return this.adapter?.extractDomShareConversation?.() ?? this.adapter?.extractConversation() ?? null
  }

  getCurrentConversationContext(): HostConversationContext {
    const conversationId = this.adapter?.getConversationId() ?? null
    return conversationId === null || this.adapter === null
      ? { platform: null, conversationId: null }
      : { platform: this.adapter.platform, conversationId, accountIdentifier: this.adapter.getAccountIdentifier() }
  }

  getCurrentConversationLiveState(): HostConversationLiveState {
    const context = this.getCurrentConversationContext()
    if (
      this.adapter === null ||
      context.platform === null ||
      context.conversationId === null
    ) {
      return {
        context,
        pageTitle: '',
        pageMessageCount: 0,
        recentMessages: [],
        syncStatus: this.syncStatus,
        pinnedEvidence: false,
        observedAt: Date.now(),
        lastSyncedAt: this.lastSyncedAt,
      }
    }

    try {
      const messages = this.getObservedMessages(
        context.platform,
        context.conversationId,
      ) ?? this.adapter.getMessages()
      return {
        context,
        pageTitle: this.adapter.getTitle().slice(0, 1_000),
        pageMessageCount: messages.length,
        recentMessages: messages.slice(-2).map((message) => ({
          role: message.role,
          content: message.content.slice(0, LIVE_PREVIEW_CONTENT_MAX_LENGTH),
        })),
        syncStatus: this.syncStatus,
        pinnedEvidence: this.hasCurrentPinnedEvidence(),
        observedAt: Date.now(),
        lastSyncedAt: this.lastSyncedAt,
      }
    } catch {
      return {
        context,
        pageTitle: '',
        pageMessageCount: 0,
        recentMessages: [],
        syncStatus: this.syncStatus,
        pinnedEvidence: false,
        observedAt: Date.now(),
        lastSyncedAt: this.lastSyncedAt,
      }
    }
  }

  forgetDeletedConversation(
    platform: Conversation['platform'],
    conversationId: string,
  ): void {
    if (
      this.adapter?.platform !== platform ||
      this.adapter.getConversationId() !== conversationId
    ) {
      return
    }
    // Attachment binaries can live briefly in this page-local retry cache.
    // Purge them when Manager deletes the owning conversation so deletion
    // removes both persistent copies and the in-memory capture copy.
    this.attachmentCache.clear()
    this.accumulatedCaptures.delete(
      accumulatedCaptureKey(platform, conversationId, this.adapter?.getAccountIdentifier()),
    )
    this.currentConversationSaved = false
    this.setSyncStatus('observing')
  }

  destroy(): void {
    this.shareAbort?.abort()
    this.destroyed = true
    this.generation += 1
    this.captureRevision += 1
    this.clearDebounce()
    this.completeCaptureInProgress = false
    this.stopContainerLookup()
    this.conversationObserver?.disconnect()
    this.detachObservedScrollListener()
    this.observedContainer = null
    this.titleObserver?.disconnect()
    this.stopMessageTimeObservation?.()
    this.stopMessageTimeObservation = null
    this.sidebarObserver?.disconnect()
    this.clearPinRetryTimers()
    this.pinnedCaptureTask = null
    this.completeCaptureTask = null
    this.pinActionEvidence.clear()
    this.pinnedCompleteCaptureRequired.clear()
    this.pinnedCompleteCaptureForced.clear()
    this.pinnedCompleteCaptureAttempted.clear()
    this.attachmentCache.clear()
    this.accumulatedCaptures.clear()
    if (this.navigationTimer !== null) {
      window.clearInterval(this.navigationTimer)
      this.navigationTimer = null
    }
    window.removeEventListener('popstate', this.handleNavigationEvent)
    window.removeEventListener('hashchange', this.handleNavigationEvent)
    document.removeEventListener('click', this.handleDocumentClick, true)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
  }

  private readonly handleNavigationEvent = (): void => {
    this.runSafely(() => this.checkNavigation(true))
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden || this.adapter === null) {
      return
    }
    void this.refreshSavedConversationState()
    this.notifyLiveStateChanged()
  }

  private readonly handleDocumentClick = (event: MouseEvent): void => {
    this.runSafely(() => {
      if (
        !event.isTrusted ||
        this.destroyed ||
        this.adapter === null
      ) {
        return
      }
      const eventPath = event.composedPath()
      this.captureSidebarConversationContext(eventPath)
      if (!this.adapter.supportsPinnedConversations()) {
        return
      }

      const isUnpinAction = eventPath.some(
        (target) => this.adapter?.isUnpinActionTarget(target) === true,
      )
      const isPinAction = !isUnpinAction && eventPath.some(
        (target) => this.adapter?.isPinActionTarget(target) === true,
      )
      if (!isPinAction && !isUnpinAction) {
        return
      }

      const now = Date.now()
      const currentConversationId = this.adapter.getConversationId()
      const recentSidebarConversation = this.getFreshClickContext(
        this.recentSidebarConversation,
        SIDEBAR_ACTION_CONTEXT_MS,
        now,
      )
      const pendingPinConversation = this.getFreshClickContext(
        this.pendingPinConversation,
        PENDING_PIN_CONTEXT_MS,
        now,
      )
      const pinnedConversationId =
        recentSidebarConversation?.conversationId ??
        pendingPinConversation?.conversationId ??
        currentConversationId
      if (pinnedConversationId === null) {
        return
      }

      void this.updateStoredPinnedState(pinnedConversationId, isPinAction)

      if (isUnpinAction) {
        this.pinActionEvidence.delete(pinnedConversationId)
        this.pinnedCompleteCaptureRequired.delete(pinnedConversationId)
        this.pinnedCompleteCaptureForced.delete(pinnedConversationId)
        this.pinnedCompleteCaptureAttempted.delete(pinnedConversationId)
        if (this.pendingPinConversation?.conversationId === pinnedConversationId) {
          this.pendingPinConversation = null
        }
        if (pinnedConversationId === currentConversationId) {
          this.currentPinnedState = false
          this.scheduleExtraction()
        }
        return
      }

      this.pendingPinConversation = {
        conversationId: pinnedConversationId,
        observedAt: now,
      }
      this.pinActionEvidence.set(
        pinnedConversationId,
        now + PIN_ACTION_EVIDENCE_MS,
      )
      if (
        pinnedConversationId !== currentConversationId ||
        this.currentConversationSaved !== true
      ) {
        this.pinnedCompleteCaptureRequired.add(pinnedConversationId)
        if (pinnedConversationId === currentConversationId) {
          // The record was not known to exist at the instant of the trusted
          // click. Even if an already-dispatched passive write lands now, it
          // must not turn this first save back into a lightweight update.
          this.pinnedCompleteCaptureForced.add(pinnedConversationId)
        } else {
          this.pinnedCompleteCaptureForced.delete(pinnedConversationId)
        }
        this.pinnedCompleteCaptureAttempted.delete(pinnedConversationId)
      } else {
        this.pinnedCompleteCaptureRequired.delete(pinnedConversationId)
        this.pinnedCompleteCaptureForced.delete(pinnedConversationId)
        this.pinnedCompleteCaptureAttempted.delete(pinnedConversationId)
      }
      if (pinnedConversationId === currentConversationId) {
        // Invalidate any partial passive snapshot captured before the trusted
        // pin action. The pin path will either do a complete first save or a
        // lightweight update when the conversation was already stored.
        this.clearDebounce()
        this.captureRevision += 1
        this.currentPinnedState = true
        this.schedulePinExtractionRetries(pinnedConversationId)
      }
    })
  }

  private checkNavigation(force = false): void {
    if (this.destroyed || this.adapter === null) {
      return
    }

    this.ensureSidebarObservation()
    this.refreshPinnedState()

    if (location.href !== this.currentUrl) {
      this.currentUrl = location.href
      this.handleConversationLocation()
      return
    }

    if (
      !force &&
      this.observedContainer !== null &&
      !this.observedContainer.isConnected &&
      this.adapter.isConversationPage()
    ) {
      // A same-URL DOM remount replaces observation, not conversation identity.
      // The complete collector already rebinds its scroll root; changing the
      // generation here would discard its verified result as a false error.
      // Invalidate queued passive windows without cancelling manual/pin work.
      this.captureRevision += 1
      this.clearDebounce()
      this.conversationObserver?.disconnect()
      this.conversationObserver = null
      this.observedContainer = null
      this.detachObservedScrollListener()
      this.findAndObserveContainer(this.generation)
    }
  }

  private handleConversationLocation(): void {
    if (this.adapter === null) {
      return
    }
    this.generation += 1
    this.captureRevision += 1
    this.clearDebounce()
    this.clearPinRetryTimers()
    this.pinnedCaptureTask = null
    this.completeCaptureTask = null
    this.completeCaptureInProgress = false
    this.stopContainerLookup()
    this.conversationObserver?.disconnect()
    this.conversationObserver = null
    this.observedContainer = null
    this.detachObservedScrollListener()
    this.currentPinnedState = this.hasCurrentPinnedEvidence()
    this.attachmentCache.clear()
    this.currentConversationSaved = null
    this.syncStatus = 'observing'
    this.lastSyncedAt = null

    if (this.adapter.isConversationPage()) {
      void this.refreshSavedConversationState()
      this.findAndObserveContainer(this.generation)
    }
    this.notifyLiveStateChanged()
  }

  private findAndObserveContainer(generation: number): void {
    if (this.adapter === null) {
      return
    }
    const adapter = this.adapter
    const startedAt = Date.now()

    const attempt = (): void => {
      if (this.destroyed || generation !== this.generation) {
        this.stopContainerLookup()
        return
      }

      const container = adapter.getConversationObservationContainer()
      if (container !== null) {
        this.stopContainerLookup()
        this.observeConversationContainer(container, generation)
        return
      }

      if (Date.now() - startedAt >= CONTAINER_LOOKUP_MAX_MS) {
        this.stopContainerLookup()
      }
    }

    attempt()
    if (this.conversationObserver === null && this.containerLookupTimer === null) {
      this.containerLookupTimer = window.setInterval(
        () => this.runSafely(attempt),
        CONTAINER_LOOKUP_MS,
      )
    }
  }

  private observeConversationContainer(container: Element, generation: number): void {
    if (generation !== this.generation || this.destroyed) {
      return
    }

    this.conversationObserver = new MutationObserver(() => {
      this.runSafely(() => {
        this.queueRenderedWindowCapture()
        if (!this.completeCaptureInProgress) {
          this.scheduleExtraction()
        }
      })
    })
    this.observedContainer = container
    this.attachObservedScrollListener(container)
    this.conversationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    this.queueRenderedWindowCapture()
    this.scheduleExtraction()
  }

  private attachObservedScrollListener(container: Element): void {
    this.detachObservedScrollListener()
    const handler = (): void => {
      this.queueRenderedWindowCapture()
      if (!this.completeCaptureInProgress) {
        this.scheduleExtraction()
      }
    }
    this.observedScrollHandler = handler
    this.observedScrollTargets = [container]
    container.addEventListener('scroll', handler, { passive: true })
    // Some ChatGPT releases put the scroll position on the document while the
    // React root remains the mutation target. Listening at the window closes
    // that gap without changing the page's scroll behavior.
    if (container !== document.documentElement && container !== document.body) {
      this.observedScrollTargets.push(window)
      window.addEventListener('scroll', handler, { passive: true })
    }
    this.observedDocumentScrollHandler = handler
    document.addEventListener('scroll', handler, { capture: true, passive: true })
  }

  private detachObservedScrollListener(): void {
    if (this.observedScrollHandler === null) {
      this.observedScrollTargets = []
      return
    }
    for (const target of this.observedScrollTargets) {
      target.removeEventListener('scroll', this.observedScrollHandler)
    }
    if (this.observedDocumentScrollHandler !== null) {
      document.removeEventListener('scroll', this.observedDocumentScrollHandler, true)
    }
    this.observedScrollTargets = []
    this.observedScrollHandler = null
    this.observedDocumentScrollHandler = null
  }

  private queueRenderedWindowCapture(): void {
    if (this.captureWindowQueued || this.destroyed) {
      return
    }
    this.captureWindowQueued = true
    queueMicrotask(() => {
      this.captureWindowQueued = false
      this.runSafely(() => this.captureRenderedWindow())
    })
  }

  private captureRenderedWindow(): void {
    if (this.destroyed || this.adapter === null) {
      return
    }
    const conversationId = this.adapter.getConversationId()
    if (conversationId === null) {
      return
    }
    const extracted = this.adapter.extractConversation()
    if (
      extracted === null ||
      extracted.conversationId !== conversationId ||
      extracted.messages.length === 0
    ) {
      return
    }
    const key = accumulatedCaptureKey(extracted.platform, conversationId, extracted.accountIdentifier)
    const merged = mergeAccumulatedCapture(
      this.accumulatedCaptures.get(key),
      extracted,
    )
    if (merged === null) {
      // An unanchored snapshot must never erase a page-local accumulated copy.
      return
    }
    this.accumulatedCaptures.delete(key)
    this.accumulatedCaptures.set(key, merged)
    while (this.accumulatedCaptures.size > MAX_ACCUMULATED_CONVERSATIONS) {
      const oldestKey = this.accumulatedCaptures.keys().next().value
      if (typeof oldestKey !== 'string') {
        break
      }
      this.accumulatedCaptures.delete(oldestKey)
    }
    this.notifyLiveStateChanged()
  }

  private getObservedCapture(
    platform: Conversation['platform'],
    conversationId: string,
  ): AccumulatedCapture | null {
    return this.accumulatedCaptures.get(
      accumulatedCaptureKey(platform, conversationId, this.adapter?.getAccountIdentifier()),
    ) ?? null
  }

  private getObservedMessages(
    platform: Conversation['platform'],
    conversationId: string,
  ): ChatMessage[] | null {
    return this.getObservedCapture(platform, conversationId)?.messages ?? null
  }

  private observeDocumentTitle(): void {
    const head = document.head
    if (head === null) {
      return
    }

    this.titleObserver = new MutationObserver(() => {
      this.runSafely(() => this.scheduleExtraction())
    })
    this.titleObserver.observe(head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }

  private ensureSidebarObservation(): void {
    if (this.adapter === null) {
      return
    }
    const currentIdentifier = this.adapter.getAccountIdentifier()
    if (currentIdentifier !== this.lastObservedAccountIdentifier) {
      this.lastObservedAccountIdentifier = currentIdentifier
      this.shareAbort?.abort()
      this.handleConversationLocation()
    }
    if (this.observedSidebar?.isConnected) {
      void this.syncDetectedAccountLabel()
      return
    }

    this.sidebarObserver?.disconnect()
    this.sidebarObserver = null
    this.observedSidebar = this.adapter.getSidebarContainer()
    if (this.observedSidebar === null) {
      return
    }

    this.refreshPinnedState()
    void this.syncDetectedAccountLabel()
    this.sidebarObserver = new MutationObserver(() => {
      this.runSafely(() => {
        this.refreshPinnedState()
        void this.syncDetectedAccountLabel()
        // Identity may arrive after the sidebar settles. Never reuse another
        // account's saved-state decision or attachment retry cache.
        const identifier = this.adapter?.getAccountIdentifier() ?? null
        if (identifier !== this.lastObservedAccountIdentifier) {
          this.lastObservedAccountIdentifier = identifier
          this.shareAbort?.abort()
          this.handleConversationLocation()
        }
        this.scheduleExtraction()
      })
    })
    this.sidebarObserver.observe(this.observedSidebar, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: [
        'aria-label',
        'data-email',
        'data-user-name',
        'aria-current',
        'class',
        'data-icon',
        'data-is-pinned',
        'data-pinned',
        'data-section',
        'data-state',
        'data-test-id',
        'data-testid',
        'data-mat-icon-name',
        'fonticon',
        'href',
        'title',
      ],
    })
  }

  private scheduleExtraction(): void {
    if (this.networkCapturePaused) return
    if (
      this.destroyed ||
      this.adapter === null ||
      this.completeCaptureInProgress
    ) {
      return
    }

    const expectedConversationId = this.adapter.getConversationId()
    if (expectedConversationId === null) {
      return
    }

    const scheduledGeneration = this.generation
    const scheduledCaptureRevision = ++this.captureRevision
    this.clearDebounce()
    this.syncStatus = 'pending'
    this.notifyLiveStateChanged()
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null
      void this.queueConversationSave({
        trigger: 'passive',
        scheduledGeneration,
        expectedConversationId,
        scheduledCaptureRevision,
      })
    }, EXTRACTION_DEBOUNCE_MS)
  }

  /**
   * The only current-page conversation persistence queue. Passive observation,
   * manual update, and native-pin first save all converge here before either
   * text or attachments can reach the service worker.
   */
  private async queueConversationSave(
    request: ConversationSaveRequest,
  ): Promise<Conversation | null> {
    const run = (): Promise<Conversation | null> =>
      this.performConversationSave(request)
    const queued = this.captureQueue.then(run, run)
    this.captureQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private async performConversationSave(
    request: ConversationSaveRequest,
  ): Promise<Conversation | null> {
    if (this.networkCapturePaused) return null
    const {
      trigger,
      scheduledGeneration,
      expectedConversationId,
      scheduledCaptureRevision,
      completeSnapshotVerified = false,
      manuallyAllowFiles = false,
      manuallySaveImages,
      deferSyncStatus = false,
    } = request
    const respectAutoSave = trigger !== 'manual'
    const requireRevisionMatch = trigger === 'passive'
    const expectedAccountIdentifier = this.adapter?.getAccountIdentifier() ?? null
    const captureIsCurrent = (): boolean => this.isCaptureCurrent(
      scheduledGeneration,
      expectedConversationId,
      scheduledCaptureRevision,
      requireRevisionMatch,
    ) && this.adapter?.getAccountIdentifier() === expectedAccountIdentifier && !(request.supplementOnly && this.shareAbort?.signal.aborted)
    try {
      if (!captureIsCurrent()) {
        return null
      }
      const adapter = this.adapter
      if (adapter === null) {
        return null
      }

      if (!await this.ensureCaptureRuntimeReady()) {
        return null
      }

      const beforeId = adapter.getConversationId()
      if (beforeId === null || beforeId !== expectedConversationId) {
        return null
      }
      if (!captureIsCurrent()) {
        return null
      }

      const settings = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.GET_SETTINGS,
      })
      let pinnedOnly = false
      let pinnedEvidence = false
      if (respectAutoSave) {
        const autoCaptureIsCurrent = captureIsCurrent()
        if (
          !settings.autoSave ||
          !settings.autoSavePlatforms.includes(adapter.platform) ||
          !autoCaptureIsCurrent
        ) {
          if (autoCaptureIsCurrent) {
            this.setSyncStatus('observing')
          }
          return null
        }
        pinnedOnly = settings.autoSavePinnedOnly
        pinnedEvidence = this.hasCurrentPinnedEvidence()
      }

      // A trusted native pin action on an unsaved current conversation owns
      // the first write. Block every passive DOM/title/scroll snapshot until
      // that action has either completed the shared boundary-verified sweep or
      // failed closed. This prevents host mutations caused by the pin UI from
      // racing a partial virtual-list window into IndexedDB.
      if (
        trigger === 'passive' &&
        this.pinnedCompleteCaptureRequired.has(expectedConversationId)
      ) {
        const alreadySaved = await sendRuntimeRequest({
          type: RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION,
          accountId: await this.getCurrentAccountId(),
          platform: adapter.platform,
          conversationId: expectedConversationId,
        })
        if (!captureIsCurrent()) {
          return null
        }
        const forceComplete = this.pinnedCompleteCaptureForced.has(
          expectedConversationId,
        )
        if (forceComplete || !alreadySaved) {
          if (!this.pinnedCompleteCaptureAttempted.has(expectedConversationId)) {
            this.setSyncStatus('pending')
            this.schedulePinExtractionRetries(expectedConversationId)
          } else if (this.pinnedCaptureTask === null) {
            this.setSyncStatus('observing')
          }
          return null
        }
        this.currentConversationSaved = true
        this.pinnedCompleteCaptureRequired.delete(expectedConversationId)
        this.pinnedCompleteCaptureForced.delete(expectedConversationId)
        this.pinnedCompleteCaptureAttempted.delete(expectedConversationId)
      }

      const currentExtracted = request.extractedOverride ?? adapter.extractConversation()
      const extracted = request.extractedOverride ?? (currentExtracted === null
        ? this.getObservedCapture(adapter.platform, expectedConversationId)
        : this.accumulateExtractedConversation(currentExtracted))
      const afterId = adapter.getConversationId()
      if (
        extracted === null ||
        extracted.messages.length === 0 ||
        afterId !== beforeId ||
        extracted.conversationId !== expectedConversationId ||
        extracted.accountIdentifier !== expectedAccountIdentifier ||
        !captureIsCurrent()
      ) {
        if (captureIsCurrent()) {
          this.setSyncStatus('observing')
        }
        return null
      }
      if (completeSnapshotVerified && extracted.captureComplete !== true) {
        this.setSyncStatus('error')
        return null
      }

      const accountId = await createAccountId(
        extracted.platform,
        extracted.accountIdentifier,
      )
      if (!captureIsCurrent()) {
        return null
      }

      if (pinnedOnly && !pinnedEvidence) {
        const alreadySaved = await sendRuntimeRequest({
          type: RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION,
          accountId: await this.getCurrentAccountId(),
          platform: extracted.platform,
          conversationId: extracted.conversationId,
        })
        if (!captureIsCurrent()) {
          return null
        }
        if (!canAutomaticallyCaptureConversation(
          pinnedOnly,
          pinnedEvidence,
          alreadySaved,
        )) {
          this.setSyncStatus('observing')
          return null
        }
      }

      if (!captureIsCurrent()) {
        return null
      }

      this.setSyncStatus('saving')
      const saveMode = trigger === 'manual' ? 'manual' : 'automatic'
      const basePayload = {
        ...(request.supplementOnly ? { supplementOnly: true } : {}),
        ...(request.supplementVerifiedMessageIds ? { supplementVerifiedMessageIds: request.supplementVerifiedMessageIds } : {}),
        platform: extracted.platform,
        accountId,
        accountLabel: extracted.accountLabel,
        accountSource: extracted.accountIdentifier === null ? 'unknown' as const : 'detected' as const,
        conversationId: extracted.conversationId,
        title: extracted.title,
        url: extracted.url,
        messages: extracted.messages,
        pinned: this.hasCurrentPinnedEvidence(),
      }
      const attachmentSnapshotComplete = completeSnapshotVerified &&
        extracted.captureComplete === true
      const attachmentCandidates = extracted.attachmentCandidates ?? []
      const hasAttachmentCandidates = attachmentCandidates.length > 0
      const contentHash = await createContentHash(
        extracted.title,
        extracted.messages,
      )
      if (!captureIsCurrent()) {
        return null
      }
      let saved = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.SAVE_CONVERSATION,
        contentScriptBuildId: EXTENSION_BUILD_ID,
        saveMode,
        conversation: {
          ...basePayload,
          ...(attachmentSnapshotComplete ? { captureSnapshotComplete: true } : {}),
          ...(attachmentSnapshotComplete && !hasAttachmentCandidates
            ? { attachments: [], attachmentSnapshotComplete: true }
            : {}),
          contentHash,
        },
      })
      if (saved !== null) {
        if (!captureIsCurrent()) {
          return saved
        }
        this.currentConversationSaved = true
        if (!deferSyncStatus) {
          this.lastSyncedAt = Date.now()
          this.setSyncStatus('synced')
        }
      }
      if (saved === null) {
        if (captureIsCurrent()) {
          this.setSyncStatus('observing')
        }
        return saved
      }

      if (
        trigger === 'manual' &&
        manuallyAllowFiles &&
        settings.fileSavePolicy === 'per-conversation' &&
        !saved.fileAttachmentPermission
      ) {
        saved = await sendRuntimeRequest({
          type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_FILE_PERMISSION,
          id: saved.id,
          allowed: true,
        })
        if (!captureIsCurrent()) {
          return saved
        }
      }
      if (
        trigger === 'manual' &&
        manuallySaveImages !== undefined &&
        saved.imageAttachmentPermission !== manuallySaveImages
      ) {
        saved = await sendRuntimeRequest({
          type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMAGE_PERMISSION,
          id: saved.id,
          allowed: manuallySaveImages,
        })
        if (!captureIsCurrent()) {
          return saved
        }
      }
      if (!hasAttachmentCandidates) {
        return saved
      }

      const allowFiles =
        settings.fileSavePolicy === 'per-conversation' &&
        (saved.fileAttachmentPermission || (trigger === 'manual' && manuallyAllowFiles))
      const attachments = await captureAttachments(
        attachmentCandidates,
        {
          saveImages: saved.imageAttachmentPermission ?? settings.saveImages,
          allowFiles,
          skippedFileStatus:
            settings.fileSavePolicy === 'never'
              ? 'not-saved'
              : 'confirmation-required',
          maximumBytes: getAttachmentMaximumBytes(
            settings.attachmentMaxSizeMb,
          ),
        },
        this.attachmentCache,
      )
      if (!captureIsCurrent()) {
        return saved
      }
      const attachmentContentHash = await createContentHash(
        extracted.title,
        extracted.messages,
        attachments,
      )
      if (!captureIsCurrent()) {
        return saved
      }
      const savedWithAttachments = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.SAVE_CONVERSATION,
        contentScriptBuildId: EXTENSION_BUILD_ID,
        saveMode,
        conversation: {
          ...basePayload,
          attachments,
          ...(attachmentSnapshotComplete ? { captureSnapshotComplete: true } : {}),
          ...(attachmentSnapshotComplete ? { attachmentSnapshotComplete: true } : {}),
          contentHash: attachmentContentHash,
        },
      })
      if (
        savedWithAttachments !== null &&
        captureIsCurrent()
      ) {
        if (!deferSyncStatus) {
          this.lastSyncedAt = Date.now()
          this.setSyncStatus('synced')
        }
      }
      return savedWithAttachments ?? saved
    } catch (error: unknown) {
      if (isExtensionContextInvalidated(error)) {
        this.pauseForUnavailableRuntime('version-mismatch')
        return null
      }
      Logger.warn('Conversation capture was skipped safely', error)
      if (captureIsCurrent()) {
        this.setSyncStatus('error')
      }
      if (request.supplementOnly) throw error
      return null
    }
  }

  private accumulateExtractedConversation(
    extracted: ExtractedConversation,
  ): AccumulatedCapture {
    const key = accumulatedCaptureKey(extracted.platform, extracted.conversationId, extracted.accountIdentifier)
    const previous = this.accumulatedCaptures.get(key)
    const merged = mergeAccumulatedCapture(
      previous,
      extracted,
    )
    // A complete sweep can be followed immediately by a virtual-list
    // mutation that exposes an unrelated, unanchored window. Keep the
    // page-local complete copy in that case; a newly confirmed complete
    // snapshot is the one exception and may replace a conflicting partial
    // accumulation because it has authoritative boundary coverage.
    const next = merged ?? (
      extracted.captureComplete === true &&
      extracted.messages.length <= MAX_ACCUMULATED_MESSAGES
        ? { ...extracted, observedAt: Date.now() }
        : previous ?? {
            ...extracted,
            observedAt: Date.now(),
          }
    )
    this.accumulatedCaptures.delete(key)
    this.accumulatedCaptures.set(key, next)
    while (this.accumulatedCaptures.size > MAX_ACCUMULATED_CONVERSATIONS) {
      const oldestKey = this.accumulatedCaptures.keys().next().value
      if (typeof oldestKey !== 'string') {
        break
      }
      this.accumulatedCaptures.delete(oldestKey)
    }
    return next
  }

  private isCaptureCurrent(
    scheduledGeneration: number,
    expectedConversationId: string,
    scheduledCaptureRevision: number,
    requireRevisionMatch = true,
  ): boolean {
    return (
      !this.destroyed &&
      !this.networkCapturePaused &&
      this.adapter !== null &&
      scheduledGeneration === this.generation &&
      (!requireRevisionMatch || scheduledCaptureRevision === this.captureRevision) &&
      this.adapter.getConversationId() === expectedConversationId
    )
  }

  private async ensureCaptureRuntimeReady(): Promise<boolean> {
    try {
      const readiness = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS,
        contentScriptBuildId: EXTENSION_BUILD_ID,
      })
      if (!readiness.ready) {
        this.pauseForUnavailableRuntime(readiness.reason)
        return false
      }
      return true
    } catch {
      this.pauseForUnavailableRuntime('version-mismatch')
      return false
    }
  }

  private pauseForUnavailableRuntime(reason: CaptureReadinessReason): void {
    if (this.destroyed) {
      return
    }
    this.destroy()
    this.onRuntimeUnavailable(reason)
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private stopContainerLookup(): void {
    if (this.containerLookupTimer !== null) {
      window.clearInterval(this.containerLookupTimer)
      this.containerLookupTimer = null
    }
  }

  private refreshPinnedState(): void {
    if (this.adapter === null || !this.adapter.supportsPinnedConversations()) {
      return
    }
    const nextPinnedState = this.hasCurrentPinnedEvidence()
    if (nextPinnedState === this.currentPinnedState) {
      return
    }
    const becamePinned = !this.currentPinnedState && nextPinnedState
    this.currentPinnedState = nextPinnedState
    this.notifyLiveStateChanged()
    if (becamePinned) {
      const conversationId = this.adapter.getConversationId()
      if (
        conversationId !== null &&
        this.pinnedCompleteCaptureRequired.has(conversationId)
      ) {
        this.schedulePinExtractionRetries(conversationId)
      } else {
        this.scheduleExtraction()
      }
    }
  }

  private hasCurrentPinnedEvidence(): boolean {
    const conversationId = this.adapter?.getConversationId() ?? null
    if (conversationId === null) {
      return false
    }
    const now = Date.now()
    const evidenceUntil = this.pinActionEvidence.get(conversationId) ?? 0
    if (evidenceUntil <= now) {
      this.pinActionEvidence.delete(conversationId)
    }
    return (
      evidenceUntil > now ||
      (this.adapter?.supportsPinnedConversations() === true &&
        this.adapter.isCurrentConversationPinned())
    )
  }

  private captureSidebarConversationContext(eventPath: EventTarget[]): void {
    if (this.adapter === null) {
      return
    }
    for (const target of eventPath) {
      const conversationId = this.adapter.getConversationIdFromTarget(target)
      if (conversationId !== null) {
        this.recentSidebarConversation = {
          conversationId,
          observedAt: Date.now(),
        }
        return
      }
    }
  }

  private getFreshClickContext(
    context: ConversationClickContext | null,
    maxAge: number,
    now: number,
  ): ConversationClickContext | null {
    return context !== null && now - context.observedAt <= maxAge
      ? context
      : null
  }

  private async updateStoredPinnedState(
    conversationId: string,
    pinned: boolean,
  ): Promise<void> {
    if (this.adapter === null) {
      return
    }
    try {
      const accountId = await createAccountId(
        this.adapter.platform,
        this.adapter.getAccountIdentifier(),
      )
      await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_PINNED,
        platform: this.adapter.platform,
        accountId,
        conversationId,
        pinned,
      })
    } catch (error: unknown) {
      if (isExtensionContextInvalidated(error)) {
        this.pauseForUnavailableRuntime('version-mismatch')
        return
      }
      Logger.warn('Pinned conversation state update was skipped safely', error)
    }
  }

  private getCurrentAccountId(): Promise<string> {
    if (this.adapter === null) throw new Error('当前页面没有可采集的对话')
    return createAccountId(this.adapter.platform, this.adapter.getAccountIdentifier())
  }

  private async syncDetectedAccountLabel(): Promise<void> {
    if (this.adapter === null) {
      return
    }
    const identifier = this.adapter.getAccountIdentifier()
    const label = this.adapter.getAccountLabel().trim()
    if (identifier === null || label === '' || label === 'Unknown') {
      return
    }
    try {
      const accountId = await createAccountId(this.adapter.platform, identifier)
      const signature = `${this.adapter.platform}\0${accountId}\0${label}`
      const now = Date.now()
      if (signature === this.lastSyncedAccountSignature) {
        return
      }
      if (
        signature === this.lastAccountSyncSignature &&
        now - this.lastAccountSyncAttemptAt < 30_000
      ) {
        return
      }
      this.lastAccountSyncSignature = signature
      this.lastAccountSyncAttemptAt = now
      const account = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.SYNC_DETECTED_ACCOUNT_LABEL,
        platform: this.adapter.platform,
        accountId,
        label,
      })
      if (account !== null) {
        this.lastSyncedAccountSignature = signature
      }
    } catch (error: unknown) {
      if (isExtensionContextInvalidated(error)) {
        this.pauseForUnavailableRuntime('version-mismatch')
        return
      }
      Logger.warn('Detected account label sync was skipped safely', error)
    }
  }

  private schedulePinExtractionRetries(conversationId: string): void {
    this.clearPinRetryTimers()
    if (!this.pinnedCompleteCaptureRequired.has(conversationId)) {
      this.scheduleExtraction()
      return
    }
    for (const delay of PIN_RETRY_DELAYS_MS) {
      if (delay === 0) {
        this.requestPinnedCompleteCapture(conversationId)
        continue
      }
      const timer = window.setTimeout(() => {
        this.pinRetryTimers.delete(timer)
        if (
          !this.destroyed &&
          this.adapter?.getConversationId() === conversationId &&
          this.hasCurrentPinnedEvidence()
        ) {
          this.requestPinnedCompleteCapture(conversationId)
        }
      }, delay)
      this.pinRetryTimers.add(timer)
    }
  }

  private requestPinnedCompleteCapture(conversationId: string): void {
    if (
      this.destroyed ||
      this.adapter === null ||
      this.adapter.getConversationId() !== conversationId ||
      !this.pinnedCompleteCaptureRequired.has(conversationId)
    ) {
      return
    }
    const generation = this.generation
    const activeTask = this.pinnedCaptureTask
    if (
      activeTask !== null &&
      activeTask.generation === generation &&
      activeTask.conversationId === conversationId
    ) {
      return
    }

    const promise = this.capturePinnedConversationCompletely(
      conversationId,
      generation,
    ).catch((error: unknown) => {
      if (isExtensionContextInvalidated(error)) {
        this.pauseForUnavailableRuntime('version-mismatch')
        return
      }
      Logger.warn('Pinned conversation complete capture was skipped safely', error)
      if (
        !this.destroyed &&
        this.adapter?.getConversationId() === conversationId
      ) {
        this.setSyncStatus('error')
      }
    }).finally(() => {
      if (this.pinnedCaptureTask?.promise === promise) {
        this.pinnedCaptureTask = null
      }
    })
    const task: PinnedCaptureTask = { conversationId, generation, promise }
    this.pinnedCaptureTask = task
  }

  private async capturePinnedConversationCompletely(
    conversationId: string,
    generation: number,
  ): Promise<void> {
    const captureContextIsCurrent = (): boolean => (
      !this.destroyed &&
      this.adapter !== null &&
      generation === this.generation &&
      this.adapter.getConversationId() === conversationId &&
      this.pinnedCompleteCaptureRequired.has(conversationId)
    )
    if (!captureContextIsCurrent() || !this.hasCurrentPinnedEvidence()) {
      return
    }
    if (!await this.ensureCaptureRuntimeReady() || !captureContextIsCurrent()) {
      return
    }

    const adapter = this.adapter
    if (adapter === null) {
      return
    }
    const settings = await sendRuntimeRequest({
      type: RUNTIME_MESSAGE_TYPE.GET_SETTINGS,
    })
    if (!captureContextIsCurrent()) {
      return
    }
    if (
      !settings.autoSave ||
      !settings.autoSavePlatforms.includes(adapter.platform)
    ) {
      this.clearPinRetryTimers()
      this.setSyncStatus('observing')
      return
    }

    // The forced marker records that this current conversation was not known
    // to be saved at the instant of the trusted click. A racing partial write
    // cannot replace that decision. Without it, `null` means the sidebar action
    // targeted another conversation, so resolve its stored state now.
    const forceComplete = this.pinnedCompleteCaptureForced.has(conversationId)
    let alreadySaved = forceComplete ? false : this.currentConversationSaved
    if (alreadySaved === null) {
      alreadySaved = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION,
        accountId: await this.getCurrentAccountId(),
        platform: adapter.platform,
        conversationId,
      })
      if (!captureContextIsCurrent()) {
        return
      }
    }
    if (alreadySaved) {
      this.currentConversationSaved = true
      this.pinnedCompleteCaptureRequired.delete(conversationId)
      this.pinnedCompleteCaptureForced.delete(conversationId)
      this.pinnedCompleteCaptureAttempted.delete(conversationId)
      this.clearPinRetryTimers()
      this.scheduleExtraction()
      return
    }
    if (adapter.collectConversation === undefined) {
      this.clearPinRetryTimers()
      this.setSyncStatus('error')
      return
    }

    this.pinnedCompleteCaptureAttempted.add(conversationId)
    this.clearPinRetryTimers()
    const completeCapture = await this.collectCompleteConversation(conversationId)
    if (!captureContextIsCurrent()) {
      return
    }
    if (
      completeCapture.failure !== null ||
      !completeCapture.snapshotVerified
    ) {
      this.setSyncStatus('error')
      return
    }

    const scheduledCaptureRevision = ++this.captureRevision
    const saved = await this.queueConversationSave({
      trigger: 'pin',
      scheduledGeneration: generation,
      expectedConversationId: conversationId,
      scheduledCaptureRevision,
      completeSnapshotVerified: true,
      deferSyncStatus: true,
    })
    if (saved === null || !captureContextIsCurrent()) {
      return
    }

    const reconciliation = await this.verifySavedConversation(
      conversationId,
      saved.id,
    )
    if (!isSuccessfulSaveReconciliation(reconciliation)) {
      this.setSyncStatus('error')
      return
    }
    this.pinnedCompleteCaptureRequired.delete(conversationId)
    this.pinnedCompleteCaptureForced.delete(conversationId)
    this.pinnedCompleteCaptureAttempted.delete(conversationId)
    this.pendingPinConversation = null
    this.lastSyncedAt = Date.now()
    this.setSyncStatus('synced')
  }

  private clearPinRetryTimers(): void {
    for (const timer of this.pinRetryTimers) {
      window.clearTimeout(timer)
    }
    this.pinRetryTimers.clear()
  }

  private async refreshSavedConversationState(): Promise<void> {
    try {
      if (this.destroyed || this.adapter === null) {
        return
      }
      const generation = this.generation
      const context = this.getCurrentConversationContext()
      if (context.platform === null || context.conversationId === null) {
        this.currentConversationSaved = false
        return
      }
      const saved = await sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION,
        accountId: await this.getCurrentAccountId(),
        platform: context.platform,
        conversationId: context.conversationId,
      })
      if (
        this.destroyed ||
        generation !== this.generation ||
        this.adapter.getConversationId() !== context.conversationId
      ) {
        return
      }
      this.currentConversationSaved = saved
      this.notifyLiveStateChanged()
    } catch (error: unknown) {
      if (!isExtensionContextInvalidated(error)) {
        Logger.warn('Saved conversation state refresh was skipped safely', error)
      }
    }
  }

  private setSyncStatus(status: ConversationSyncStatus): void {
    this.syncStatus = status
    this.notifyLiveStateChanged()
  }

  private notifyLiveStateChanged(): void {
    try {
      this.onLiveStateChanged()
    } catch {
      // Live status is diagnostic UI and must never interrupt capture.
    }
  }

  private runSafely(operation: () => void): void {
    try {
      operation()
    } catch (error: unknown) {
      Logger.warn('A passive page observation was skipped safely', error)
    }
  }
}
