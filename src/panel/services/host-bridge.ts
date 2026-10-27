import {
  isConversationContextChangedMessage,
  isConversationLiveStateChangedMessage,
  isManualSaveResultMessage,
  PANEL_MESSAGE_SOURCE,
  PANEL_MESSAGE_TYPE,
  type HostConversationContext,
  type HostConversationLiveState,
  type ManualSaveResult,
  type PanelToHostMessage,
} from '../../shared/panel-messages'
import { SUPPORTED_PLATFORMS, type Platform } from '../../shared/models'

const SUPPORTED_HOST_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://gemini.google.com',
  'https://chat.deepseek.com',
])
let requestSequence = 0

export function isOverlayPanel(): boolean {
  return (
    new URLSearchParams(location.search).get('surface') === 'overlay' &&
    window.parent !== window
  )
}

export function getInitialHostConversationContext(): HostConversationContext {
  if (!isOverlayPanel()) {
    return { platform: null, conversationId: null }
  }
  const parameters = new URLSearchParams(location.search)
  const platform = parameters.get('platform')
  const conversationId = parameters.get('conversationId')
  return (
    platform !== null &&
    SUPPORTED_PLATFORMS.includes(platform as Platform) &&
    conversationId !== null &&
    conversationId !== ''
  )
    ? { platform: platform as Platform, conversationId }
    : { platform: null, conversationId: null }
}

export function subscribeHostConversationContext(
  listener: (context: HostConversationContext) => void,
): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (
      event.source === window.parent &&
      SUPPORTED_HOST_ORIGINS.has(event.origin) &&
      isConversationContextChangedMessage(event.data)
    ) {
      listener(event.data.context)
    }
  }
  window.addEventListener('message', handleMessage)
  return () => window.removeEventListener('message', handleMessage)
}

export function subscribeHostConversationLiveState(
  listener: (state: HostConversationLiveState) => void,
): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (
      event.source === window.parent &&
      SUPPORTED_HOST_ORIGINS.has(event.origin) &&
      isConversationLiveStateChangedMessage(event.data)
    ) {
      listener(event.data.state)
    }
  }
  window.addEventListener('message', handleMessage)
  return () => window.removeEventListener('message', handleMessage)
}

export function requestHostConversationLiveState(): void {
  postToHost({
    source: PANEL_MESSAGE_SOURCE.PANEL,
    type: PANEL_MESSAGE_TYPE.REQUEST_LIVE_STATE,
  })
}

function postToHost(message: PanelToHostMessage): boolean {
  if (!isOverlayPanel()) {
    return false
  }
  const ancestorOrigin = getAncestorOrigin()
  if (ancestorOrigin === null) {
    return false
  }
  window.parent.postMessage(message, ancestorOrigin)
  return true
}

function getAncestorOrigin(): string | null {
  try {
    const declaredOrigin = new URLSearchParams(location.search).get('hostOrigin')
    if (declaredOrigin !== null && SUPPORTED_HOST_ORIGINS.has(declaredOrigin)) {
      return declaredOrigin
    }
    const ancestor = location.ancestorOrigins[0]
    return SUPPORTED_HOST_ORIGINS.has(ancestor) ? ancestor : null
  } catch {
    return null
  }
}

export function closeHostPanel(): void {
  if (
    postToHost({
      source: PANEL_MESSAGE_SOURCE.PANEL,
      type: PANEL_MESSAGE_TYPE.CLOSE,
    })
  ) {
    return
  }
  window.close()
}

export function setHostPanelLocked(locked: boolean): void {
  postToHost({
    source: PANEL_MESSAGE_SOURCE.PANEL,
    type: PANEL_MESSAGE_TYPE.SET_LOCKED,
    locked,
  })
}

export function saveCurrentHostConversation(
  conversationId?: string,
  allowFiles?: boolean,
  saveImages?: boolean,
  shareUrl?: string,
  captureMode?: import('../../shared/share-capture').ChatGPTCaptureMode,
): Promise<ManualSaveResult> {
  if (!isOverlayPanel()) {
    return Promise.resolve({
      ok: false,
      reason: 'failed',
      message: '请在支持的 AI 对话页面悬浮窗口中手动保存',
    })
  }

  requestSequence += 1
  const requestId = `${Date.now().toString(36)}-${requestSequence.toString(36)}`

  return new Promise((resolve) => {
    const cleanup = (): void => {
      window.removeEventListener('message', handleMessage)
    }
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (
        event.source !== window.parent ||
        !SUPPORTED_HOST_ORIGINS.has(event.origin) ||
        !isManualSaveResultMessage(event.data) ||
        event.data.requestId !== requestId
      ) {
        return
      }
      cleanup()
      resolve(event.data.result)
    }
    window.addEventListener('message', handleMessage)
    postToHost({
      source: PANEL_MESSAGE_SOURCE.PANEL,
      type: PANEL_MESSAGE_TYPE.MANUAL_SAVE,
      requestId,
      ...(conversationId ? { conversationId } : {}),
      ...(allowFiles === true ? { allowFiles: true } : {}),
      ...(saveImages === undefined ? {} : { saveImages }),
      ...(shareUrl ? { shareUrl } : {}),
      ...(captureMode ? { captureMode } : {}),
    })
  })
}

export function cancelHostShareCapture(): void {
  postToHost({ source: PANEL_MESSAGE_SOURCE.PANEL, type: PANEL_MESSAGE_TYPE.CANCEL_SHARE_CAPTURE })
}
