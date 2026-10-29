import type {
  Account,
  AppSettings,
  AppSettingsPatch,
  Conversation,
  ConversationExclusion,
  ConversationPage,
  ConversationQuery,
  ConversationSavePayload,
  ConversationStats,
  ExportData,
  ImportResult,
  LibraryView,
  ConversationExportEnvironment,
  EnvironmentSummary,
  SharedDirectoryStatus,
  StorageUsage,
  Platform,
  LocalAttachmentCopy,
} from './models'

export const RUNTIME_MESSAGE_TYPE = {
  NETWORK_CAPTURE: 'NETWORK_CAPTURE',
  GET_CONVERSATION_SAVE_METHOD: 'GET_CONVERSATION_SAVE_METHOD',
  SET_CONVERSATION_SAVE_METHOD: 'SET_CONVERSATION_SAVE_METHOD',
  GET_CONVERSATION_CAPTURE_MODE: 'GET_CONVERSATION_CAPTURE_MODE',
  SET_CONVERSATION_CAPTURE_MODE: 'SET_CONVERSATION_CAPTURE_MODE',
  GET_CONVERSATION_SHARE_LINK: 'GET_CONVERSATION_SHARE_LINK',
  SET_CONVERSATION_SHARE_LINK: 'SET_CONVERSATION_SHARE_LINK',
  SHARE_CAPTURE: 'SHARE_CAPTURE',
  CHECK_CAPTURE_READINESS: 'CHECK_CAPTURE_READINESS',
  SAVE_CONVERSATION: 'SAVE_CONVERSATION',
  GET_CONVERSATIONS: 'GET_CONVERSATIONS',
  GET_CONVERSATION: 'GET_CONVERSATION',
  GET_SAVED_CONVERSATION: 'GET_SAVED_CONVERSATION',
  HAS_SAVED_CONVERSATION: 'HAS_SAVED_CONVERSATION',
  SEARCH_CONVERSATIONS: 'SEARCH_CONVERSATIONS',
  GET_STATS: 'GET_STATS',
  GET_STORAGE_USAGE: 'GET_STORAGE_USAGE',
  DELETE_CONVERSATION: 'DELETE_CONVERSATION',
  GET_CONVERSATION_EXCLUSIONS: 'GET_CONVERSATION_EXCLUSIONS',
  REMOVE_CONVERSATION_EXCLUSION: 'REMOVE_CONVERSATION_EXCLUSION',
  UPDATE_CONVERSATION_IMPORTANCE: 'UPDATE_CONVERSATION_IMPORTANCE',
  UPDATE_CONVERSATION_PINNED: 'UPDATE_CONVERSATION_PINNED',
  UPDATE_CONVERSATION_IMAGE_PERMISSION: 'UPDATE_CONVERSATION_IMAGE_PERMISSION',
  UPDATE_CONVERSATION_FILE_PERMISSION: 'UPDATE_CONVERSATION_FILE_PERMISSION',
  SUPPLEMENT_LOCAL_ATTACHMENT: 'SUPPLEMENT_LOCAL_ATTACHMENT',
  DELETE_ALL_DATA: 'DELETE_ALL_DATA',
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  GET_ACCOUNTS: 'GET_ACCOUNTS',
  SYNC_DETECTED_ACCOUNT_LABEL: 'SYNC_DETECTED_ACCOUNT_LABEL',
  UPDATE_ACCOUNT_LABEL: 'UPDATE_ACCOUNT_LABEL',
  EXPORT_DATA: 'EXPORT_DATA',
  IMPORT_DATA: 'IMPORT_DATA',
  GET_LIBRARY_VIEW: 'GET_LIBRARY_VIEW',
  GET_SHARED_DIRECTORY_STATUS: 'GET_SHARED_DIRECTORY_STATUS',
  GET_SHARED_CONVERSATION: 'GET_SHARED_CONVERSATION',
  DELETE_SHARED_CONVERSATION: 'DELETE_SHARED_CONVERSATION',
  GET_EXPORT_ENVIRONMENTS: 'GET_EXPORT_ENVIRONMENTS',
  UPDATE_ENVIRONMENT_LABEL: 'UPDATE_ENVIRONMENT_LABEL',
  READ_REMOTE_IMAGE: 'READ_REMOTE_IMAGE',
} as const

