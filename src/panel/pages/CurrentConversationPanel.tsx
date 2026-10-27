import { useEffect, useRef, useState } from 'react'
import {
  PLATFORM_LABELS,
  type AppSettings,
  type Conversation,
} from '../../shared/models'
import type { HostConversationContext } from '../../shared/panel-messages'
import type { HostConversationLiveState } from '../../shared/panel-messages'
import { isConversationUpdatedExtensionEvent } from '../../shared/extension-events'
import { Header } from '../components/Header'
import { ShareCaptureProgress } from '../components/ShareCaptureProgress'
import { CaptureNotice } from '../components/CaptureNotice'
import { CAPTURE_BLOCKERS, isNetworkCaptureActive, NETWORK_TASK_CHANGED, type CaptureBlocker, type ChatGPTSaveMethod, type NetworkCaptureStatus } from '../../shared/network-capture'
import {
  getSavedConversation,
  getSettings,
  getConversationCaptureMode,
  getConversationSaveMethod,
  setConversationSaveMethod,
  networkCaptureAction,
  getConversationShareLink,
  openManager,
  setConversationImageAttachmentPermission,
  setConversationFileAttachmentPermission,
  setConversationImportant,
  setConversationCaptureMode,
  setConversationShareLink,
  shareCaptureAction,
} from '../services/panel-api'
import {
  closeHostPanel,
  cancelHostShareCapture,
  getInitialHostConversationContext,
  requestHostConversationLiveState,
  saveCurrentHostConversation,
  setHostPanelLocked,
  subscribeHostConversationContext,
  subscribeHostConversationLiveState,
} from '../services/host-bridge'
import { normalizeChatGPTShareUrl, type ChatGPTCaptureMode, type ShareCaptureStatus } from '../../shared/share-capture'

const STUCK_SYNC_RECOVERY_MS = 10_000
const CURRENT_CONVERSATION_READ_ERROR = '当前对话状态读取失败'
const CAPTURE_MODE_LABELS: Record<ChatGPTCaptureMode, string> = {
  conversation: '本对话滑动',
  share: '分享页滑动',
}
const CAPTURE_CHOICES = [
  { mode: 'conversation', method: 'dom' }, { mode: 'share', method: 'dom' },
  { mode: 'conversation', method: 'network' }, { mode: 'share', method: 'network' },
] as const

interface PendingAttachmentRefresh {
  images: boolean
  files: boolean
}

const NO_PENDING_ATTACHMENT_REFRESH: PendingAttachmentRefresh = {
  images: false,
  files: false,
}

const SYNC_STATUS_LABELS: Record<HostConversationLiveState['syncStatus'], string> = {
  observing: '正在监控页面',
  pending: '检测到修改，等待页面稳定',
  saving: '正在同步本地副本',
  synced: '本地副本已写入',
  error: '最近一次同步失败',
}

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatSyncTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function describeAttachmentCapture(
  conversation: Conversation | null,
  fallback: string,
): string {
  const attachments = conversation?.attachments ?? []
  const savedCount = attachments.filter(
    (attachment) => attachment.status === 'saved',
  ).length
  if (savedCount > 0) {
    return `${fallback}，已保存 ${savedCount} 个本地附件`
  }
  if (attachments.some(
    (attachment) => attachment.status === 'confirmation-required',
  )) {
    return `${fallback}；普通文件尚未授权，仅记录了附件信息`
  }
  if (attachments.length > 0) {
    return `${fallback}；已记录附件信息，但当前页面未提供可复制的文件内容`
  }
  return fallback
}

function describeVerifiedManualSave(
  verification: 'exact' | 'local-history-suffix' | 'local-history-window',
  alreadySaved: boolean,
): string {
  if (
    verification === 'local-history-suffix' ||
    verification === 'local-history-window'
  ) {
    return '已核对网页当前内容，本地保留更完整的历史'
  }
  return alreadySaved ? '已核对并更新本地副本' : '已核对并保存当前对话'
}

