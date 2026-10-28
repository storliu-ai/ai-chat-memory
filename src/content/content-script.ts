import { ConversationObserver } from './conversation-observer'
import { runShareCapturePage } from './share-capture'
import { initializeNetworkCapturePage } from './network-capture'
import {
  installFloatingPanel,
  type FloatingPanelController,
} from './floating-panel'
import { Logger } from '../utils/logger'
import { isConversationDeletedContentEvent } from '../shared/content-events'
import { EXTENSION_BUILD_ID } from '../shared/build-id'
import { SHARE_SOURCE_CONTEXT_REQUEST } from '../shared/share-capture'
import { sendRuntimeRequest } from '../shared/runtime-client'
import {
  RUNTIME_MESSAGE_TYPE,
  type CaptureReadinessReason,
} from '../shared/runtime-messages'

const UPDATE_NOTICE_HOST_ID = 'ai-chat-memory-update-notice'
const RUNTIME_HEALTH_CHECK_MS = 15_000

function showRuntimeUnavailableNotice(reason: CaptureReadinessReason): void {
  if (document.getElementById(UPDATE_NOTICE_HOST_ID) !== null) {
    return
  }
  const host = document.createElement('div')
  host.id = UPDATE_NOTICE_HOST_ID
  host.setAttribute('data-extension-ui', 'ai-chat-memory')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .notice {
      position: fixed;
      z-index: 2147483647;
      right: 16px;
      bottom: 16px;
      box-sizing: border-box;
      width: min(340px, calc(100vw - 32px));
      padding: 15px;
      border: 1px solid rgba(109, 74, 255, 0.24);
      border-radius: 14px;
      color: #25232d;
      background: #fff;
      box-shadow: 0 16px 44px rgba(25, 22, 38, 0.2);
      font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    strong { display: block; margin: 0 0 4px 25px; font-size: 14px; }
    p { margin: 0; color: #5c5868; }
    button { font: inherit; cursor: pointer; }
    .dismiss {
      position: absolute;
      top: 9px;
      left: 9px;
      display: grid;
      width: 26px;
      height: 26px;
      padding: 0;
      place-items: center;
      border: 0;
      border-radius: 8px;
      color: #777280;
      background: transparent;
      font-size: 18px;
      line-height: 1;
    }
    .dismiss:hover { background: #f2efff; }
    .actions { display: flex; margin-top: 11px; justify-content: center; }
    .refresh {
      padding: 7px 12px;
      border: 0;
      border-radius: 9px;
      color: #fff;
      background: #6d4aff;
    }
    button:focus-visible { outline: 3px solid rgba(109, 74, 255, 0.28); }
  `
  const notice = document.createElement('section')
  notice.className = 'notice'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  const dismiss = document.createElement('button')
  dismiss.className = 'dismiss'
  dismiss.type = 'button'
  dismiss.setAttribute('aria-label', '关闭提示')
  dismiss.textContent = '×'
  dismiss.addEventListener('click', () => host.remove())
  const title = document.createElement('strong')
  title.textContent = reason === 'package-unavailable'
    ? 'AI Chat Memory 正在更新'
    : 'AI Chat Memory 已更新'
  const copy = document.createElement('p')
  copy.textContent = reason === 'package-unavailable'
    ? '插件文件尚未完整可用，已暂停抓取以避免误保存。请等待构建完成后刷新本页。'
    : '当前页面仍运行旧版内容脚本，已暂停抓取。Chrome 无法在不刷新宿主页的情况下替换它，请在方便时刷新本页。'
  const actions = document.createElement('div')
  actions.className = 'actions'
  const refresh = document.createElement('button')
  refresh.className = 'refresh'
  refresh.type = 'button'
  refresh.textContent = '刷新本页并启用新版插件'
  refresh.addEventListener('click', () => location.reload())
  actions.append(refresh)
  notice.append(dismiss, title, copy, actions)
  shadow.append(style, notice)
  ;(document.body ?? document.documentElement)?.append(host)
}

async function initializeContentScript(): Promise<void> {
  const readiness = await sendRuntimeRequest({
    type: RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS,
    contentScriptBuildId: EXTENSION_BUILD_ID,
  })
  if (!readiness.ready) {
    showRuntimeUnavailableNotice(readiness.reason)
    return
  }
  const networkCapture = await initializeNetworkCapturePage()
  if (networkCapture.ownedPage) return
  if (['chatgpt.com', 'gemini.google.com'].includes(location.hostname) && /^(?:\/u\/\d+)?\/share\//.test(location.pathname)) {
    await runShareCapturePage()
    return
  }
  let floatingPanel: FloatingPanelController | null = null
  let conversationObserver: ConversationObserver | null = null
  let runtimeHealthCheckTimer: number | null = null
  let runtimeHealthCheckInFlight = false
  const stopForUnavailableRuntime = (reason: CaptureReadinessReason): void => {
    if (runtimeHealthCheckTimer !== null) {
      window.clearInterval(runtimeHealthCheckTimer)
      runtimeHealthCheckTimer = null
    }
    conversationObserver?.destroy()
    floatingPanel?.destroy()
    floatingPanel = null
    showRuntimeUnavailableNotice(reason)
  }
  conversationObserver = new ConversationObserver(
    stopForUnavailableRuntime,
    () => floatingPanel?.notifyConversationStateChanged(),
  )
  const activeObserver = conversationObserver
  networkCapture.bindObserver(activeObserver)
  floatingPanel = installFloatingPanel({
    onCancelShareCapture: () => activeObserver.cancelShareCapture(),
    onManualSave: (conversationId, allowFiles, saveImages, shareUrl, captureMode) =>
      captureMode && captureMode !== 'conversation'
        ? activeObserver.saveWithShare(conversationId, allowFiles, saveImages, shareUrl)
        : activeObserver.saveCurrentConversation(
        conversationId,
        allowFiles,
        saveImages,
      ),
    getConversationContext: () =>
      activeObserver.getCurrentConversationContext(),
    getConversationLiveState: () =>
      activeObserver.getCurrentConversationLiveState(),
  })
  activeObserver.start()

  runtimeHealthCheckTimer = window.setInterval(() => {
    if (runtimeHealthCheckInFlight) {
      return
    }
    runtimeHealthCheckInFlight = true
    void sendRuntimeRequest({
      type: RUNTIME_MESSAGE_TYPE.CHECK_CAPTURE_READINESS,
      contentScriptBuildId: EXTENSION_BUILD_ID,
    }).then((health) => {
      if (!health.ready) {
        stopForUnavailableRuntime(health.reason)
      }
    }).catch(() => {
      stopForUnavailableRuntime('version-mismatch')
    }).finally(() => {
      runtimeHealthCheckInFlight = false
    })
  }, RUNTIME_HEALTH_CHECK_MS)

  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    if (typeof message === 'object' && message !== null &&
      (message as { type?: unknown }).type === SHARE_SOURCE_CONTEXT_REQUEST) {
      respond({ ...activeObserver.getCurrentConversationContext(), url: location.href, contentScriptBuildId: EXTENSION_BUILD_ID,
        ...((message as { includeCapture?: boolean }).includeCapture ? { capture: activeObserver.getShareSourceCapture() } : {}),
      })
      return false
    }
    if (isConversationDeletedContentEvent(message)) {
      activeObserver.forgetDeletedConversation(
        message.platform,
        message.conversationId,
      )
    }
    return false
  })

  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    try {
      if (!event.persisted) {
        if (runtimeHealthCheckTimer !== null) {
          window.clearInterval(runtimeHealthCheckTimer)
          runtimeHealthCheckTimer = null
        }
        activeObserver.destroy()
        floatingPanel?.destroy()
      }
    } catch (error: unknown) {
      Logger.warn('Content script cleanup failed safely', error)
    }
  })

  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    try {
      if (event.persisted) {
        floatingPanel?.ensureMounted()
      }
    } catch (error: unknown) {
      Logger.warn('Content script restore failed safely', error)
    }
  })
}

try {
  void initializeContentScript().catch((error: unknown) => {
    showRuntimeUnavailableNotice('version-mismatch')
    Logger.error('Content script initialization failed safely', error)
  })
} catch (error: unknown) {
  Logger.error('Content script initialization failed safely', error)
}