export type CaptureReadinessReason =
  | 'version-mismatch'
  | 'package-unavailable'

export type CaptureReadiness =
  | { ready: true }
  | { ready: false; reason: CaptureReadinessReason }

export type RuntimeMessageType =
  (typeof RUNTIME_MESSAGE_TYPE)[keyof typeof RUNTIME_MESSAGE_TYPE]

export type RuntimeRequest =
  | import('./network-capture').NetworkCaptureRequest
  | { type: typeof RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SAVE_METHOD; conversationId: string; platform?: import('./network-capture').NetworkCapturePlatform }
  | { type: typeof RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_SAVE_METHOD; conversationId: string; method: import('./network-capture').ChatGPTSaveMethod | null; platform?: import('./network-capture').NetworkCapturePlatform }
  | { type: typeof RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_SHARE_LINK; conversationId: string; platform?: import('./network-capture').NetworkCapturePlatform }
  | { type: typeof RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_SHARE_LINK; conversationId: string; url: string | null; platform?: import('./network-capture').NetworkCapturePlatform }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_CAPTURE_MODE
      conversationId: string
      platform?: import('./network-capture').NetworkCapturePlatform
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.SET_CONVERSATION_CAPTURE_MODE
      conversationId: string
      platform?: import('./network-capture').NetworkCapturePlatform
      mode: import('./share-capture').ChatGPTCaptureMode | null
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.SHARE_CAPTURE
      platform?: import('./network-capture').NetworkCapturePlatform
      action: 'start' | 'status' | 'claim' | 'progress' | 'finish' | 'release' | 'open' | 'cancel' | 'return'
      contentScriptBuildId: string
      conversationId?: string
      jobId?: string
      shareUrl?: string
      sourceMessages?: import('./models').ChatMessage[]
      capture?: import('./models').ExtractedConversation
      phase?: 'scanning' | 'needs-foreground'
      messageCount?: number
      progress?: number
      error?: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS
      contentScriptBuildId: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.SAVE_CONVERSATION
      conversation: ConversationSavePayload
      saveMode?: 'automatic' | 'manual'
      contentScriptBuildId: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_CONVERSATIONS
      query?: ConversationQuery
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_CONVERSATION
      id: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_SAVED_CONVERSATION
      platform: Platform
      conversationId: string
      accountId?: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.HAS_SAVED_CONVERSATION
      platform: Platform
      conversationId: string
      accountId?: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.SEARCH_CONVERSATIONS
      query: ConversationQuery & { search: string }
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_STATS
      query?: ConversationQuery
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_STORAGE_USAGE
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.DELETE_CONVERSATION
      id: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_CONVERSATION_EXCLUSIONS
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.REMOVE_CONVERSATION_EXCLUSION
      id: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMPORTANCE
      id: string
      important: boolean
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_PINNED
      platform: Platform
      accountId: string
      conversationId: string
      pinned: boolean
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_IMAGE_PERMISSION
      id: string
      allowed: boolean
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_FILE_PERMISSION
      id: string
      allowed: boolean
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.SUPPLEMENT_LOCAL_ATTACHMENT
      id: string
      attachmentId: string
      file: LocalAttachmentCopy
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.DELETE_ALL_DATA
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_SETTINGS
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS
      settings: AppSettingsPatch
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_ACCOUNTS
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.SYNC_DETECTED_ACCOUNT_LABEL
      platform: Platform
      accountId: string
      label: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_ACCOUNT_LABEL
      accountId: string
      label: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.EXPORT_DATA
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.IMPORT_DATA
      data: unknown
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_LIBRARY_VIEW
      query?: ConversationQuery
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_SHARED_DIRECTORY_STATUS
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_SHARED_CONVERSATION
      environmentId: string
      id: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.DELETE_SHARED_CONVERSATION
      environmentId: string
      id: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.GET_EXPORT_ENVIRONMENTS
      environmentIds: 'all' | string[]
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.UPDATE_ENVIRONMENT_LABEL
      label: string
    }
  | {
      type: typeof RUNTIME_MESSAGE_TYPE.READ_REMOTE_IMAGE
      sourceUrl: string
      maximumBytes: number
    }

