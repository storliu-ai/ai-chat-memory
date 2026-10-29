import { SUPPORTED_PLATFORMS, type Platform } from './models'

export const PANEL_MESSAGE_SOURCE = {
  PANEL: 'ai-chat-memory-panel',
  HOST: 'ai-chat-memory-host',
} as const

export const PANEL_MESSAGE_TYPE = {
  CLOSE: 'CLOSE',
  SET_LOCKED: 'SET_LOCKED',
  MANUAL_SAVE: 'MANUAL_SAVE',
  CANCEL_SHARE_CAPTURE: 'CANCEL_SHARE_CAPTURE',
  REQUEST_LIVE_STATE: 'REQUEST_LIVE_STATE',
  MANUAL_SAVE_RESULT: 'MANUAL_SAVE_RESULT',
  CONVERSATION_CONTEXT_CHANGED: 'CONVERSATION_CONTEXT_CHANGED',
  CONVERSATION_LIVE_STATE_CHANGED: 'CONVERSATION_LIVE_STATE_CHANGED',
} as const

export interface HostConversationContext {
  platform: Platform | null
  conversationId: string | null
  /** Transient rendered identity; never included in iframe URLs or persisted. */
  accountIdentifier?: string | null
}

export type ConversationSyncStatus =
  | 'observing'
  | 'pending'
  | 'saving'
  | 'synced'
  | 'error'

export interface HostConversationPreviewMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HostConversationLiveState {
  context: HostConversationContext
  pageTitle: string
  pageMessageCount: number
  recentMessages: HostConversationPreviewMessage[]
  syncStatus: ConversationSyncStatus
  pinnedEvidence: boolean
  observedAt: number
  lastSyncedAt: number | null
}

export type ManualSaveResult =
  | {
      ok: true
      conversationId: string
      verification: 'exact' | 'local-history-suffix' | 'local-history-window'
    }
  | {
      ok: false
      reason: 'not-conversation' | 'incomplete' | 'failed'
      message: string
    }

export type PanelToHostMessage =
  | { source: typeof PANEL_MESSAGE_SOURCE.PANEL; type: typeof PANEL_MESSAGE_TYPE.CANCEL_SHARE_CAPTURE }
  | {
      source: typeof PANEL_MESSAGE_SOURCE.PANEL
      type: typeof PANEL_MESSAGE_TYPE.CLOSE
    }
  | {
      source: typeof PANEL_MESSAGE_SOURCE.PANEL
      type: typeof PANEL_MESSAGE_TYPE.SET_LOCKED
      locked: boolean
    }
  | {
      source: typeof PANEL_MESSAGE_SOURCE.PANEL
      type: typeof PANEL_MESSAGE_TYPE.REQUEST_LIVE_STATE
    }
  | {
      source: typeof PANEL_MESSAGE_SOURCE.PANEL
      type: typeof PANEL_MESSAGE_TYPE.MANUAL_SAVE
      requestId: string
      conversationId?: string
      /** Explicit user consent to persist ordinary files for this conversation. */
      allowFiles?: boolean
      /** Optional first-save override for image capture in this conversation. */
      saveImages?: boolean
      shareUrl?: string
      captureMode?: import('./share-capture').ChatGPTCaptureMode
    }

export interface ManualSaveResultMessage {
  source: typeof PANEL_MESSAGE_SOURCE.HOST
  type: typeof PANEL_MESSAGE_TYPE.MANUAL_SAVE_RESULT
  requestId: string
  result: ManualSaveResult
}

export interface ConversationContextChangedMessage {
  source: typeof PANEL_MESSAGE_SOURCE.HOST
  type: typeof PANEL_MESSAGE_TYPE.CONVERSATION_CONTEXT_CHANGED
  context: HostConversationContext
}

