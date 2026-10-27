import type {
  Account,
  AppSettings,
  Conversation,
  ConversationExclusion,
  ConversationPage,
  ConversationQuery,
  ConversationStats,
  ConversationExportEnvironment,
  ExportData,
  ImportResult,
  LibraryView,
  FileSavePolicy,
  Platform,
  SharedDirectoryStatus,
  StorageUsage,
  LocalAttachmentCopy,
} from '../../shared/models'
import type {
  DisplayColorAssignments,
} from '../../shared/display-colors'
import { sendRuntimeRequest } from '../../shared/runtime-client'
import { RUNTIME_MESSAGE_TYPE } from '../../shared/runtime-messages'
import { EXTENSION_BUILD_ID } from '../../shared/build-id'
import type { ChatGPTCaptureMode, ShareCaptureResponse } from '../../shared/share-capture'
import type { ChatGPTSaveMethod, NetworkCaptureRequest, NetworkCaptureResponse } from '../../shared/network-capture'

export function setChatGPTSaveMethod(chatgptSaveMethod: ChatGPTSaveMethod): Promise<AppSettings> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS, settings: { chatgptSaveMethod } })
}

export function getConversationSaveMethod(conversationId: string): Promise<ChatGPTSaveMethod | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SAVE_METHOD, conversationId })
}

export function setConversationSaveMethod(conversationId: string, method: ChatGPTSaveMethod | null): Promise<ChatGPTSaveMethod | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_SAVE_METHOD, conversationId, method })
}

export function networkCaptureAction(conversationId: string, action: 'start' | 'status' | 'finish' | 'cancel' | 'open' | 'confirm', jobId?: string, options: Pick<NetworkCaptureRequest, 'mode' | 'shareUrl' | 'operation' | 'allowFiles' | 'saveImages'> = {}): Promise<NetworkCaptureResponse> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.NETWORK_CAPTURE, contentScriptBuildId: EXTENSION_BUILD_ID, conversationId, action, jobId, method: 'network', ...options })
}

export function setChatGPTCaptureMode(chatgptCaptureMode: ChatGPTCaptureMode): Promise<AppSettings> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS, settings: { chatgptCaptureMode } })
}

export function getConversationCaptureMode(conversationId: string): Promise<ChatGPTCaptureMode | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_CAPTURE_MODE, conversationId })
}

export function setConversationCaptureMode(conversationId: string, mode: ChatGPTCaptureMode | null): Promise<ChatGPTCaptureMode | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_CAPTURE_MODE, conversationId, mode })
}

export function shareCaptureAction(conversationId: string, action: 'status' | 'open' | 'cancel', jobId?: string): Promise<ShareCaptureResponse> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.SHARE_CAPTURE, contentScriptBuildId: EXTENSION_BUILD_ID, conversationId, action, jobId })
}

export function getConversationShareLink(conversationId: string): Promise<string | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SHARE_LINK, conversationId })
}

export function setConversationShareLink(conversationId: string, url: string | null): Promise<string | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_SHARE_LINK, conversationId, url })
}

export function getConversations(query: ConversationQuery): Promise<ConversationPage> {
  if (query.search?.trim()) {
    return sendRuntimeRequest({
      type: RUNTIME_MESSAGE_TYPE.SEARCH_CONVERSATIONS,
      query: { ...query, search: query.search.trim() },
    })
  }
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATIONS, query })
}

export function getConversation(id: string): Promise<Conversation | null> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATION, id })
}

export function supplementConversationAttachment(id: string, attachmentId: string, file: LocalAttachmentCopy): Promise<Conversation> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.SUPPLEMENT_LOCAL_ATTACHMENT, id, attachmentId, file })
}

export function getSavedConversation(
  platform: Platform,
  conversationId: string,
): Promise<Conversation | null> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.GET_SAVED_CONVERSATION,
    platform,
    conversationId,
  })
}

export function getStats(query: ConversationQuery): Promise<ConversationStats> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_STATS, query })
}

export function getAccounts(): Promise<Account[]> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_ACCOUNTS })
}

export function getSettings(): Promise<AppSettings> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_SETTINGS })
}

export function getLibraryView(query: ConversationQuery): Promise<LibraryView> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.GET_LIBRARY_VIEW,
    query,
  })
}

