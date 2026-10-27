import { useState } from 'react'

/** Keep cause/action visible in two or three lines; full explanations are
 * available by pointer, click and keyboard without relying on color alone. */
export function CaptureNotice({ title, message, details, tone = 'info' }: { title: string; message: string; details: string; tone?: 'info' | 'warning' | 'error' | 'success' }) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = !dismissed && (pinned || hovered || focused)
  return <div className={`capture-note capture-note-${tone}`} role="status" onKeyDown={(event) => {
    if (event.key === 'Escape') { setPinned(false); setDismissed(true) }
  }}>
    <div className="capture-note-heading"><strong><span aria-hidden="true">{tone === 'warning' ? '!' : tone === 'error' ? '×' : tone === 'success' ? '✓' : 'ⓘ'}</span> {title}</strong>
      <div className="capture-note-detail" onMouseEnter={() => { setHovered(true); setDismissed(false) }} onMouseLeave={() => setHovered(false)}
        onFocus={() => { setFocused(true); setDismissed(false) }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
        <button type="button" aria-expanded={open} aria-label="查看采集提示详情" onClick={() => {
          if (pinned && open) { setPinned(false); setDismissed(true) }
          else { setDismissed(false); setPinned(true) }
        }}>详情</button>
        {open && <div className="capture-note-popover" role="note">{details}</div>}
      </div>
    </div>
    <p className="capture-note-summary" title={message}>{message}</p>
  </div>
}