export interface RuntimeResponseDataMap {
  NETWORK_CAPTURE: import('./network-capture').NetworkCaptureResponse
  GET_CONVERSATION_SAVE_METHOD: import('./network-capture').ChatGPTSaveMethod | null
  SET_CONVERSATION_SAVE_METHOD: import('./network-capture').ChatGPTSaveMethod | null
  GET_CONVERSATION_SHARE_LINK: string | null
  SET_CONVERSATION_SHARE_LINK: string | null
  GET_CONVERSATION_CAPTURE_MODE: import('./share-capture').ChatGPTCaptureMode | null
  SET_CONVERSATION_CAPTURE_MODE: import('./share-capture').ChatGPTCaptureMode | null
  SHARE_CAPTURE: import('./share-capture').ShareCaptureResponse
  CHECK_CAPTURE_READINESS: CaptureReadiness
  SAVE_CONVERSATION: Conversation | null
  GET_CONVERSATIONS: ConversationPage
  GET_CONVERSATION: Conversation | null
  GET_SAVED_CONVERSATION: Conversation | null
  HAS_SAVED_CONVERSATION: boolean
  SEARCH_CONVERSATIONS: ConversationPage
  GET_STATS: ConversationStats
  GET_STORAGE_USAGE: StorageUsage
  DELETE_CONVERSATION: { deleted: boolean; excluded: boolean }
  GET_CONVERSATION_EXCLUSIONS: ConversationExclusion[]
  REMOVE_CONVERSATION_EXCLUSION: { removed: boolean }
  UPDATE_CONVERSATION_IMPORTANCE: Conversation
  UPDATE_CONVERSATION_PINNED: Conversation[]
  UPDATE_CONVERSATION_IMAGE_PERMISSION: Conversation
  UPDATE_CONVERSATION_FILE_PERMISSION: Conversation
  SUPPLEMENT_LOCAL_ATTACHMENT: Conversation
  DELETE_ALL_DATA: { deletedConversations: number }
  GET_SETTINGS: AppSettings
  UPDATE_SETTINGS: AppSettings
  GET_ACCOUNTS: Account[]
  SYNC_DETECTED_ACCOUNT_LABEL: Account | null
  UPDATE_ACCOUNT_LABEL: Account
  EXPORT_DATA: ExportData
  IMPORT_DATA: ImportResult
  GET_LIBRARY_VIEW: LibraryView
  GET_SHARED_DIRECTORY_STATUS: SharedDirectoryStatus
  GET_SHARED_CONVERSATION: Conversation | null
  DELETE_SHARED_CONVERSATION: { deleted: boolean }
  GET_EXPORT_ENVIRONMENTS: ConversationExportEnvironment[]
  UPDATE_ENVIRONMENT_LABEL: EnvironmentSummary
  READ_REMOTE_IMAGE: {
    dataUrl: string
    mimeType: string
    size: number
  } | null
}

export type RuntimeErrorCode =
  | 'INVALID_REQUEST'
  | 'EXTENSION_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'IMPORT_ERROR'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR'

export interface RuntimeError {
  code: RuntimeErrorCode
  message: string
}

export type RuntimeResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: RuntimeError }

export type RuntimeResponseFor<T extends RuntimeRequest> = RuntimeResponse<
  RuntimeResponseDataMap[T['type']]
>

const RUNTIME_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.values(RUNTIME_MESSAGE_TYPE),
)

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && RUNTIME_MESSAGE_TYPES.has(type)
}

export function runtimeSuccess<T>(data: T): RuntimeResponse<T> {
  return { ok: true, data }
}

export function runtimeFailure(
  code: RuntimeErrorCode,
  message: string,
): RuntimeResponse<never> {
  return { ok: false, error: { code, message } }
}