export function getSharedDirectoryStatus(): Promise<SharedDirectoryStatus> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.GET_SHARED_DIRECTORY_STATUS,
  })
}

export function getSharedConversation(
  environmentId: string,
  id: string,
): Promise<Conversation | null> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.GET_SHARED_CONVERSATION,
    environmentId,
    id,
  })
}

export function getExportEnvironments(
  environmentIds: 'all' | string[],
): Promise<ConversationExportEnvironment[]> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.GET_EXPORT_ENVIRONMENTS,
    environmentIds,
  })
}

export function setAutoSave(autoSave: boolean): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { autoSave },
  })
}

export function setAutoSavePlatforms(
  autoSavePlatforms: Platform[],
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { autoSavePlatforms },
  })
}

export function setVisibleEnvironmentIds(
  visibleEnvironmentIds: string[],
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { visibleEnvironmentIds },
  })
}

export function setAccountTagColors(
  accountTagColors: DisplayColorAssignments,
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { accountTagColors },
  })
}

export function setEnvironmentCardColors(
  environmentCardColors: DisplayColorAssignments,
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { environmentCardColors },
  })
}

export function setAutoSavePinnedOnly(
  autoSavePinnedOnly: boolean,
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { autoSavePinnedOnly },
  })
}

export function setSaveImages(saveImages: boolean): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { saveImages },
  })
}

export function setFileSavePolicy(
  fileSavePolicy: FileSavePolicy,
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { fileSavePolicy },
  })
}

export function setAttachmentMaxSizeMb(
  attachmentMaxSizeMb: number,
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { attachmentMaxSizeMb },
  })
}

export function setOverlayPanelWidth(
  overlayPanelWidth: number,
): Promise<AppSettings> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
    settings: { overlayPanelWidth },
  })
}

export function getStorageUsage(): Promise<StorageUsage> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_STORAGE_USAGE })
}

export function removeConversation(
  id: string,
): Promise<{ deleted: boolean; excluded: boolean }> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.DELETE_CONVERSATION, id })
}

export function getConversationExclusions(): Promise<ConversationExclusion[]> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_EXCLUSIONS,
  })
}

export function removeSharedConversation(
  environmentId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.DELETE_SHARED_CONVERSATION,
    environmentId,
    id,
  })
}

export function removeConversationExclusion(
  id: string,
): Promise<{ removed: boolean }> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.REMOVE_CONVERSATION_EXCLUSION,
    id,
  })
}

export function setConversationImportant(
  id: string,
  important: boolean,
): Promise<Conversation> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMPORTANCE,
    id,
    important,
  })
}

export function setConversationFileAttachmentPermission(
  id: string,
  allowed: boolean,
): Promise<Conversation> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_FILE_PERMISSION,
    id,
    allowed,
  })
}

export function setConversationImageAttachmentPermission(
  id: string,
  allowed: boolean,
): Promise<Conversation> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMAGE_PERMISSION,
    id,
    allowed,
  })
}

export function removeAllData(): Promise<{ deletedConversations: number }> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.DELETE_ALL_DATA })
}

export function renameAccount(accountId: string, label: string): Promise<Account> {
  return sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.UPDATE_ACCOUNT_LABEL,
    accountId,
    label,
  })
}

export function exportData(): Promise<ExportData> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.EXPORT_DATA })
}

export function importData(data: string): Promise<ImportResult> {
  return sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.IMPORT_DATA, data })
}

export async function openConversationUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  const supportedHosts = new Set([
    'chatgpt.com',
    'gemini.google.com',
    'chat.deepseek.com',
  ])
  if (parsed.protocol !== 'https:' || !supportedHosts.has(parsed.hostname)) {
    throw new Error('原对话地址无效')
  }
  await chrome.tabs.create({ url: parsed.href })
}

export async function openSharedDirectorySetup(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('storage.html') })
}

export async function openManager(conversationId?: string): Promise<void> {
  const url = new URL(chrome.runtime.getURL('manager.html'))
  if (conversationId) {
    url.hash = new URLSearchParams({ conversation: conversationId }).toString()
  }
  await chrome.tabs.create({ url: url.href })
}

export function downloadExport(data: ExportData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const date = new Date().toISOString().slice(0, 10)
  anchor.href = url
  anchor.download = `ai-chat-memory-${date}.json`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
