import {
  isPanelToHostMessage,
  PANEL_MESSAGE_SOURCE,
  PANEL_MESSAGE_TYPE,
  type ConversationContextChangedMessage,
  type ConversationLiveStateChangedMessage,
  type HostConversationContext,
  type HostConversationLiveState,
  type ManualSaveResult,
  type ManualSaveResultMessage,
} from '../shared/panel-messages'
import {
  DEFAULT_OVERLAY_PANEL_WIDTH,
  MAX_OVERLAY_PANEL_WIDTH,
  MIN_OVERLAY_PANEL_WIDTH,
} from '../shared/models'
import { sendRuntimeRequest } from '../shared/runtime-client'
import { RUNTIME_MESSAGE_TYPE } from '../shared/runtime-messages'

const HOST_ID = 'ai-chat-memory-floating-root'
const BUTTON_SIZE = 34
const EDGE_GAP = 10
const HEADER_CLEARANCE = 58
const DEFAULT_TOP = HEADER_CLEARANCE + 12
const DRAG_THRESHOLD = 5
const MOUNT_CHECK_MS = 1_000
const PANEL_RESIZE_STEP = 20
const LIVE_STATE_THROTTLE_MS = 250

interface DragState {
  pointerId: number
  startX: number
  startY: number
  startLeft: number
  startTop: number
  moved: boolean
}

interface PanelResizeState {
  pointerId: number
  startX: number
  startWidth: number
}

export interface FloatingPanelController {
  ensureMounted(): void
  notifyConversationStateChanged(): void
  destroy(): void
}