export function CurrentConversationPanel() {
  const [context, setContext] = useState<HostConversationContext>(
    getInitialHostConversationContext,
  )
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [manualSaving, setManualSaving] = useState(false)
  const [manualShareSaving, setManualShareSaving] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [shareStatus, setShareStatus] = useState<ShareCaptureStatus | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [captureModeOverride, setCaptureModeOverride] = useState<ChatGPTCaptureMode | null>(null)
  const captureModeRevision = useRef(0)
  const [saveMethodOverride, setSaveMethodOverride] = useState<ChatGPTSaveMethod | null>(null)
  const saveMethodRevision = useRef(0)
  const [networkStatus, setNetworkStatus] = useState<NetworkCaptureStatus | null>(null)
  const [networkControllable, setNetworkControllable] = useState(true)
  const completedNetworkJob = useRef<string | null>(null)
  const [captureBlockers, setCaptureBlockers] = useState<CaptureBlocker[]>([])
  const networkActive = isNetworkCaptureActive(networkStatus)
  const shareUrlRevision = useRef(0)
  const shareUrlEdited = useRef(false)
  const previousShareJobId = useRef<string | null>(null)
  const contextRef = useRef(context)
  const manualOperation = useRef(0)
  const defaultCaptureMode = settings?.chatgptCaptureMode ?? 'conversation'
  const captureMode = context.platform === 'chatgpt' ? networkActive ? networkStatus!.mode : captureModeOverride ?? defaultCaptureMode : 'conversation'
  const saveMethod = context.platform === 'chatgpt' ? networkActive ? 'network' : saveMethodOverride ?? settings?.chatgptSaveMethod ?? 'dom' : 'dom'
  const usesShare = captureMode !== 'conversation'
  const shareActive = shareStatus !== null && !['complete', 'failed', 'cancelled'].includes(shareStatus.phase)
  useEffect(() => {
    if (context.platform !== 'chatgpt' || !context.conversationId) return
    let disposed = false
    let timer: number | undefined
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || disposed) return
      pending = true
      try {
        const response = await networkCaptureAction(context.conversationId!, 'status')
        if (!disposed) {
          setNetworkStatus(response.status); setNetworkControllable(response.canControl !== false)
          if (response.status && ['complete', 'partial'].includes(response.status.phase) && completedNetworkJob.current !== response.status.id) {
            completedNetworkJob.current = response.status.id
            setRefreshVersion((value) => value + 1)
          }
        }
      } catch { /* A stale host displays its own refresh notice. */ }
      finally { pending = false }
    }
    const poll = async (): Promise<void> => {
      await refresh()
      if (!disposed && networkActive) timer = window.setTimeout(() => { void poll() }, 2_000)
    }
    const listener = (message: unknown): void => {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === NETWORK_TASK_CHANGED) void refresh()
    }
    void poll()
    chrome.runtime.onMessage.addListener(listener)
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); chrome.runtime.onMessage.removeListener(listener) }
  }, [context.platform, context.conversationId, networkActive])
  useEffect(() => {
    if (context.platform !== 'chatgpt' || !context.conversationId) return
    let disposed = false
    let pending = false
    const update = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const response = await shareCaptureAction(context.conversationId!, 'status')
        if (!disposed && !(manualShareSaving && response.status?.id === previousShareJobId.current)) {
          setShareStatus(response.status)
          if (response.status?.phase === 'complete') setRefreshVersion((value) => value + 1)
        }
      } catch { /* The host reports the final error through its save response. */ }
      finally { pending = false }
    }
    // One initial read restores a task when this overlay is reopened. Continue
    // polling only while a capture is running, never for idle conversations.
    let timer: number | null = null
    const poll = async (): Promise<void> => {
      await update()
      if (!disposed && (manualShareSaving || shareActive)) timer = window.setTimeout(() => { void poll() }, 2_000)
    }
    void poll()
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer) }
  }, [manualShareSaving, shareActive, context.conversationId, context.platform])
  const [locked, setLocked] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveFilesOnFirstCapture, setSaveFilesOnFirstCapture] = useState(false)
  const [saveImagesOnFirstCapture, setSaveImagesOnFirstCapture] = useState<
    boolean | null
  >(null)
  const [pendingAttachmentRefresh, setPendingAttachmentRefresh] =
    useState<PendingAttachmentRefresh>(NO_PENDING_ATTACHMENT_REFRESH)
  const [liveState, setLiveState] = useState<HostConversationLiveState | null>(null)
  const currentLiveState =
    liveState?.context.platform === context.platform &&
    liveState.context.conversationId === context.conversationId
      ? liveState
      : null
  const currentSyncStatus = currentLiveState?.syncStatus ?? null
  const syncRecoveryNeeded =
    currentSyncStatus === 'pending' || currentSyncStatus === 'saving'

  useEffect(() => subscribeHostConversationContext((nextContext) => {
    if (nextContext.platform === contextRef.current.platform && nextContext.conversationId === contextRef.current.conversationId) return
    contextRef.current = nextContext
    manualOperation.current += 1
    captureModeRevision.current += 1
    saveMethodRevision.current += 1
    shareUrlRevision.current += 1
    shareUrlEdited.current = false
    setCaptureModeOverride(null)
    setSaveMethodOverride(null)
    setNetworkStatus(null)
    setCaptureBlockers([])
    setManualSaving(false)
    setManualShareSaving(false)
    setBusy(false)
    setShareUrl('')
    setShareStatus(null)
    setContext(nextContext)
    setLoading(true)
    setNotice(null)
    setError(null)
    setSaveFilesOnFirstCapture(false)
    setSaveImagesOnFirstCapture(null)
    setPendingAttachmentRefresh(NO_PENDING_ATTACHMENT_REFRESH)
    setLiveState(null)
  }), [])

  useEffect(() => {
    const unsubscribe = subscribeHostConversationLiveState((nextState) => {
      setLiveState(nextState)
      if (nextState.syncStatus === 'synced') {
        setRefreshVersion((value) => value + 1)
      }
    })
    requestHostConversationLiveState()
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!syncRecoveryNeeded) {
      return
    }
    const recoveryTimer = window.setTimeout(() => {
      requestHostConversationLiveState()
      setRefreshVersion((value) => value + 1)
    }, STUCK_SYNC_RECOVERY_MS)
    return () => window.clearTimeout(recoveryTimer)
  }, [context.conversationId, context.platform, syncRecoveryNeeded])

  useEffect(() => {
    let active = true
    const refresh = (): void => {
      if (context.platform === null || context.conversationId === null) {
        setConversation(null)
        setLoading(false)
        return
      }
      const modeRevision = captureModeRevision.current
      const methodRevision = saveMethodRevision.current
      const linkRevision = shareUrlRevision.current
      void Promise.all([
        getSavedConversation(context.platform, context.conversationId),
        getSettings(),
        context.platform === 'chatgpt' ? getConversationCaptureMode(context.conversationId) : Promise.resolve(null),
        context.platform === 'chatgpt' ? getConversationShareLink(context.conversationId) : Promise.resolve(null),
        context.platform === 'chatgpt' ? getConversationSaveMethod(context.conversationId) : Promise.resolve(null),
      ])
        .then(([nextConversation, nextSettings, nextCaptureMode, nextShareUrl, nextSaveMethod]) => {
          if (active) {
            setConversation(nextConversation)
            setSettings(nextSettings)
            if (modeRevision === captureModeRevision.current) setCaptureModeOverride(nextCaptureMode)
            if (methodRevision === saveMethodRevision.current) setSaveMethodOverride(nextSaveMethod)
            if (!shareUrlEdited.current && linkRevision === shareUrlRevision.current) setShareUrl(nextShareUrl ?? '')
            setError((current) =>
              current === CURRENT_CONVERSATION_READ_ERROR ? null : current,
            )
          }
        })
        .catch(() => {
          if (active) {
            setError((current) => current ?? CURRENT_CONVERSATION_READ_ERROR)
          }
        })
        .finally(() => {
          if (active) {
            setLoading(false)
          }
        })
    }
    let eventRefreshTimer: number | null = null
    const scheduleRefresh = (): void => {
      if (eventRefreshTimer !== null) {
        window.clearTimeout(eventRefreshTimer)
      }
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = null
        refresh()
      }, 120)
    }
    const handleRuntimeMessage = (message: unknown): void => {
      if (isConversationUpdatedExtensionEvent(message)) {
        scheduleRefresh()
      }
    }
    const handleVisibility = (): void => {
      if (!document.hidden) {
        requestHostConversationLiveState()
        scheduleRefresh()
      }
    }
    const handleFocus = (): void => {
      requestHostConversationLiveState()
      scheduleRefresh()
    }
    const handlePageShow = (): void => {
      requestHostConversationLiveState()
      scheduleRefresh()
    }
    refresh()
    chrome.runtime.onMessage.addListener(handleRuntimeMessage)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('pageshow', handlePageShow)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      if (eventRefreshTimer !== null) {
        window.clearTimeout(eventRefreshTimer)
      }
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('pageshow', handlePageShow)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [context, refreshVersion])

  const changeShareUrl = (value: string): void => {
    setShareUrl(value)
    shareUrlEdited.current = true
    shareUrlRevision.current += 1
    const id = context.conversationId
    const url = normalizeChatGPTShareUrl(value)
    const revision = shareUrlRevision.current
    if (id && (url || !value.trim())) {
      void setConversationShareLink(id, url).catch(() => {
        if (revision === shareUrlRevision.current) setError('分享链接未能记住，请重新粘贴后重试')
      })
    }
  }

  const changeCaptureChoice = async (mode: ChatGPTCaptureMode, method: ChatGPTSaveMethod): Promise<void> => {
    if (busy || shareActive || networkActive || loading || context.platform !== 'chatgpt' || context.conversationId === null) return
    const modeChanged = mode !== captureMode
    const methodChanged = method !== saveMethod
    if (!modeChanged && !methodChanged) return
    const operation = ++manualOperation.current
    if (modeChanged) captureModeRevision.current += 1
    if (methodChanged) saveMethodRevision.current += 1
    setBusy(true)
    setNotice(null)
    setError(null)
    setCaptureBlockers([])
    try {
      // The tab is a presentation of two independent preferences. Unchanged
      // dimensions keep inheriting their Manager default instead of gaining an override.
      const [modeResult, methodResult] = await Promise.allSettled([
        modeChanged ? setConversationCaptureMode(context.conversationId, mode) : Promise.resolve(captureModeOverride),
        methodChanged ? setConversationSaveMethod(context.conversationId, method) : Promise.resolve(saveMethodOverride),
      ])
      if (operation !== manualOperation.current) return
      if (modeChanged) {
        captureModeRevision.current += 1
        if (modeResult.status === 'fulfilled') setCaptureModeOverride(modeResult.value)
      }
      if (methodChanged) {
        saveMethodRevision.current += 1
        if (methodResult.status === 'fulfilled') setSaveMethodOverride(methodResult.value)
      }
      if (modeResult.status === 'rejected' || methodResult.status === 'rejected') setError('采集选项未能全部保存，请重新选择')
    } catch {
      if (operation === manualOperation.current) setError('当前对话采集选项保存失败')
    } finally {
      if (operation === manualOperation.current) setBusy(false)
    }
  }

  const controlNetworkCapture = async (action: 'finish' | 'cancel' | 'open' | 'confirm'): Promise<void> => {
    if (!networkStatus || !networkControllable || !context.conversationId || busy) return
    const operation = manualOperation.current
    setBusy(true)
    setError(null)
    try {
      const response = await networkCaptureAction(context.conversationId, action, networkStatus.id)
      if (operation === manualOperation.current) {
        setNetworkStatus(response.status)
        if (action === 'confirm') setRefreshVersion((value) => value + 1)
      }
    } catch (error: unknown) { if (operation === manualOperation.current) setError(error instanceof Error ? error.message : '接口采集操作失败') }
    finally { if (operation === manualOperation.current) setBusy(false) }
  }

  const manualSave = async (): Promise<void> => {
    if (
      busy || shareActive || networkActive ||
      context.platform === null ||
      context.conversationId === null
    ) {
      return
    }
    if (saveMethod === 'network' && context.platform === 'chatgpt') {
      const operation = ++manualOperation.current
      setBusy(true); setError(null); setNotice(null); setCaptureBlockers([])
      try {
        const response = await networkCaptureAction(context.conversationId, 'start', undefined, {
          mode: captureMode, operation: 'save', allowFiles: saveFilesOnFirstCapture, saveImages: conversationSavesImages,
          ...(usesShare ? { shareUrl: shareUrl.trim() } : {}),
        })
        if (operation === manualOperation.current) {
          setNetworkStatus(response.status); setNetworkControllable(response.canControl !== false); setCaptureBlockers(response.blockers ?? [])
        }
      } catch (error: unknown) { if (operation === manualOperation.current) setError(error instanceof Error ? error.message : '接口采集未能启动') }
      finally { if (operation === manualOperation.current) setBusy(false) }
      return
    }
    setBusy(true)
    setManualSaving(true)
    setManualShareSaving(usesShare)
    setError(null)
    setNotice(null)
    previousShareJobId.current = shareStatus?.id ?? null
    setShareStatus(null)
    const operation = ++manualOperation.current
    try {
      const fileCaptureAuthorized =
        settings?.fileSavePolicy === 'per-conversation' &&
        (conversation?.fileAttachmentPermission === true ||
          (conversation === null && saveFilesOnFirstCapture))
      const result = await saveCurrentHostConversation(
        context.conversationId,
        fileCaptureAuthorized,
        conversation === null
          ? saveImagesOnFirstCapture ?? settings?.saveImages ?? true
          : undefined,
        usesShare ? shareUrl.trim() || undefined : undefined,
        captureMode,
      )
      if (operation !== manualOperation.current) return
      if (!result.ok) {
        setError(result.message)
        return
      }
      setPendingAttachmentRefresh(NO_PENDING_ATTACHMENT_REFRESH)
      const refreshed = await getSavedConversation(
        context.platform,
        context.conversationId,
      )
      if (operation !== manualOperation.current) return
      if (refreshed === null) {
        setError('本地副本已核对，但暂时无法重新读取，请稍后刷新面板')
        return
      }
      setConversation(refreshed)
      setSaveFilesOnFirstCapture(false)
      setSaveImagesOnFirstCapture(null)
      setNotice(refreshed.pendingCapture ? '本次内容已补入；仍有未核对消息，请更新整条对话的分享或使用本页采集继续补全。' : describeAttachmentCapture(
        refreshed,
        usesShare ? '分享内容已核对并补入原对话，本地已有消息已保留' : describeVerifiedManualSave(result.verification, conversation !== null),
      ))
      setRefreshVersion((value) => value + 1)
    } catch {
      if (operation === manualOperation.current) setError('手动保存当前对话失败')
    } finally {
      if (operation === manualOperation.current) {
        setManualSaving(false)
        setManualShareSaving(false)
        setBusy(false)
      }
    }
  }

  const toggleImportant = async (): Promise<void> => {
    if (
      conversation === null ||
      busy ||
      context.platform === null ||
      context.conversationId === null
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const markingImportant = !conversation.important
      const updated = await setConversationImportant(
        conversation.id,
        markingImportant,
      )
      setConversation(updated)
      setNotice(markingImportant
        ? '已标记重要；图片与文件保存权限保持不变'
        : '已取消重要标记；图片与文件保存权限保持不变')
    } catch {
      setError('重要标记更新失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleFilePermission = async (): Promise<void> => {
    if (
      conversation === null ||
      busy ||
      context.platform === null ||
      context.conversationId === null
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const allowFiles = !conversation.fileAttachmentPermission
      const updated = await setConversationFileAttachmentPermission(
        conversation.id,
        allowFiles,
      )
      setConversation(updated)
      if (!allowFiles) {
        setPendingAttachmentRefresh((current) => ({
          ...current,
          files: false,
        }))
        setNotice('已关闭后续的普通文件保存；已有本地文件仍保留')
        return
      }
      setPendingAttachmentRefresh((current) => ({
        ...current,
        files: true,
      }))
      setNotice('普通文件保存权限已开启')
    } catch {
      setError('普通文件权限更新失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleImagePermission = async (): Promise<void> => {
    if (
      conversation === null ||
      busy ||
      context.platform === null ||
      context.conversationId === null
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const currentlySavingImages =
        conversation.imageAttachmentPermission ?? settings?.saveImages ?? true
      const allowImages = !currentlySavingImages
      const updated = await setConversationImageAttachmentPermission(
        conversation.id,
        allowImages,
      )
      setConversation(updated)
      if (!allowImages) {
        setPendingAttachmentRefresh((current) => ({
          ...current,
          images: false,
        }))
        setNotice('已关闭这条对话后续的图片保存；已有本地图片仍保留')
        return
      }
      setPendingAttachmentRefresh((current) => ({
        ...current,
        images: true,
      }))
      setNotice('图片保存权限已开启')
    } catch {
      setError('图片保存权限更新失败')
    } finally {
      setBusy(false)
    }
  }

  const autoSaveEnabled =
    context.platform !== null &&
    settings?.autoSave === true &&
    settings.autoSavePlatforms.includes(context.platform)
  const pageMessageCount = currentLiveState?.pageMessageCount ?? 0
  const localMessageCount = conversation?.messageCount ?? 0
  const displayedTitle = currentLiveState?.pageTitle || conversation?.title || '正在识别标题…'
  const conversationMeta = conversation === null
    ? currentLiveState === null
      ? '正在读取网页内容'
      : `${pageMessageCount} 条网页消息 · 尚未保存`
    : `${localMessageCount} 条消息 · ${formatUpdatedAt(conversation.updatedAt)}`
  const messageCountDifference =
    conversation !== null &&
    currentLiveState !== null &&
    pageMessageCount > 0 &&
    pageMessageCount !== localMessageCount
      ? pageMessageCount > localMessageCount
        ? `网页 ${pageMessageCount} 条 · 本地 ${localMessageCount} 条，等待同步`
        : `网页当前显示 ${pageMessageCount} 条 · 本地 ${localMessageCount} 条${conversation.pendingCapture ? '（待补全）' : ''}`
      : null
  const conversationSavesImages = conversation === null
    ? saveImagesOnFirstCapture ?? settings?.saveImages ?? true
    : conversation.imageAttachmentPermission ?? settings?.saveImages ?? true
  const fileSavingGloballyEnabled =
    settings?.fileSavePolicy === 'per-conversation'
  const attachmentRefreshPending =
    pendingAttachmentRefresh.images || pendingAttachmentRefresh.files
  const pinnedPolicySummary = !autoSaveEnabled
    ? '当前平台自动保存未开启'
    : settings?.autoSavePinnedOnly !== true
      ? '首次收录不限制置顶状态'
      : currentLiveState?.pinnedEvidence === true
        ? '已检测到网站置顶，可自动收录'
        : conversation !== null
          ? '本地已有副本，内容变化后自动更新'
          : '首次自动收录需要网站置顶，也可手动采集'
  const awaitingConfirmation = networkStatus?.phase === 'awaiting-confirmation'
  const networkPartial = networkStatus?.phase === 'complete' && (networkStatus.failedAttachmentCount ?? 0) > 0
  const networkNotice = networkStatus && <CaptureNotice
    tone={networkStatus.phase === 'failed' ? 'error' : awaitingConfirmation || networkStatus.phase === 'partial' || networkPartial ? 'warning' : networkStatus.phase === 'complete' ? 'success' : 'info'}
    title={awaitingConfirmation ? '采集异常 · 等待确认' : networkStatus.operation === 'save' ? networkStatus.phase === 'partial' ? '本次结果已处理' : networkPartial ? '正文已保存 · 部分附件未复制' : networkStatus.phase === 'complete' ? '接口采集已保存' : '接口采集' : networkStatus.phase === 'verified' ? '响应读取验证通过' : '接口连接验证 · 本次不保存'}
    message={networkStatus.message}
    details={`${networkStatus.issue ? `${networkStatus.issue}\n` : ''}${networkStatus.message}\n已读 ${networkStatus.responseCount} 个响应、${(networkStatus.responseBytes / 1048576).toFixed(2)} MiB；最大响应 ${(networkStatus.largestResponseBytes / 1048576).toFixed(2)} MiB。${awaitingConfirmation || networkStatus.phase === 'partial' ? '异常内容不会自动保存。确认后标记待补全，保留已有正文和附件；本次不复制新附件。候选仅在本次后台会话中保留，扩展重启后需重新采集。' : networkStatus.operation === 'save' ? '正文依据后台分页链或分支树核对，附件另行确认。' : '仅验证读取能力，不代表分页完整或对话已保存。'}`} />

  const hasContext = context.platform !== null && context.conversationId !== null
  const captureHint = saveMethod === 'network'
    ? usesShare ? '读取分享页接口，核对后保存到原对话。' : '页面空闲时刷新一次，随后自动滑动读取并核对。'
    : usesShare ? '自动滑动分享页并补入原对话；需要时打开采集页。'
      : '自动滑动读取历史，核对后停留在对话顶部。'
  const attachmentDisabled = busy || loading || networkActive || shareActive
  const canOpenShare = networkActive
    ? networkControllable && networkStatus?.mode === 'share' && !awaitingConfirmation
    : !!shareStatus && ['loading', 'scanning', 'needs-foreground'].includes(shareStatus.phase)
  const needsForeground = networkActive ? networkStatus?.phase === 'needs-foreground' : shareStatus?.phase === 'needs-foreground'
  const cancelShare = (): void => {
    cancelHostShareCapture()
    if (shareStatus && context.conversationId) void shareCaptureAction(context.conversationId, 'cancel', shareStatus.id)
      .then((response) => setShareStatus(response.status)).catch(() => setError('取消采集失败，请重试'))
  }

  return (
    <div className="panel-app current-controller-app">
      <Header
        title={hasContext ? displayedTitle : '当前对话'}
        showTitle={!hasContext}
        onClose={closeHostPanel}
        locked={locked}
        onToggleLock={() => {
          const nextLocked = !locked
          setLocked(nextLocked)
          setHostPanelLocked(nextLocked)
        }}
        action={<button className="controller-manager-button" type="button"
          title={conversation ? '在 Manager 查看这条对话' : '打开对话库'}
          onClick={() => void openManager(conversation?.id).catch(() => setError('无法打开 Manager'))}>Manager ↗</button>}
      />
      {hasContext && <section className="controller-identity" aria-label="当前对话信息">
        <h1 className="controller-conversation-title" title={displayedTitle}>{displayedTitle}</h1>
        <div className="controller-identity-meta">
          <span>{PLATFORM_LABELS[context.platform!]}</span>
          <span className={conversation?.pendingCapture ? 'capture-status capture-status-pending' : conversation === null ? 'capture-status capture-status-unsaved' : 'capture-status capture-status-saved'}>
            {loading ? '读取中' : conversation?.pendingCapture ? '待补全' : conversation === null ? '未保存' : '已保存'}
          </span>
          {conversation && <button className={conversation.important ? 'controller-heading-important active' : 'controller-heading-important'}
            type="button" disabled={busy} aria-pressed={conversation.important} onClick={() => void toggleImportant()}>
            {conversation.important ? '★ 已标重要' : '☆ 标记重要'}
          </button>}
        </div>
        <p>{conversationMeta}</p>
      </section>}
      <main className="current-controller-content">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="success-banner" role="status">{notice}</div>}
        {!hasContext ? <section className="controller-empty">
          <span aria-hidden="true">◎</span>
          <strong>请先打开一条 AI 对话</strong>
          <p>支持 ChatGPT、Gemini 和 DeepSeek。</p>
        </section> : <>
          <section className="controller-card controller-capture-mode" aria-label="采集设置">
            <strong className="controller-section-title">采集对话</strong>
            {context.platform === 'chatgpt' && <>
              <div id="conversation-capture-mode" className="controller-capture-tabs" role="tablist" aria-label="采集模式与保存方式">
                {CAPTURE_CHOICES.map(({ mode, method }, index) => <button key={`${mode}-${method}`} type="button" role="tab"
                  data-capture-mode={mode} data-save-method={method}
                  aria-selected={captureMode === mode && saveMethod === method}
                  tabIndex={captureMode === mode && saveMethod === method ? 0 : -1}
                  aria-label={`${CAPTURE_MODE_LABELS[mode]} + ${method === 'dom' ? 'DOM' : '接口'}`}
                  title={`${CAPTURE_MODE_LABELS[mode]} + ${method === 'dom' ? 'DOM' : '接口'}；选择后点击滑动采集`}
                  disabled={loading || busy || shareActive || networkActive}
                  onKeyDown={(event) => {
                    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % CAPTURE_CHOICES.length
                      : event.key === 'ArrowLeft' ? (index + CAPTURE_CHOICES.length - 1) % CAPTURE_CHOICES.length
                        : event.key === 'Home' ? 0 : event.key === 'End' ? CAPTURE_CHOICES.length - 1 : null
                    if (nextIndex === null) return
                    event.preventDefault()
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
                    const choice = CAPTURE_CHOICES[nextIndex]
                    void changeCaptureChoice(choice.mode, choice.method)
                  }}
                  onClick={() => void changeCaptureChoice(mode, method)}>
                  <span>{mode === 'conversation' ? '本对话' : '分享页'}</span>
                  <small>{method === 'dom' ? 'DOM' : '接口'}</small>
                </button>)}
              </div>
              {(usesShare || shareActive) && <div className="controller-share-capture">
                <label htmlFor="share-capture-url">整条对话的分享链接</label>
                <input id="share-capture-url" type="url" maxLength={256} placeholder="https://chatgpt.com/share/…"
                  value={shareUrl} disabled={busy || shareActive || networkActive} onChange={(event) => changeShareUrl(event.target.value)} />
                <small>在网站手动更新分享后粘贴，链接仅存本机。</small>
              </div>}
            </>}
            <div className="controller-compact-permissions" role="group" aria-label="附件保存设置">
              <span>保存附件</span>
              <label title={conversation?.imageAttachmentPermission == null ? '沿用全局图片设置，可单独更改' : '本对话独立图片权限'}>
                <input type="checkbox" checked={conversationSavesImages} disabled={attachmentDisabled}
                  onChange={(event) => conversation ? void toggleImagePermission() : setSaveImagesOnFirstCapture(event.target.checked)} />
                图片
              </label>
              <label title={fileSavingGloballyEnabled ? '仅授权这条对话的普通文件' : '请先在 Manager 设置中开启普通文件保存'}>
                <input type="checkbox" checked={fileSavingGloballyEnabled && (conversation?.fileAttachmentPermission ?? saveFilesOnFirstCapture)}
                  disabled={attachmentDisabled || !fileSavingGloballyEnabled}
                  onChange={(event) => conversation ? void toggleFilePermission() : setSaveFilesOnFirstCapture(event.target.checked)} />
                文件{!fileSavingGloballyEnabled && <small>（全局关闭）</small>}
              </label>
            </div>
            {!networkActive && !shareActive && <small className="controller-method-note">{captureHint}</small>}
            {attachmentRefreshPending && <p className="controller-inline-note" role="status">附件设置已更改，下次采集将补齐可读取的历史附件。</p>}
          </section>

          {captureBlockers.length > 0 && <CaptureNotice tone="warning" title="暂未开始采集"
            message={`${CAPTURE_BLOCKERS[captureBlockers[0]].short}${captureBlockers.length > 1 ? `（另 ${captureBlockers.length - 1} 项）` : ''}`}
            details={captureBlockers.map((blocker) => CAPTURE_BLOCKERS[blocker].detail).join('\n')} />}

          {networkStatus && (networkActive
            ? <section className="controller-network-task" aria-label="接口采集状态" aria-live="polite">
              {networkNotice}
              {awaitingConfirmation && networkStatus.issue && <p className="controller-review-reason">{networkStatus.issue}</p>}
              {awaitingConfirmation && <p className="controller-inline-note">确认后保留已有正文和附件；新取得的内容标记为待补全，本次不复制新附件。</p>}
              {!networkControllable && <p className="controller-inline-note">本对话正在其他标签页采集，请在发起页查看或取消。</p>}
            </section>
            : <details className="controller-capture-history" key={networkStatus.id}>
              <summary>上次接口{networkStatus.operation === 'save' ? '采集' : '验证'} · {networkPartial ? '部分附件未复制' : networkStatus.phase === 'partial' ? conversation?.pendingCapture ? '待补全' : '结果已处理' : networkStatus.phase === 'complete' ? '已保存' : networkStatus.phase === 'verified' ? '读取通过' : networkStatus.phase === 'failed' ? '已中断' : '已取消'}</summary>
              {networkNotice}
            </details>)}

          {(manualShareSaving || shareStatus) && <section className="controller-share-task" aria-label="分享页采集状态">
            <ShareCaptureProgress status={shareStatus} />
          </section>}

          {conversation?.pendingCapture && !awaitingConfirmation && <section className="controller-pending-card" role="status">
            <strong>这条对话待补全</strong>
            <p>{conversation.pendingCapture.reason}</p>
            <small>可选择本对话 DOM 重新采集，或更新整条对话分享后，用分享页 DOM／接口补全。完整核对通过后才清除此标记。</small>
          </section>}

          <section className="controller-observation" aria-label="当前网页状态">
            <div className="controller-observation-line">
              <span className={autoSaveEnabled ? 'status-dot active' : 'status-dot'} />
              <span>{networkActive ? awaitingConfirmation ? '等待处理本次结果' : '采集中，自动更新暂缓' : autoSaveEnabled ? SYNC_STATUS_LABELS[currentLiveState?.syncStatus ?? 'observing'] : '自动保存未开启'}</span>
              <small>{currentLiveState?.lastSyncedAt ? formatSyncTime(currentLiveState.lastSyncedAt) : ''}</small>
            </div>
            <p>{pinnedPolicySummary}</p>
            <small>{currentLiveState?.pinnedEvidence ? '网站已置顶' : '未检测到网站置顶'}</small>
            {messageCountDifference && <p className="controller-live-difference">{messageCountDifference}</p>}
          </section>

          {currentLiveState !== null && currentLiveState.recentMessages.length > 0 && <section className="controller-recent" aria-label="网页最近内容">
            <h2>网页最近内容</h2>
            <div className="controller-live-messages">
              {currentLiveState.recentMessages.map((message, index) => <article key={`${message.role}-${index}`}>
                <strong>{message.role === 'user' ? '你' : PLATFORM_LABELS[context.platform!]}</strong>
                <p>{message.content}</p>
              </article>)}
            </div>
          </section>}
        </>}
      </main>
      {hasContext && <footer className="controller-action-bar" aria-label="当前采集操作">
        {awaitingConfirmation ? <>
          <p>{networkControllable ? `尚未保存 · ${networkStatus.candidateCount ?? 0} 条候选消息` : '请在发起页处理本次结果'}</p>
          {networkControllable && <div className="capture-task-actions">
            <button type="button" className="controller-secondary-button" disabled={busy} onClick={() => void controlNetworkCapture('cancel')}>取消</button>
            <button type="button" className="controller-primary-button" disabled={busy || !networkStatus.candidateCount}
              onClick={() => void controlNetworkCapture('confirm')}>{busy ? '正在处理…' : '确认保存为待补全'}</button>
          </div>}
        </> : networkActive || shareActive || manualShareSaving ? <>
          <p>{networkActive && !networkControllable ? '采集由其他标签页发起' : needsForeground ? '请保持分享采集页可见，采集会自动继续' : '正在采集对话…'}</p>
          {(networkControllable || !networkActive) && <div className="capture-task-actions">
            {canOpenShare && <button type="button" className={needsForeground ? 'controller-primary-button' : 'controller-share-button'} disabled={networkActive && busy}
              onClick={() => {
                if (networkActive) void controlNetworkCapture('open')
                else if (shareStatus) void shareCaptureAction(context.conversationId!, 'open', shareStatus.id).catch(() => setError('无法打开采集页'))
              }}>打开分享页 ↗</button>}
            {networkActive && networkStatus?.operation !== 'save' && <button type="button" className="controller-share-button" disabled={busy || networkStatus?.phase !== 'reading'}
              onClick={() => void controlNetworkCapture('finish')}>结束验证</button>}
            <button type="button" className="controller-secondary-button" disabled={busy && !manualShareSaving}
              onClick={() => networkActive ? void controlNetworkCapture('cancel') : cancelShare()}>取消采集</button>
          </div>}
        </> : <button className="controller-primary-button" type="button" disabled={busy || loading} onClick={() => void manualSave()}>
          {manualSaving ? '正在读取完整对话…' : context.platform === 'chatgpt' ? conversation?.pendingCapture ? '滑动采集并补全' : '滑动采集' : conversation ? attachmentRefreshPending ? '更新并补齐附件' : '更新本地副本' : '保存当前对话'}
        </button>}
      </footer>}
    </div>
  )
}
