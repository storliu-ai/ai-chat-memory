import { getSettings, initializeSettings, updateSettings } from '../db/settings'
import { getConversationCaptureMode, setConversationCaptureMode, getConversationShareLink, setConversationShareLink, getConversationSaveMethod, setConversationSaveMethod } from '../db/conversation-capture-modes'
import { cancelNetworkCaptureJobs, handleNetworkCapture, handleNetworkTabNavigated, handleNetworkTabRemoved, initializeNetworkCaptureJobs, isNetworkSavePaused } from './network-capture-coordinator'
import {
  deleteConversationExclusion,
  getConversationExclusions,
} from '../db/conversation-exclusions'
import { getLocalEnvironment } from '../db/environment'
import {
  MAX_ATTACHMENT_MAX_SIZE_MB,
  MAX_OVERLAY_PANEL_WIDTH,
  MIN_ATTACHMENT_MAX_SIZE_MB,
  MIN_OVERLAY_PANEL_WIDTH,
  SUPPORTED_PLATFORMS,
  type AppSettingsPatch,
} from '../shared/models'
import { isEnvironmentId } from '../shared/environments'
import {
  hasCanonicalDisplayColorAssignments,
  normalizeDisplayColorAssignments,
} from '../shared/display-colors'
import {
  isRuntimeRequest,
  RUNTIME_MESSAGE_TYPE,
  runtimeFailure,
  runtimeSuccess,
  type RuntimeRequest,
  type RuntimeResponse,
} from '../shared/runtime-messages'
import {
  listAccounts,
  syncDetectedAccountLabel,
  updateAccountLabel,
} from '../services/account-service'
import {
  deleteConversation,
  getConversationById,
  getSavedConversationBySource,
  getConversationStats,
  getConversationStorageUsage,
  hasSavedConversation,
  listConversations,
  saveConversation,
  updateConversationImportance,
  updateConversationPinnedBySource,
  updateConversationImageAttachmentPermission,
  updateConversationFileAttachmentPermission,
} from '../services/conversation-service'
import {
  deleteAllData,
  exportAllData,
  importAllData,
} from '../services/data-management-service'
import { ImportValidationError, NotFoundError } from '../services/errors'
import {
  isConversationQuery,
  isConversationSavePayload,
  isFileSavePolicy,
} from '../services/validation'
import { Logger } from '../utils/logger'
import {
  CONTENT_EVENT_SOURCE,
  type ConversationDeletedContentEvent,
} from '../shared/content-events'
import { getLibraryView } from '../services/library-service'
import { canonicalizeChatGPTAccountData } from '../services/chatgpt-account-migration'
import { migrateImportantOnlyFilePermissions } from '../services/file-permission-migration'
import {
  applyPendingSharedDeletions,
  deleteSharedConversation,
  getSharedDirectoryStatus,
  readExportEnvironments,
  getVisibleSharedConversation,
  mirrorLocalAccounts,
  mirrorLocalConversation,
  removeMirroredConversation,
  synchronizeLocalEnvironment,
  updateEnvironmentLabelAndMirror,
} from '../services/shared-directory-service'
import { readPermittedRemoteImage } from './remote-image-reader'
import { MAX_ATTACHMENT_BINARY_BYTES } from '../shared/attachments'
import { isLocalAttachmentCopy } from '../shared/local-attachments'
import { supplementLocalAttachment } from '../services/local-attachment-service'
import { isPermittedRemoteImageUrl } from '../shared/remote-images'
import { getCaptureReadiness } from './runtime-readiness'
import { cancelShareCaptureJobs, handleShareCapture, handleShareTabNavigated, handleShareTabRemoved, initializeShareCaptureJobs, isShareSaveAuthorized } from './share-capture-coordinator'
import {
  EXTENSION_EVENT_SOURCE,
  type ConversationUpdatedExtensionEvent,
} from '../shared/extension-events'