interface FloatingPanelOptions {
  onManualSave: (
    expectedConversationId?: string,
    allowFiles?: boolean,
    saveImages?: boolean,
    shareUrl?: string,
    captureMode?: import('../shared/share-capture').ChatGPTCaptureMode,
  ) => Promise<ManualSaveResult>
  onCancelShareCapture: () => void
  getConversationContext: () => HostConversationContext
  getConversationLiveState: () => HostConversationLiveState
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function installFloatingPanel(
  options: FloatingPanelOptions,
): FloatingPanelController | null {
  try {
    if (document.getElementById(HOST_ID) !== null || document.documentElement === null) {
      return null
    }

    const host = document.createElement('div')
    host.id = HOST_ID
    host.setAttribute('data-extension-ui', 'ai-chat-memory')

    const preserveHostVisibility = (): void => {
      host.style.setProperty('display', 'block', 'important')
      host.style.setProperty('visibility', 'visible', 'important')
      host.style.setProperty('opacity', '1', 'important')
      host.style.setProperty('position', 'fixed', 'important')
      host.style.setProperty('z-index', '2147483647', 'important')
      host.style.setProperty('width', `${BUTTON_SIZE}px`, 'important')
      host.style.setProperty('height', `${BUTTON_SIZE}px`, 'important')
      host.style.setProperty('pointer-events', 'auto', 'important')
    }
    preserveHostVisibility()
    host.style.setProperty('top', `${DEFAULT_TOP}px`, 'important')
    host.style.setProperty('right', `${EDGE_GAP}px`, 'important')
    host.style.setProperty('left', 'auto', 'important')
    host.style.setProperty('transform', 'none', 'important')
    const shadow = host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        top: ${DEFAULT_TOP}px;
        right: ${EDGE_GAP}px;
        z-index: 2147483647;
        width: ${BUTTON_SIZE}px;
        height: ${BUTTON_SIZE}px;
        transform: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      button {
        position: relative;
        z-index: 2;
        display: grid;
        width: ${BUTTON_SIZE}px;
        height: ${BUTTON_SIZE}px;
        padding: 0;
        place-items: center;
        border: 0;
        border-radius: 11px;
        color: #fff;
        background: #6d4aff;
        box-shadow: none;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        transition: background 140ms ease;
      }
      button:hover {
        background: #5d3bea;
        box-shadow: none;
      }
      button:active { cursor: grabbing; }
      button:focus-visible {
        outline: 3px solid rgba(109, 74, 255, 0.28);
        outline-offset: 3px;
      }
      button[hidden] { display: none; }
      .mark {
        display: flex;
        align-items: end;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding-bottom: 8px;
        gap: 3px;
        pointer-events: none;
      }
      .mark span {
        display: block;
        width: 3px;
        border-radius: 999px;
        background: currentColor;
      }
      .mark span:nth-child(1) { height: 8px; }
      .mark span:nth-child(2) { height: 16px; }
      .mark span:nth-child(3) { height: 11px; }
      .panel {
        position: fixed;
        z-index: 1;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(${DEFAULT_OVERLAY_PANEL_WIDTH}px, 100vw);
        overflow: hidden;
        border: 0;
        border-left: 1px solid rgba(30, 31, 36, 0.11);
        border-radius: 18px 0 0 18px;
        background: #fff;
        box-shadow: -18px 0 54px rgba(17, 18, 24, 0.2);
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #f7f8fa;
      }
      .panel-resize-handle {
        position: absolute;
        z-index: 3;
        top: 0;
        bottom: 0;
        left: 0;
        width: 9px;
        border: 0;
        background: transparent;
        cursor: ew-resize;
        touch-action: none;
      }
      .panel-resize-handle::after {
        position: absolute;
        top: 50%;
        left: 2px;
        width: 3px;
        height: 42px;
        border-radius: 99px;
        background: rgba(109, 74, 255, 0.24);
        content: "";
        opacity: 0;
        transform: translateY(-50%);
        transition: opacity 120ms ease;
      }
      .panel-resize-handle:hover::after,
      .panel-resize-handle:focus-visible::after,
      .panel-resize-handle[data-resizing="true"]::after {
        opacity: 1;
      }
      .panel-resize-handle:focus-visible {
        outline: 0;
      }
      @media (max-width: 560px) {
        .panel {
          width: min(390px, 100vw);
          border-radius: 14px 0 0 14px;
        }
      }
    `

    const button = document.createElement('button')
    button.type = 'button'
    button.title = '打开 AI Chat Memory'
    button.setAttribute('aria-label', '打开 AI Chat Memory')
    button.setAttribute('aria-expanded', 'false')

    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.append(document.createElement('span'), document.createElement('span'), document.createElement('span'))
    button.append(mark)

    shadow.append(style, button)
    document.documentElement.append(host)

    let panel: HTMLDivElement | null = null
    let frame: HTMLIFrameElement | null = null
    let frameReady = false
    const extensionOrigin = new URL(chrome.runtime.getURL('panel.html')).origin
    let panelResizeHandle: HTMLDivElement | null = null
    let dragState: DragState | null = null
    let panelResizeState: PanelResizeState | null = null
    let suppressClickUntil = 0
    let destroyed = false
    let panelLocked = false
    let panelWidth = DEFAULT_OVERLAY_PANEL_WIDTH
    let lastFrameContextKey = ''
    let liveStateTimer: number | null = null

    const getPanelWidthBounds = (): { minimum: number; maximum: number } => {
      const maximum = Math.max(
        240,
        Math.min(MAX_OVERLAY_PANEL_WIDTH, window.innerWidth),
      )
      return {
        minimum: Math.min(MIN_OVERLAY_PANEL_WIDTH, maximum),
        maximum,
      }
    }

    const applyPanelWidth = (width: number): void => {
      const bounds = getPanelWidthBounds()
      panelWidth = clamp(width, bounds.minimum, bounds.maximum)
      panel?.style.setProperty('width', `${panelWidth}px`)
      panelResizeHandle?.setAttribute('aria-valuenow', Math.round(panelWidth).toString())
    }

    const persistPanelWidth = (): void => {
      void sendRuntimeRequest({
        type: RUNTIME_MESSAGE_TYPE.UPDATE_SETTINGS,
        settings: {
          overlayPanelWidth: Math.round(clamp(
            panelWidth,
            MIN_OVERLAY_PANEL_WIDTH,
            MAX_OVERLAY_PANEL_WIDTH,
          )),
        },
      }).catch(() => undefined)
    }

    const setHostPosition = (left: number, top: number): void => {
      host.style.setProperty('left', `${left}px`, 'important')
      host.style.setProperty('top', `${top}px`, 'important')
      host.style.setProperty('right', 'auto', 'important')
      host.style.setProperty('transform', 'none', 'important')
    }

    const keepButtonInViewport = (): void => {
      const rect = host.getBoundingClientRect()
      const maximumLeft = window.innerWidth - BUTTON_SIZE - EDGE_GAP
      const maximumTop = window.innerHeight - BUTTON_SIZE - EDGE_GAP
      const nextLeft = rect.left + rect.width / 2 <= window.innerWidth / 2
        ? EDGE_GAP
        : maximumLeft
      setHostPosition(
        clamp(nextLeft, EDGE_GAP, maximumLeft),
        clamp(rect.top, EDGE_GAP, maximumTop),
      )
    }

    const syncPanelContext = (force = false): void => {
      if (destroyed || frame === null || !frameReady) {
        return
      }
      const context = options.getConversationContext()
      const contextKey = JSON.stringify([context.platform, context.conversationId, context.accountIdentifier ?? null])
      if (!force && contextKey === lastFrameContextKey) {
        return
      }
      lastFrameContextKey = contextKey
      const message: ConversationContextChangedMessage = {
        source: PANEL_MESSAGE_SOURCE.HOST,
        type: PANEL_MESSAGE_TYPE.CONVERSATION_CONTEXT_CHANGED,
        context,
      }
      frame.contentWindow?.postMessage(message, extensionOrigin)
    }

    const postPanelLiveState = (): void => {
      liveStateTimer = null
      if (destroyed || frame === null || !frameReady) {
        return
      }
      const message: ConversationLiveStateChangedMessage = {
        source: PANEL_MESSAGE_SOURCE.HOST,
        type: PANEL_MESSAGE_TYPE.CONVERSATION_LIVE_STATE_CHANGED,
        state: options.getConversationLiveState(),
      }
      frame.contentWindow?.postMessage(message, extensionOrigin)
    }

    const syncPanelLiveState = (immediate = false): void => {
      if (destroyed || frame === null || !frameReady) {
        return
      }
      if (liveStateTimer !== null) {
        window.clearTimeout(liveStateTimer)
        liveStateTimer = null
      }
      if (immediate) {
        postPanelLiveState()
        return
      }
      liveStateTimer = window.setTimeout(
        postPanelLiveState,
        LIVE_STATE_THROTTLE_MS,
      )
    }

    const ensureMounted = (): void => {
      try {
        if (destroyed) {
          return
        }
        preserveHostVisibility()
        if (
          document.documentElement !== null &&
          (!host.isConnected || host.parentElement !== document.documentElement)
        ) {
          document.documentElement.append(host)
          keepButtonInViewport()
        }
        syncPanelContext()
      } catch {
        // A later mount check can retry without affecting the host page.
      }
    }

    const closePanel = (): void => {
      frameReady = false
      panelResizeState = null
      if (liveStateTimer !== null) {
        window.clearTimeout(liveStateTimer)
        liveStateTimer = null
      }
      panel?.remove()
      panel = null
      frame = null
      panelResizeHandle = null
      panelLocked = false
      lastFrameContextKey = ''
      button.hidden = false
      button.setAttribute('aria-expanded', 'false')
      button.title = '打开 AI Chat Memory'
      button.setAttribute('aria-label', '打开 AI Chat Memory')
    }

    const openPanel = (): void => {
      if (panel !== null) {
        return
      }

      panel = document.createElement('div')
      panel.className = 'panel'
      frame = document.createElement('iframe')
      frameReady = false
      frame.title = 'AI Chat Memory'
      frame.referrerPolicy = 'no-referrer'
      panelResizeHandle = document.createElement('div')
      panelResizeHandle.className = 'panel-resize-handle'
      panelResizeHandle.title = '拖动以调整面板宽度'
      panelResizeHandle.setAttribute('role', 'separator')
      panelResizeHandle.setAttribute('aria-label', '调整面板宽度')
      panelResizeHandle.setAttribute('aria-orientation', 'vertical')
      panelResizeHandle.setAttribute('aria-valuemin', MIN_OVERLAY_PANEL_WIDTH.toString())
      panelResizeHandle.setAttribute('aria-valuemax', MAX_OVERLAY_PANEL_WIDTH.toString())
      panelResizeHandle.tabIndex = 0
      const panelQuery = new URLSearchParams({
        surface: 'overlay',
        openedAt: Date.now().toString(),
        hostOrigin: location.origin,
      })
      const context = options.getConversationContext()
      if (context.platform !== null && context.conversationId !== null) {
        panelQuery.set('platform', context.platform)
        panelQuery.set('conversationId', context.conversationId)
      }
      frame.src = chrome.runtime.getURL(`panel.html?${panelQuery.toString()}`)
      // The initial about:blank document inherits the host origin. Wait for
      // this frame's extension-origin request instead of sending on mount/load.
      panelResizeHandle.addEventListener('pointerdown', handlePanelResizePointerDown)
      panelResizeHandle.addEventListener('keydown', handlePanelResizeKeyDown)
      panel.append(panelResizeHandle, frame)
      shadow.append(panel)
      applyPanelWidth(panelWidth)
      button.hidden = true
      button.setAttribute('aria-expanded', 'true')
    }

    const togglePanel = (): void => {
      try {
        if (panel === null) {
          openPanel()
        } else {
          closePanel()
        }
      } catch {
        closePanel()
      }
    }

    const handleClick = (event: MouseEvent): void => {
      try {
        if (performance.now() < suppressClickUntil) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        togglePanel()
      } catch {
        closePanel()
      }
    }

    const handlePointerDown = (event: PointerEvent): void => {
      try {
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
          return
        }
        const rect = host.getBoundingClientRect()
        dragState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startLeft: rect.left,
          startTop: rect.top,
          moved: false,
        }
        setHostPosition(rect.left, rect.top)
        button.setPointerCapture(event.pointerId)
      } catch {
        dragState = null
      }
    }

    const handlePointerMove = (event: PointerEvent): void => {
      try {
        if (dragState === null || dragState.pointerId !== event.pointerId) {
          return
        }
        const deltaX = event.clientX - dragState.startX
        const deltaY = event.clientY - dragState.startY
        if (!dragState.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) {
          return
        }
        dragState.moved = true
        setHostPosition(
          clamp(
            dragState.startLeft + deltaX,
            EDGE_GAP,
            window.innerWidth - BUTTON_SIZE - EDGE_GAP,
          ),
          clamp(
            dragState.startTop + deltaY,
            EDGE_GAP,
            window.innerHeight - BUTTON_SIZE - EDGE_GAP,
          ),
        )
        event.preventDefault()
      } catch {
        dragState = null
      }
    }

    const finishDrag = (event: PointerEvent): void => {
      try {
        if (dragState === null || dragState.pointerId !== event.pointerId) {
          return
        }
        const moved = dragState.moved
        dragState = null
        if (button.hasPointerCapture(event.pointerId)) {
          button.releasePointerCapture(event.pointerId)
        }
        if (moved) {
          keepButtonInViewport()
          suppressClickUntil = performance.now() + 350
          event.preventDefault()
        }
      } catch {
        dragState = null
      }
    }

    function handlePanelResizePointerDown(event: PointerEvent): void {
      try {
        if (
          panel === null ||
          panelResizeHandle === null ||
          !event.isPrimary ||
          (event.pointerType === 'mouse' && event.button !== 0)
        ) {
          return
        }
        panelResizeState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: panel.getBoundingClientRect().width,
        }
        panelResizeHandle.dataset.resizing = 'true'
        frame?.style.setProperty('pointer-events', 'none')
        panelResizeHandle.setPointerCapture(event.pointerId)
        event.preventDefault()
        event.stopPropagation()
      } catch {
        panelResizeState = null
      }
    }

    const handlePanelResizePointerMove = (event: PointerEvent): void => {
      if (panelResizeState === null || event.pointerId !== panelResizeState.pointerId) {
        return
      }
      applyPanelWidth(
        panelResizeState.startWidth + panelResizeState.startX - event.clientX,
      )
      event.preventDefault()
    }

    const finishPanelResize = (event: PointerEvent): void => {
      if (panelResizeState === null || event.pointerId !== panelResizeState.pointerId) {
        return
      }
      panelResizeState = null
      panelResizeHandle?.removeAttribute('data-resizing')
      frame?.style.removeProperty('pointer-events')
      if (panelResizeHandle?.hasPointerCapture(event.pointerId)) {
        panelResizeHandle.releasePointerCapture(event.pointerId)
      }
      persistPanelWidth()
      event.preventDefault()
    }

    function handlePanelResizeKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      applyPanelWidth(
        panelWidth + (event.key === 'ArrowLeft' ? PANEL_RESIZE_STEP : -PANEL_RESIZE_STEP),
      )
      persistPanelWidth()
      event.preventDefault()
      event.stopPropagation()
    }

    const handleMessage = (event: MessageEvent<unknown>): void => {
      try {
        if (
          destroyed ||
          frame === null ||
          event.source !== frame.contentWindow ||
          event.origin !== extensionOrigin ||
          !isPanelToHostMessage(event.data)
        ) {
          return
        }

        switch (event.data.type) {
          case PANEL_MESSAGE_TYPE.CANCEL_SHARE_CAPTURE:
            options.onCancelShareCapture()
            break
          case PANEL_MESSAGE_TYPE.CLOSE:
            closePanel()
            break
          case PANEL_MESSAGE_TYPE.SET_LOCKED:
            panelLocked = event.data.locked
            break
          case PANEL_MESSAGE_TYPE.REQUEST_LIVE_STATE:
            frameReady = true
            syncPanelContext(true)
            syncPanelLiveState(true)
            break
          case PANEL_MESSAGE_TYPE.MANUAL_SAVE: {
            const activeFrame = frame
            const requestId = event.data.requestId
            const respond = (result: ManualSaveResult): void => {
              if (destroyed || !frameReady || frame !== activeFrame) {
                return
              }
              const message: ManualSaveResultMessage = {
                source: PANEL_MESSAGE_SOURCE.HOST,
                type: PANEL_MESSAGE_TYPE.MANUAL_SAVE_RESULT,
                requestId,
                result,
              }
              activeFrame.contentWindow?.postMessage(message, extensionOrigin)
            }
            void options.onManualSave(
              event.data.conversationId,
              event.data.allowFiles,
              event.data.saveImages,
              event.data.shareUrl,
              event.data.captureMode,
            ).then(respond).catch(() => {
              respond({
                ok: false,
                reason: 'failed',
                message: '当前对话保存失败，请稍后重试',
              })
            })
            break
          }
        }
      } catch {
        // Ignore messages that cannot be safely inspected.
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      try {
        if (event.key === 'Escape') {
          closePanel()
        }
      } catch {
        // UI failures must remain isolated from the host page.
      }
    }

    const handleDocumentPointerDown = (event: PointerEvent): void => {
      try {
        if (
          panel !== null &&
          !panelLocked &&
          !event.composedPath().includes(host)
        ) {
          closePanel()
        }
      } catch {
        // Outside-click handling must never interrupt the host page event.
      }
    }

    const handleResize = (): void => {
      try {
        keepButtonInViewport()
        applyPanelWidth(panelWidth)
      } catch {
        // Keep resize handling isolated from the host page.
      }
    }

    button.addEventListener('click', handleClick)
    button.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    window.addEventListener('pointermove', handlePanelResizePointerMove)
    window.addEventListener('pointerup', finishPanelResize)
    window.addEventListener('pointercancel', finishPanelResize)
    window.addEventListener('message', handleMessage)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    const mountCheckTimer = window.setInterval(ensureMounted, MOUNT_CHECK_MS)
    void sendRuntimeRequest({ type: RUNTIME_MESSAGE_TYPE.GET_SETTINGS })
      .then((settings) => applyPanelWidth(settings.overlayPanelWidth))
      .catch(() => undefined)

    return {
      ensureMounted,
      notifyConversationStateChanged(): void {
        syncPanelLiveState()
      },
      destroy(): void {
        destroyed = true
        frameReady = false
        window.clearInterval(mountCheckTimer)
        if (liveStateTimer !== null) {
          window.clearTimeout(liveStateTimer)
          liveStateTimer = null
        }
        button.removeEventListener('click', handleClick)
        button.removeEventListener('pointerdown', handlePointerDown)
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', finishDrag)
        window.removeEventListener('pointercancel', finishDrag)
        window.removeEventListener('pointermove', handlePanelResizePointerMove)
        window.removeEventListener('pointerup', finishPanelResize)
        window.removeEventListener('pointercancel', finishPanelResize)
        window.removeEventListener('message', handleMessage)
        window.removeEventListener('keydown', handleKeyDown)
        window.removeEventListener('resize', handleResize)
        host.remove()
      },
    }
  } catch {
    return null
  }
}
