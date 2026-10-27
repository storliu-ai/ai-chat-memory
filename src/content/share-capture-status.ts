import { getShareCaptureProgress, type ShareCaptureStatus } from '../shared/share-capture'

/** Only authorized capture tabs show this controller, never a second library. */
export function showShareCaptureStatus(initial: ShareCaptureStatus, returnToSource: () => Promise<void>): (status: ShareCaptureStatus) => void {
  const host = document.createElement('div')
  host.setAttribute('data-extension-ui', 'ai-chat-memory')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    section { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
      width: min(310px, calc(100vw - 32px)); box-sizing: border-box; padding: 16px;
      border: 1px solid #ddd5ff; border-radius: 14px; background: white; color: #25232d;
      box-shadow: 0 10px 30px #19162626; font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    strong, span { display: block; } span { margin-top: 8px; font-weight: 600; }
    .track { height: 5px; margin-top: 10px; overflow: hidden; border-radius: 999px; background: #eae7f3; }
    .fill { height: 100%; border-radius: inherit; background: #6d4aff; transition: width 1.4s linear; }
    section[data-phase="needs-foreground"] { border-color: #d99832; background: #fff3cd; color: #794400; }
    section[data-phase="needs-foreground"] p { color: #794400; }
    section[data-phase="failed"] { border-color: #f0c5cb; background: #fff3f4; color: #c83d4f; }
    section[data-phase="failed"] p { color: #c83d4f; }
    @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
    p { margin: 6px 0 12px; color: #5c5868; }
    button { padding: 8px 12px; border: 0; border-radius: 8px; background: #6d4aff; color: white; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 3px solid #b8a7ff; outline-offset: 2px; }
  `
  const card = document.createElement('section')
  card.setAttribute('role', 'status')
  card.setAttribute('aria-live', 'polite')
  const title = document.createElement('strong')
  title.textContent = 'AI Chat Memory · 分享采集'
  const progress = document.createElement('div')
  progress.className = 'track'
  progress.setAttribute('role', 'progressbar')
  progress.setAttribute('aria-label', '采集阶段进度')
  progress.setAttribute('aria-valuemin', '0')
  progress.setAttribute('aria-valuemax', '100')
  const fill = document.createElement('div')
  fill.className = 'fill'
  progress.append(fill)
  const count = document.createElement('span')
  const message = document.createElement('p')
  const back = document.createElement('button')
  back.type = 'button'
  back.textContent = '返回原对话查看保存结果'
  back.addEventListener('click', () => {
    void returnToSource().catch(() => { message.textContent = '无法打开原对话，请手动切换回原对话标签页' })
  })
  card.append(title, progress, count, message, back)
  shadow.append(style, card)
  ;(document.body ?? document.documentElement).append(host)
  const update = (status: ShareCaptureStatus): void => {
    count.textContent = `已读取 ${status.messageCount} 条消息`
    card.setAttribute('data-phase', status.phase)
    title.textContent = status.phase === 'needs-foreground' ? 'AI Chat Memory · 请保持采集页可见' : 'AI Chat Memory · 分享采集'
    card.setAttribute('role', status.phase === 'failed' ? 'alert' : 'status')
    message.textContent = status.message
    progress.hidden = ['failed', 'cancelled'].includes(status.phase)
    progress.setAttribute('aria-valuenow', String(getShareCaptureProgress(status)))
    progress.setAttribute('aria-valuetext', status.message)
    fill.style.width = `${getShareCaptureProgress(status)}%`
  }
  update(initial)
  return update
}