function isAppSettingsPatch(value: unknown): value is AppSettingsPatch {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const autoSave = (value as { autoSave?: unknown }).autoSave
  const autoSavePlatforms = (value as { autoSavePlatforms?: unknown })
    .autoSavePlatforms
  const autoSavePinnedOnly = (value as { autoSavePinnedOnly?: unknown })
    .autoSavePinnedOnly
  const saveImages = (value as { saveImages?: unknown }).saveImages
  const fileSavePolicy = (value as { fileSavePolicy?: unknown }).fileSavePolicy
  const attachmentMaxSizeMb = (value as { attachmentMaxSizeMb?: unknown })
    .attachmentMaxSizeMb
  const overlayPanelWidth = (value as { overlayPanelWidth?: unknown })
    .overlayPanelWidth
  const visibleEnvironmentIds = (value as { visibleEnvironmentIds?: unknown })
    .visibleEnvironmentIds
  const accountTagColors = (value as { accountTagColors?: unknown })
    .accountTagColors
  const environmentCardColors = (value as { environmentCardColors?: unknown })
    .environmentCardColors
  const validAutoSavePlatforms =
    autoSavePlatforms === undefined ||
    (Array.isArray(autoSavePlatforms) &&
      autoSavePlatforms.length <= SUPPORTED_PLATFORMS.length &&
      autoSavePlatforms.every(
        (platform) =>
          typeof platform === 'string' &&
          SUPPORTED_PLATFORMS.includes(platform as (typeof SUPPORTED_PLATFORMS)[number]),
      ) &&
      new Set(autoSavePlatforms).size === autoSavePlatforms.length)
  const normalizedAccountTagColors = normalizeDisplayColorAssignments(
    accountTagColors,
    (key) => key.trim() !== '' && key.length <= 128,
    500,
  )
  const validAccountTagColors = accountTagColors === undefined ||
    hasCanonicalDisplayColorAssignments(
      accountTagColors,
      normalizedAccountTagColors,
    )
  const normalizedEnvironmentCardColors = normalizeDisplayColorAssignments(
    environmentCardColors,
    isEnvironmentId,
    100,
  )
  const validEnvironmentCardColors = environmentCardColors === undefined ||
    hasCanonicalDisplayColorAssignments(
      environmentCardColors,
      normalizedEnvironmentCardColors,
    )
  return (
    ((value as AppSettingsPatch).chatgptCaptureMode === undefined || ['conversation', 'share'].includes((value as AppSettingsPatch).chatgptCaptureMode!)) &&
    ((value as AppSettingsPatch).chatgptSaveMethod === undefined || ['dom', 'network'].includes((value as AppSettingsPatch).chatgptSaveMethod!)) &&
    (autoSave === undefined || typeof autoSave === 'boolean') &&
    validAutoSavePlatforms &&
    (autoSavePinnedOnly === undefined || typeof autoSavePinnedOnly === 'boolean') &&
    (saveImages === undefined || typeof saveImages === 'boolean') &&
    (fileSavePolicy === undefined || isFileSavePolicy(fileSavePolicy)) &&
    (attachmentMaxSizeMb === undefined ||
      (Number.isInteger(attachmentMaxSizeMb) &&
        Number(attachmentMaxSizeMb) >= MIN_ATTACHMENT_MAX_SIZE_MB &&
        Number(attachmentMaxSizeMb) <= MAX_ATTACHMENT_MAX_SIZE_MB)) &&
    (overlayPanelWidth === undefined ||
      (Number.isInteger(overlayPanelWidth) &&
        Number(overlayPanelWidth) >= MIN_OVERLAY_PANEL_WIDTH &&
        Number(overlayPanelWidth) <= MAX_OVERLAY_PANEL_WIDTH)) &&
    (visibleEnvironmentIds === undefined ||
      (Array.isArray(visibleEnvironmentIds) &&
        visibleEnvironmentIds.length <= 100 &&
        visibleEnvironmentIds.every(isEnvironmentId) &&
        new Set(visibleEnvironmentIds).size === visibleEnvironmentIds.length)) &&
    validAccountTagColors &&
    validEnvironmentCardColors
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

async function mirrorSafely(
  label: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation()
  } catch (error: unknown) {
    Logger.warn(`Shared directory mirror skipped: ${label}`, error)
  }
}

async function notifyConversationDeleted(
  event: Omit<ConversationDeletedContentEvent, 'source' | 'type'>,
): Promise<void> {
  if (event.platform === 'chatgpt') await cancelShareCaptureJobs(event.conversationId)
  if (event.platform === 'chatgpt') await cancelNetworkCaptureJobs(event.conversationId)
  try {
    const tabs = await chrome.tabs.query({})
    const message: ConversationDeletedContentEvent = {
      source: CONTENT_EVENT_SOURCE,
      type: 'CONVERSATION_DELETED',
      ...event,
    }
    await Promise.allSettled(
      tabs.flatMap((tab) =>
        tab.id === undefined
          ? []
          : [chrome.tabs.sendMessage(tab.id, message)],
      ),
    )
  } catch (error: unknown) {
    Logger.warn('Deleted conversation cache notification was skipped', error)
  }
}

function notifyConversationUpdated(conversationId: string): void {
  const message: ConversationUpdatedExtensionEvent = {
    source: EXTENSION_EVENT_SOURCE,
    type: 'CONVERSATION_UPDATED',
    conversationId,
  }
  void chrome.runtime.sendMessage(message).catch(() => undefined)
}

async function dispatchRuntimeRequest(
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<RuntimeResponse<unknown>> {
  switch (request.type) {
    case RUNTIME_MESSAGE_TYPE.NETWORK_CAPTURE:
      if (typeof request.contentScriptBuildId !== 'string' || !(await getCaptureReadiness(request.contentScriptBuildId)).ready) return runtimeFailure('EXTENSION_UNAVAILABLE', '请刷新原对话后重试接口验证')
      try {
        const response = await handleNetworkCapture(request, sender)
        if (request.action === 'commit' || request.action === 'attachments' || request.action === 'confirm') {
          const saved = request.conversationId ? await getSavedConversationBySource('chatgpt', request.conversationId) : response.status ? await getSavedConversationBySource('chatgpt', response.status.conversationId) : null
          if (saved) {
            await mirrorSafely('network capture', async () => { await mirrorLocalConversation(saved); await mirrorLocalAccounts() })
            notifyConversationUpdated(saved.id)
          }
        }
        return runtimeSuccess(response)
      }
      catch (error: unknown) { return runtimeFailure('INVALID_REQUEST', error instanceof Error ? error.message : '接口验证失败') }
    case RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SAVE_METHOD:
    case RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_SAVE_METHOD:
      if (!isNonEmptyString(request.conversationId) || request.conversationId.length > 256) return runtimeFailure('INVALID_REQUEST', 'Conversation ID is required')
      if (request.type === RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SAVE_METHOD) return runtimeSuccess(await getConversationSaveMethod(request.conversationId))
      if (isNetworkSavePaused('chatgpt', request.conversationId)) return runtimeFailure('INVALID_REQUEST', '请结束验证后再切换保存方式')
      if (request.method !== null && request.method !== 'dom' && request.method !== 'network') return runtimeFailure('INVALID_REQUEST', 'Invalid save method')
      return runtimeSuccess(await setConversationSaveMethod(request.conversationId, request.method))
    case RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SHARE_LINK:
    case RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_SHARE_LINK:
      if (!isNonEmptyString(request.conversationId) || request.conversationId.length > 256) return runtimeFailure('INVALID_REQUEST', 'Conversation ID is required')
      if (request.type === RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SHARE_LINK) return runtimeSuccess(await getConversationShareLink(request.conversationId))
      try { return runtimeSuccess(await setConversationShareLink(request.conversationId, request.url)) }
      catch { return runtimeFailure('INVALID_REQUEST', '分享链接格式无效或保存失败') }
    case RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_CAPTURE_MODE:
    case RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_CAPTURE_MODE:
      if (!isNonEmptyString(request.conversationId) || request.conversationId.length > 256) {
        return runtimeFailure('INVALID_REQUEST', 'Conversation ID is required')
      }
      if (request.type === RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_CAPTURE_MODE) {
        return runtimeSuccess(await getConversationCaptureMode(request.conversationId))
      }
      if (isNetworkSavePaused('chatgpt', request.conversationId)) return runtimeFailure('INVALID_REQUEST', '请结束验证后再切换采集模式')
      if (request.mode !== null && request.mode !== 'conversation' && request.mode !== 'share') {
        return runtimeFailure('INVALID_REQUEST', 'Invalid capture mode')
      }
      return runtimeSuccess(await setConversationCaptureMode(request.conversationId, request.mode))

    case RUNTIME_MESSAGE_TYPE.SHARE_CAPTURE: {
      if (request.action === 'start' && isNetworkSavePaused('chatgpt', request.conversationId ?? '')) return runtimeFailure('INVALID_REQUEST', '请先结束接口验证')
      if (typeof request.contentScriptBuildId !== 'string' || !(await getCaptureReadiness(request.contentScriptBuildId)).ready) return runtimeFailure('EXTENSION_UNAVAILABLE', '请刷新原对话后重试分享采集')
      try { return runtimeSuccess(await handleShareCapture(request, sender)) }
      catch (error: unknown) { return runtimeFailure('INVALID_REQUEST', error instanceof Error ? error.message : '分享采集失败') }
    }
    case RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS:
      if (typeof request.contentScriptBuildId !== 'string') {
        return runtimeFailure('INVALID_REQUEST', 'Invalid content-script build identity')
      }
      return runtimeSuccess(await getCaptureReadiness(
        request.contentScriptBuildId,
      ))

    case RUNTIME_MESSAGE_TYPE.SAVE_CONVERSATION:
      if (typeof request.contentScriptBuildId !== 'string') {
        return runtimeFailure('INVALID_REQUEST', 'Missing content-script build identity')
      }
      {
        const readiness = await getCaptureReadiness(request.contentScriptBuildId)
        if (!readiness.ready) {
          return runtimeFailure(
            'EXTENSION_UNAVAILABLE',
            'Extension files are updating or the page is running stale code',
          )
        }
      }
      if (!isConversationSavePayload(request.conversation)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid conversation payload')
      }
      if (isNetworkSavePaused(request.conversation.platform, request.conversation.conversationId)) return runtimeSuccess(null)
      if (request.conversation.supplementOnly && (request.saveMode !== 'manual' || request.conversation.platform !== 'chatgpt' || !await isShareSaveAuthorized(sender, request.conversation.conversationId))) return runtimeFailure('INVALID_REQUEST', '分享补全必须绑定有效的原对话采集任务')
      if (
        request.saveMode !== undefined &&
        request.saveMode !== 'automatic' &&
        request.saveMode !== 'manual'
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid conversation save mode')
      }
      {
        const result = await saveConversation(
          request.conversation,
          request.saveMode ?? 'automatic',
        )
        if (result === null) {
          return runtimeSuccess(null)
        }
        await mirrorSafely('save conversation', async () => {
          if (result.changed) {
            await mirrorLocalConversation(result.conversation)
          }
          await mirrorLocalAccounts()
        })
        // A shared deletion may arrive during the save and be consumed by the
        // mirror. Do not report that now-deleted snapshot as a successful save.
        if (await getConversationById(result.conversation.id) === null) {
          await notifyConversationDeleted({
            platform: result.conversation.platform,
            conversationId: result.conversation.conversationId,
          })
          notifyConversationUpdated(result.conversation.id)
          return runtimeSuccess(null)
        }
        if (result.changed) {
          notifyConversationUpdated(result.conversation.id)
        }
        return runtimeSuccess(result.conversation)
      }

    case RUNTIME_MESSAGE_TYPE.GET_CONVERSATIONS:
      if (!isConversationQuery(request.query)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid conversation query')
      }
      return runtimeSuccess(await listConversations(request.query))

    case RUNTIME_MESSAGE_TYPE.GET_CONVERSATION:
      if (!isNonEmptyString(request.id)) {
        return runtimeFailure('INVALID_REQUEST', 'Conversation ID is required')
      }
      return runtimeSuccess(await getConversationById(request.id))

    case RUNTIME_MESSAGE_TYPE.GET_SAVED_CONVERSATION:
      if (
        !SUPPORTED_PLATFORMS.includes(request.platform) ||
        !isNonEmptyString(request.conversationId)
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid conversation identity')
      }
      return runtimeSuccess(await getSavedConversationBySource(
        request.platform,
        request.conversationId,
      ))

    case RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION:
      if (
        !SUPPORTED_PLATFORMS.includes(request.platform) ||
        !isNonEmptyString(request.conversationId)
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid conversation identity')
      }
      return runtimeSuccess(await hasSavedConversation(
        request.platform,
        request.conversationId,
      ))

    case RUNTIME_MESSAGE_TYPE.SEARCH_CONVERSATIONS:
      if (
        request.query === undefined ||
        !isConversationQuery(request.query) ||
        typeof request.query.search !== 'string'
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid search query')
      }
      return runtimeSuccess(await listConversations(request.query))

    case RUNTIME_MESSAGE_TYPE.GET_STATS:
      if (!isConversationQuery(request.query)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid statistics query')
      }
      return runtimeSuccess(await getConversationStats(request.query))

    case RUNTIME_MESSAGE_TYPE.GET_STORAGE_USAGE:
      return runtimeSuccess(await getConversationStorageUsage())

    case RUNTIME_MESSAGE_TYPE.DELETE_CONVERSATION:
      if (!isNonEmptyString(request.id)) {
        return runtimeFailure('INVALID_REQUEST', 'Conversation ID is required')
      }
      {
        const conversation = await getConversationById(request.id)
        const result = await deleteConversation(request.id)
        if (result.deleted) {
          await mirrorSafely('delete conversation', () =>
            removeMirroredConversation(request.id),
          )
          if (conversation !== null) {
            await notifyConversationDeleted({
              platform: conversation.platform,
              conversationId: conversation.conversationId,
            })
          }
        }
        return runtimeSuccess(result)
      }

    case RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_EXCLUSIONS:
      return runtimeSuccess(await getConversationExclusions())

    case RUNTIME_MESSAGE_TYPE.REMOVE_CONVERSATION_EXCLUSION:
      if (!isNonEmptyString(request.id)) {
        return runtimeFailure('INVALID_REQUEST', 'Conversation exclusion ID is required')
      }
      return runtimeSuccess({
        removed: await deleteConversationExclusion(request.id),
      })

    case RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMPORTANCE:
      if (!isNonEmptyString(request.id) || typeof request.important !== 'boolean') {
        return runtimeFailure('INVALID_REQUEST', 'Invalid importance update')
      }
      {
        const conversation = await updateConversationImportance(
          request.id,
          request.important,
        )
        await mirrorSafely('update important mark', () =>
          mirrorLocalConversation(conversation),
        )
        notifyConversationUpdated(conversation.id)
        return runtimeSuccess(conversation)
      }

    case RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_PINNED:
      if (
        !SUPPORTED_PLATFORMS.includes(request.platform) ||
        !isNonEmptyString(request.accountId) ||
        !isNonEmptyString(request.conversationId) ||
        typeof request.pinned !== 'boolean'
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid pinned-state update')
      }
      {
        const conversations = await updateConversationPinnedBySource(
          request.platform,
          request.accountId,
          request.conversationId,
          request.pinned,
        )
        await mirrorSafely('update pinned state', async () => {
          for (const conversation of conversations) {
            await mirrorLocalConversation(conversation)
          }
        })
        for (const conversation of conversations) {
          notifyConversationUpdated(conversation.id)
        }
        return runtimeSuccess(conversations)
      }

    case RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_FILE_PERMISSION:
      if (!isNonEmptyString(request.id) || typeof request.allowed !== 'boolean') {
        return runtimeFailure('INVALID_REQUEST', 'Invalid file attachment permission')
      }
      {
        const conversation = await updateConversationFileAttachmentPermission(
          request.id,
          request.allowed,
        )
        await mirrorSafely('update file attachment permission', () =>
          mirrorLocalConversation(conversation),
        )
        notifyConversationUpdated(conversation.id)
        return runtimeSuccess(conversation)
      }

    case RUNTIME_MESSAGE_TYPE.SUPPLEMENT_LOCAL_ATTACHMENT:
      if (sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('manager.html') ||
          !isNonEmptyString(request.id) || !isNonEmptyString(request.attachmentId) || !isLocalAttachmentCopy(request.file)) {
        return runtimeFailure('INVALID_REQUEST', '本地附件补齐需要在管理页选择原始文件')
      }
      {
        const conversation = await supplementLocalAttachment(request.id, request.attachmentId, request.file)
        await mirrorSafely('supplement local attachment', () => mirrorLocalConversation(conversation))
        if (await getConversationById(conversation.id) === null) return runtimeFailure('NOT_FOUND', '对话已删除，请刷新列表')
        notifyConversationUpdated(conversation.id)
        return runtimeSuccess(conversation)
      }

    case RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMAGE_PERMISSION:
      if (!isNonEmptyString(request.id) || typeof request.allowed !== 'boolean') {
        return runtimeFailure('INVALID_REQUEST', 'Invalid image attachment permission')
      }
      {
        const conversation = await updateConversationImageAttachmentPermission(
          request.id,
          request.allowed,
        )
        await mirrorSafely('update image attachment permission', () =>
          mirrorLocalConversation(conversation),
        )
        notifyConversationUpdated(conversation.id)
        return runtimeSuccess(conversation)
      }

    case RUNTIME_MESSAGE_TYPE.DELETE_ALL_DATA:
      {
        await cancelNetworkCaptureJobs()
        await cancelShareCaptureJobs()
        const result = await deleteAllData()
        await mirrorSafely('clear local data', synchronizeLocalEnvironment)
        return runtimeSuccess(result)
      }

    case RUNTIME_MESSAGE_TYPE.GET_SETTINGS:
      return runtimeSuccess(await getSettings())

    case RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS:
      if (!isAppSettingsPatch(request.settings)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid settings payload')
      }
      return runtimeSuccess(await updateSettings(request.settings))

    case RUNTIME_MESSAGE_TYPE.GET_ACCOUNTS:
      return runtimeSuccess(await listAccounts())

    case RUNTIME_MESSAGE_TYPE.SYNC_DETECTED_ACCOUNT_LABEL:
      if (
        !SUPPORTED_PLATFORMS.includes(request.platform) ||
        !isNonEmptyString(request.accountId) ||
        !isNonEmptyString(request.label) ||
        request.label.trim().length > 100
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid detected account label')
      }
      {
        const account = await syncDetectedAccountLabel(
          request.platform,
          request.accountId,
          request.label,
        )
        if (account !== null) {
          await mirrorSafely('sync detected account label', mirrorLocalAccounts)
        }
        return runtimeSuccess(account)
      }

    case RUNTIME_MESSAGE_TYPE.UPDATE_ACCOUNT_LABEL:
      if (
        !isNonEmptyString(request.accountId) ||
        !isNonEmptyString(request.label) ||
        request.label.trim().length > 100
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid account label')
      }
      {
        const account = await updateAccountLabel(request.accountId, request.label)
        await mirrorSafely('update account label', mirrorLocalAccounts)
        return runtimeSuccess(account)
      }

    case RUNTIME_MESSAGE_TYPE.EXPORT_DATA:
      return runtimeSuccess(await exportAllData())

    case RUNTIME_MESSAGE_TYPE.IMPORT_DATA:
      {
        const result = await importAllData(request.data)
        await mirrorSafely('import data', synchronizeLocalEnvironment)
        return runtimeSuccess(result)
      }

    case RUNTIME_MESSAGE_TYPE.GET_LIBRARY_VIEW:
      if (!isConversationQuery(request.query)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid library query')
      }
      return runtimeSuccess(await getLibraryView(request.query))

    case RUNTIME_MESSAGE_TYPE.GET_SHARED_DIRECTORY_STATUS:
      return runtimeSuccess(await getSharedDirectoryStatus())

    case RUNTIME_MESSAGE_TYPE.GET_SHARED_CONVERSATION:
      if (!isEnvironmentId(request.environmentId) || !isNonEmptyString(request.id)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid shared conversation request')
      }
      return runtimeSuccess(
        await getVisibleSharedConversation(request.environmentId, request.id),
      )

    case RUNTIME_MESSAGE_TYPE.DELETE_SHARED_CONVERSATION:
      if (!isEnvironmentId(request.environmentId) ||
        typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id)) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid shared conversation request')
      }
      await deleteSharedConversation(request.environmentId, request.id)
      return runtimeSuccess({ deleted: true })

    case RUNTIME_MESSAGE_TYPE.GET_EXPORT_ENVIRONMENTS:
      if (
        request.environmentIds !== 'all' &&
        (!Array.isArray(request.environmentIds) ||
          request.environmentIds.length === 0 ||
          request.environmentIds.length > 100 ||
          request.environmentIds.some((id) => !isEnvironmentId(id)) ||
          new Set(request.environmentIds).size !== request.environmentIds.length)
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid export environment selection')
      }
      return runtimeSuccess(await readExportEnvironments(request.environmentIds))

    case RUNTIME_MESSAGE_TYPE.UPDATE_ENVIRONMENT_LABEL:
      if (!isNonEmptyString(request.label) || request.label.trim().length > 80) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid environment label')
      }
      return runtimeSuccess(await updateEnvironmentLabelAndMirror(request.label))

    case RUNTIME_MESSAGE_TYPE.READ_REMOTE_IMAGE:
      if (
        typeof request.sourceUrl !== 'string' ||
        !isPermittedRemoteImageUrl(request.sourceUrl) ||
        typeof request.maximumBytes !== 'number' ||
        !Number.isSafeInteger(request.maximumBytes) ||
        request.maximumBytes < 1 ||
        request.maximumBytes > MAX_ATTACHMENT_BINARY_BYTES
      ) {
        return runtimeFailure('INVALID_REQUEST', 'Invalid remote image request')
      }
      return runtimeSuccess(await readPermittedRemoteImage(
        request.sourceUrl,
        request.maximumBytes,
      ))
  }
}

