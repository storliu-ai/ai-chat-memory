import { ChatGPTShareAdapter } from '../adapters/chatgpt/chatgpt-share-adapter'
import { GeminiShareAdapter } from '../adapters/gemini/gemini-share-adapter'
import { EXTENSION_BUILD_ID } from '../shared/build-id'
import type { ExtractedConversation } from '../shared/models'
import { sendRuntimeRequest } from '../shared/runtime-client'
import { RUNTIME_MESSAGE_TYPE } from '../shared/runtime-messages'
import { SHARE_TASK_STATUS_EVENT, type ShareCapturePhase, type ShareCaptureStatus } from '../shared/share-capture'
import { showShareCaptureStatus } from './share-capture-status'

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/** A share route never installs the normal observer or creates a share record.
 * Only a tab claimed by an explicit original-conversation job may scroll. */
export async function runShareCapturePage(): Promise<void> {
  const platform = location.hostname === 'gemini.google.com' ? 'gemini' as const : 'chatgpt' as const
  const base = { type: RUNTIME_MESSAGE_TYPE.SHARE_CAPTURE, contentScriptBuildId: EXTENSION_BUILD_ID, platform } as const
  const claimed = await sendRuntimeRequest({ ...base, action: 'claim' }).catch(() => null)
  if (!claimed?.status) return
  const jobId = claimed.status.id
  const originalUrl = location.href
  const updateStatus = showShareCaptureStatus(claimed.status, async () => {
    await sendRuntimeRequest({ ...base, action: 'return', jobId })
  })
  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'AI_CHAT_MEMORY_VERIFY_SHARE_TASK' && (message as { jobId?: unknown }).jobId === jobId && location.href === originalUrl) respond({ jobId })
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === SHARE_TASK_STATUS_EVENT) {
      const status = (message as { status?: ShareCaptureStatus }).status
      if (status?.id === jobId) {
        updateStatus(status)
        if (['complete', 'failed', 'cancelled'].includes(status.phase)) stopped = true
      }
    }
    return false
  })
  const adapter = platform === 'gemini' ? new GeminiShareAdapter() : new ChatGPTShareAdapter()
  let stopped = false
  let count = 0
  let progress = 3
  let loadingStarted = Date.now()
  let visibleWaitStarted = Date.now()
  let scanWasHidden: boolean
  const trackVisibility = (): void => { if (document.hidden) scanWasHidden = true }
  document.addEventListener('visibilitychange', trackVisibility)
  let phase: 'scanning' | 'needs-foreground' = 'scanning'
  let heartbeatBusy = false
  const report = async (): Promise<void> => {
    if (stopped || heartbeatBusy) return
    heartbeatBusy = true
    try {
      const response = await sendRuntimeRequest({ ...base, action: 'progress', jobId, phase, messageCount: count, progress })
      if (response.status) updateStatus(response.status)
      const remotePhase: ShareCapturePhase | undefined = response.status?.phase
      if (!remotePhase || ['failed', 'cancelled', 'complete'].includes(remotePhase)) stopped = true
    } catch (error: unknown) {
      if (!stopped) await sendRuntimeRequest({ ...base, action: 'finish', jobId,
        error: error instanceof Error ? `采集进度通信失败：${error.message}` : '采集进度通信失败，请从原对话重试',
      }).catch(() => undefined)
      stopped = true
    }
    finally { heartbeatBusy = false }
  }
  const heartbeat = window.setInterval(() => { void report() }, 5_000)
  const check = (): void => {
    if (stopped || location.href !== originalUrl) throw new Error('采集任务已取消或页面已切换')
  }
  const beforeStep = async (): Promise<void> => {
    check()
    trackVisibility()
  }
  const waitForForeground = async (): Promise<void> => {
    if (document.hidden) {
      phase = 'needs-foreground'
      await report()
      while (document.hidden) { check(); await delay(500) }
    }
    check()
    phase = 'scanning'
    loadingStarted = Date.now()
    visibleWaitStarted = Date.now()
    await report()
  }
  const onProgress = (next: number): void => { count = Math.max(count, next); void report() }
  const onScanProgress = (coverage: number): void => {
    progress = Math.max(progress, 5 + Math.round(Math.min(1, Math.max(0, coverage)) * 80))
    void report()
  }
  try {
    while (adapter.getMessages().length === 0) {
      await beforeStep()
      if (document.hidden) {
        visibleWaitStarted = Date.now()
        if (Date.now() - loadingStarted > 30_000) await waitForForeground()
      }
      if (!document.hidden && Date.now() - visibleWaitStarted > 30_000) throw new Error('分享页未显示可读取消息，请检查链接、登录要求或页面加载状态')
      await delay(500)
    }
    let capture: ExtractedConversation | null = null
    while (true) {
      scanWasHidden = document.hidden
      capture = await adapter.collectShareConversation(beforeStep, onProgress, onScanProgress)
      check()
      // Hidden virtual lists can move without mounting their rows. A scan
      // interrupted by background rendering is retried on the same tab,
      // including when the user switches away again during a foreground retry.
      if (capture?.captureComplete === true || !scanWasHidden && !document.hidden) break
      await waitForForeground()
    }
    check()
    const finished = await sendRuntimeRequest({ ...base, action: 'finish', jobId, ...(capture?.captureComplete ? { capture } : { error: `已读取 ${count} 条消息，分享页仍存在${capture?.captureIncompleteReason === 'gap' ? '消息序号缺口' : '未确认的滚动边界'}，未保存；请等待页面稳定后重试` }) })
    if (finished.status) updateStatus(finished.status)
    while (!stopped && location.href === originalUrl) await delay(1_000)
  } catch (error: unknown) {
    if (!stopped) await sendRuntimeRequest({ ...base, action: 'finish', jobId, error: error instanceof Error ? error.message : '分享采集失败，请重试' }).catch(() => undefined)
  } finally {
    stopped = true
    window.clearInterval(heartbeat)
    document.removeEventListener('visibilitychange', trackVisibility)
  }
}
