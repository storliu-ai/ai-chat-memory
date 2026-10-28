import type { DisplayColorAssignments } from './display-colors'

export const SUPPORTED_PLATFORMS = ['chatgpt', 'gemini', 'deepseek'] as const

export type Platform = (typeof SUPPORTED_PLATFORMS)[number]

export const PLATFORM_LABELS: Record<Platform, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
}

export const DEFAULT_ATTACHMENT_MAX_SIZE_MB = 10
export const MIN_ATTACHMENT_MAX_SIZE_MB = 1
export const MAX_ATTACHMENT_MAX_SIZE_MB = 10
export const DEFAULT_OVERLAY_PANEL_WIDTH = 360
export const MIN_OVERLAY_PANEL_WIDTH = 320
export const MAX_OVERLAY_PANEL_WIDTH = 960

export type AttachmentKind = 'image' | 'file'
export type AttachmentSaveStatus =
  | 'saved'
  | 'confirmation-required'
  | 'not-saved'
  | 'too-large'
  | 'unavailable'

export const FILE_SAVE_POLICIES = [
  'never',
  'per-conversation',
] as const
export type FileSavePolicy = (typeof FILE_SAVE_POLICIES)[number]

export interface ConversationAttachment {
  id: string
  name: string
  kind: AttachmentKind
  mimeType: string
  size: number | null
  status: AttachmentSaveStatus
  /** Zero-based position of the message that rendered this attachment. */
  messageIndex?: number
  /** Stable host turn identity when the platform exposes one. */
  sourceTurnId?: string
  dataUrl?: string
}