async function handleRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse<unknown>> {
  if (!isRuntimeRequest(message)) {
    return runtimeFailure('INVALID_REQUEST', 'Unknown runtime message')
  }

  try {
    await ensureExtensionInitialized()
    if (message.type !== RUNTIME_MESSAGE_TYPE.READ_REMOTE_IMAGE &&
      message.type !== RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS &&
      !(message.type === RUNTIME_MESSAGE_TYPE.NETWORK_CAPTURE && !['start', 'commit', 'attachments', 'confirm'].includes(message.action))) {
      await receiveSharedDeletions()
    }
    return await dispatchRuntimeRequest(message, sender)
  } catch (error: unknown) {
    if (error instanceof ImportValidationError) {
      return runtimeFailure('IMPORT_ERROR', error.message)
    }
    if (error instanceof NotFoundError) {
      return runtimeFailure('NOT_FOUND', error.message)
    }
    Logger.error('Runtime message failed', error)
    return runtimeFailure('DATABASE_ERROR', 'Local data operation failed')
  }
}

async function receiveSharedDeletions(): Promise<void> {
  const deleted = await applyPendingSharedDeletions()
  for (const conversation of deleted) {
    await notifyConversationDeleted({
      platform: conversation.platform,
      conversationId: conversation.conversationId,
    })
    notifyConversationUpdated(conversation.id)
  }
}