export interface ConversationLiveStateChangedMessage {
  source: typeof PANEL_MESSAGE_SOURCE.HOST
  type: typeof PANEL_MESSAGE_TYPE.CONVERSATION_LIVE_STATE_CHANGED
  state: HostConversationLiveState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHostConversationContext(value: unknown): value is HostConversationContext {
  if (!isRecord(value)) {
    return false
  }
  const platform = value.platform
  const conversationId = value.conversationId
  const validPlatform =
    platform === null ||
    (typeof platform === 'string' &&
      SUPPORTED_PLATFORMS.includes(platform as Platform))
  return (
    validPlatform &&
    (value.accountIdentifier === undefined || value.accountIdentifier === null ||
      typeof value.accountIdentifier === 'string' && value.accountIdentifier.length <= 254) &&
    (conversationId === null ||
      (typeof conversationId === 'string' && conversationId !== '')) &&
    ((platform === null && conversationId === null) ||
      (platform !== null && conversationId !== null))
  )
}

export function isPanelToHostMessage(value: unknown): value is PanelToHostMessage {
  if (!isRecord(value) || value.source !== PANEL_MESSAGE_SOURCE.PANEL) {
    return false
  }
  switch (value.type) {
    case PANEL_MESSAGE_TYPE.CLOSE:
    case PANEL_MESSAGE_TYPE.CANCEL_SHARE_CAPTURE:
      return true
    case PANEL_MESSAGE_TYPE.SET_LOCKED:
      return typeof value.locked === 'boolean'
    case PANEL_MESSAGE_TYPE.REQUEST_LIVE_STATE:
      return true
    case PANEL_MESSAGE_TYPE.MANUAL_SAVE:
      return (
        typeof value.requestId === 'string' &&
        value.requestId !== '' &&
        (value.conversationId === undefined ||
          (typeof value.conversationId === 'string' && value.conversationId !== '')) &&
        (value.allowFiles === undefined || typeof value.allowFiles === 'boolean') &&
        (value.saveImages === undefined || typeof value.saveImages === 'boolean') &&
        (value.shareUrl === undefined || typeof value.shareUrl === 'string' && value.shareUrl.length <= 256) &&
        (value.captureMode === undefined || ['conversation', 'share'].includes(value.captureMode as string))
      )
    default:
      return false
  }
}

export function isManualSaveResultMessage(
  value: unknown,
): value is ManualSaveResultMessage {
  if (
    !isRecord(value) ||
    value.source !== PANEL_MESSAGE_SOURCE.HOST ||
    value.type !== PANEL_MESSAGE_TYPE.MANUAL_SAVE_RESULT ||
    typeof value.requestId !== 'string' ||
    !isRecord(value.result) ||
    typeof value.result.ok !== 'boolean'
  ) {
    return false
  }
  if (value.result.ok) {
    return (
      typeof value.result.conversationId === 'string' &&
      (value.result.verification === 'exact' ||
        value.result.verification === 'local-history-suffix' ||
        value.result.verification === 'local-history-window')
    )
  }
  return (
    typeof value.result.reason === 'string' &&
    typeof value.result.message === 'string'
  )
}

export function isConversationContextChangedMessage(
  value: unknown,
): value is ConversationContextChangedMessage {
  if (
    !isRecord(value) ||
    value.source !== PANEL_MESSAGE_SOURCE.HOST ||
    value.type !== PANEL_MESSAGE_TYPE.CONVERSATION_CONTEXT_CHANGED ||
    !isHostConversationContext(value.context)
  ) {
    return false
  }
  return true
}

export function isConversationLiveStateChangedMessage(
  value: unknown,
): value is ConversationLiveStateChangedMessage {
  if (
    !isRecord(value) ||
    value.source !== PANEL_MESSAGE_SOURCE.HOST ||
    value.type !== PANEL_MESSAGE_TYPE.CONVERSATION_LIVE_STATE_CHANGED ||
    !isRecord(value.state) ||
    !isHostConversationContext(value.state.context)
  ) {
    return false
  }
  const state = value.state
  const validStatus =
    state.syncStatus === 'observing' ||
    state.syncStatus === 'pending' ||
    state.syncStatus === 'saving' ||
    state.syncStatus === 'synced' ||
    state.syncStatus === 'error'
  const validMessages =
    Array.isArray(state.recentMessages) &&
    state.recentMessages.length <= 2 &&
    state.recentMessages.every((message) =>
      isRecord(message) &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.length <= 1_200,
    )
  return (
    typeof state.pageTitle === 'string' &&
    state.pageTitle.length <= 1_000 &&
    typeof state.pageMessageCount === 'number' &&
    Number.isInteger(state.pageMessageCount) &&
    state.pageMessageCount >= 0 &&
    validMessages &&
    validStatus &&
    typeof state.pinnedEvidence === 'boolean' &&
    typeof state.observedAt === 'number' &&
    Number.isFinite(state.observedAt) &&
    (state.lastSyncedAt === null ||
      (typeof state.lastSyncedAt === 'number' &&
        Number.isFinite(state.lastSyncedAt)))
  )
}