/** An explicitly selected local file, never a host-page URL. */
export interface LocalAttachmentCopy {
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

export interface ExtractedAttachmentCandidate {
  name: string
  kind: AttachmentKind
  mimeType: string | null
  size: number | null
  sourceUrl: string | null
  /** Zero-based position of the message that rendered this attachment. */
  messageIndex?: number
  /** Stable host turn identity when the platform exposes one. */
  sourceTurnId?: string
  /**
   * A data URL copied from the browser's already-decoded image element.
   * It is only a capture fallback and is never persisted separately.
   */
  renderedDataUrl?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Set only by background-verified network saves; protects full source text
   * from subsequent partial DOM observations. Explicit DOM saves may replace it. */
  contentSource?: 'network'
  /** Static network display text retained when an interactive DIL component
   * needs its currently rendered values to reconstruct the visible answer. */
  networkWidgetSource?: string
  /** Stable host turn identity, when exposed by the rendered DOM. */
  sourceTurnId?: string
  /** Stable host message identity, when exposed by the rendered DOM. */
  sourceMessageId?: string
  /** Numeric rendered-turn order used to join sparse virtual-list windows. */
  sourceOrder?: number
  /** Platform-provided message time. Capture/synchronization time is never used. */
  sentAt?: number
  /** Omitted legacy/source values retain the existing second-level display. */
  sentAtPrecision?: 'minute' | 'second'
  attachmentNames?: string[]
}

export interface PendingCapture {
  reason: string
  source: 'network' | 'page'
}

export interface Conversation {
  id: string
  platform: Platform
  accountId: string
  conversationId: string
  title: string
  url: string
  messages: ChatMessage[]
  attachments?: ConversationAttachment[]
  createdAt: number
  updatedAt: number
  messageCount: number
  contentHash: string
  pinned: boolean
  important: boolean
  /** Null inherits the global image setting; a boolean is a conversation override. */
  imageAttachmentPermission: boolean | null
  fileAttachmentPermission: boolean
  /** User-confirmed exceptional capture; only a complete recapture may clear it. */
  pendingCapture?: PendingCapture
}

export interface ConversationExclusion {
  id: string
  platform: Platform
  accountId: string
  conversationId: string
  title: string
  excludedAt: number
}

export type ConversationSaveMode = 'automatic' | 'manual'

export interface ExtractedConversation {
  /** Explicit network cross-check only; excluded from stored records and exports. */
  networkEvidence?: import('./network-capture').RenderedMessageEvidence[]
  /** Transient legacy DOM aliases for a source-bound Gemini share task. */
  domMessageAliases?: string[][]
  /** Transient evidence that this DOM window has consecutive paired slots. */
  domWindowContiguous?: boolean
  captureSkippedSourceOrders?: number[]
  platform: Platform
  conversationId: string
  title: string
  url: string
  messages: ChatMessage[]
  /**
   * Internal complete-capture coverage marker. It is not part of the persisted
   * conversation payload; any value other than true means the virtual-list
   * sweep did not verify both scroll boundaries and must not be reported as complete.
   */
  captureComplete?: boolean
  /** Diagnostic reason for a rejected complete sweep; never persisted. */
  captureIncompleteReason?: 'boundary' | 'gap'
  attachmentCandidates?: ExtractedAttachmentCandidate[]
  accountIdentifier: string | null
  accountLabel: string
}

export interface ConversationSavePayload {
  platform: Platform
  supplementOnly?: boolean
  /** Native IDs actually scanned in a complete share, before merging source windows. */
  supplementVerifiedMessageIds?: string[]
  accountId: string
  accountLabel: string
  accountSource: AccountSource
  conversationId: string
  title: string
  url: string
  messages: ChatMessage[]
  attachments?: ConversationAttachment[]
  /** A boundary-verified complete DOM sweep may replace stale partial history. */
  captureSnapshotComplete?: boolean
  /** A complete DOM sweep may authoritatively remove stale attachment metadata. */
  attachmentSnapshotComplete?: boolean
  contentHash: string
  pinned: boolean
}

export type AccountSource = 'detected' | 'manual' | 'unknown'

export interface Account {
  id: string
  platform: Platform
  label: string
  source: AccountSource
  createdAt: number
  updatedAt: number
}

export const APP_SETTINGS_KEY = 'app' as const

export interface AppSettings {
  key: typeof APP_SETTINGS_KEY
  autoSavePolicyVersion: number
  autoSave: boolean
  autoSavePlatforms: Platform[]
  autoSavePinnedOnly: boolean
  chatgptCaptureMode: import('./share-capture').ChatGPTCaptureMode
  chatgptSaveMethod: import('./network-capture').ChatGPTSaveMethod
  saveImages: boolean
  fileSavePolicy: FileSavePolicy
  attachmentMaxSizeMb: number
  overlayPanelWidth: number
  visibleEnvironmentIds: string[]
  accountTagColors: DisplayColorAssignments
  environmentCardColors: DisplayColorAssignments
}

export type AppSettingsPatch = Partial<
  Pick<
    AppSettings,
    | 'autoSave'
    | 'autoSavePlatforms'
    | 'autoSavePinnedOnly'
    | 'chatgptCaptureMode'
    | 'chatgptSaveMethod'
    | 'saveImages'
    | 'fileSavePolicy'
    | 'attachmentMaxSizeMb'
    | 'overlayPanelWidth'
    | 'visibleEnvironmentIds'
    | 'accountTagColors'
    | 'environmentCardColors'
  >
>

export interface EnvironmentSummary {
  id: string
  label: string
  createdAt: number
  updatedAt: number
  conversationCount: number
}

export type SharedDirectoryState =
  | 'disconnected'
  | 'granted'
  | 'permission-required'
  | 'unavailable'

export interface SharedDirectoryStatus {
  state: SharedDirectoryState
  rootName: string | null
  currentEnvironment: EnvironmentSummary
  otherEnvironments: EnvironmentSummary[]
  visibleEnvironmentIds: string[]
}

export interface LibraryConversation extends Conversation {
  sourceEnvironmentId: string
  sourceEnvironmentLabel: string
  sourceIsLocal: boolean
  accountLabel: string
}

export interface LibraryConversationPage {
  items: LibraryConversation[]
  total: number
  page: number
  pageSize: number
}

export interface LibraryView {
  page: LibraryConversationPage
  stats: ConversationStats
  accounts: Account[]
  filterAccounts: LibraryAccount[]
  directory: SharedDirectoryStatus
}

export interface LibraryAccount extends Account {
  sourceEnvironmentId: string
  sourceEnvironmentLabel: string
}

export interface ConversationExportEnvironment {
  environment: EnvironmentSummary
  accounts: Account[]
  conversations: Conversation[]
  sourceIsLocal: boolean
}

export interface ConversationQuery {
  page?: number
  pageSize?: number
  platform?: Platform
  accountId?: string
  sourceEnvironmentId?: string
  accountSourceEnvironmentId?: string
  updatedAfter?: number
  updatedBefore?: number
  search?: string
  important?: boolean
}

export interface ConversationPage {
  items: Conversation[]
  total: number
  page: number
  pageSize: number
}

export interface ConversationStats {
  total: number
  createdToday: number
}

export interface StorageUsage {
  bytes: number
}

export interface ExportData {
  version: 1
  exportedAt: number
  accounts: Account[]
  conversations: Conversation[]
}

export interface ImportResult {
  inserted: number
  updated: number
  unchanged: number
}