// A local save/import cannot race the deletion acknowledgement and recreate a
// stale record. Bounded attachment reads and readiness checks do not hold this
// data-operation queue while waiting on the network.
let runtimeDataQueue: Promise<unknown> = Promise.resolve()
function enqueueRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse<unknown>> {
  if (!isRuntimeRequest(message) ||
    message.type === RUNTIME_MESSAGE_TYPE.READ_REMOTE_IMAGE ||
    message.type === RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS ||
    message.type === RUNTIME_MESSAGE_TYPE.NETWORK_CAPTURE && !['start', 'commit', 'attachments', 'confirm'].includes(message.action)) {
    return handleRuntimeMessage(message, sender)
  }
  const result = runtimeDataQueue.then(() => handleRuntimeMessage(message, sender))
  runtimeDataQueue = result.catch(() => undefined)
  return result
}

let initializationPromise: Promise<void> | null = null

function ensureExtensionInitialized(): Promise<void> {
  if (initializationPromise === null) {
    initializationPromise = (async () => {
      const filePermissionMigration = await migrateImportantOnlyFilePermissions()
      await Promise.all([initializeSettings(), getLocalEnvironment()])
      await initializeShareCaptureJobs()
      await initializeNetworkCaptureJobs()
      const accountMigration = await canonicalizeChatGPTAccountData()
      await receiveSharedDeletions()
      if (filePermissionMigration.changed || accountMigration.changed) {
        await mirrorSafely(
          'migrate local data',
          synchronizeLocalEnvironment,
        )
      }
    })().catch((error: unknown) => {
      initializationPromise = null
      throw error
    })
  }
  return initializationPromise
}

function initializeExtension(): void {
  void ensureExtensionInitialized().catch((error: unknown) => {
    Logger.error('Extension initialization failed', error)
  })
}

chrome.runtime.onInstalled.addListener(initializeExtension)
chrome.runtime.onStartup.addListener(initializeExtension)

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (response: RuntimeResponse<unknown>) => void) => {
    if (isRuntimeRequest(message) &&
      message.type === RUNTIME_MESSAGE_TYPE.DELETE_SHARED_CONVERSATION &&
      sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('manager.html')) {
      sendResponse(runtimeFailure('INVALID_REQUEST', 'Shared cleanup requires the Manager'))
      return false
    }
    void enqueueRuntimeMessage(message, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        Logger.error('Unhandled runtime message failure', error)
        sendResponse(runtimeFailure('INTERNAL_ERROR', 'Unexpected local extension error'))
      })
    return true
  },
)

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') })
})

initializeExtension()

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleNetworkTabRemoved(tabId).catch(() => undefined)
  runtimeDataQueue = runtimeDataQueue.then(() => handleShareTabRemoved(tabId)).catch(() => undefined)
})
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) void handleNetworkTabNavigated(tabId, change.url).catch(() => undefined)
  if (change.url) runtimeDataQueue = runtimeDataQueue.then(() => handleShareTabNavigated(tabId, change.url!)).catch(() => undefined)
})
