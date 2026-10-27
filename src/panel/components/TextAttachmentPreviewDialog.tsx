import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ConversationAttachment } from '../../shared/models'
import {
  decodeTextAttachment,
  getTextAttachmentFormat,
  readTextAttachmentBytes,
  truncateTextPreview,
  type TextAttachmentEncoding,
} from '../text-attachment-preview'

interface TextAttachmentPreviewDialogProps {
  attachment: ConversationAttachment
  onClose: () => void
  onDownload: () => void
}

export function TextAttachmentPreviewDialog({ attachment, onClose, onDownload }: TextAttachmentPreviewDialogProps) {
  const titleId = useId()
  const hintId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [encoding, setEncoding] = useState<TextAttachmentEncoding>('auto')
  const [wrapLines, setWrapLines] = useState(true)
  const [copyResult, setCopyResult] = useState<string | null>(null)
  const file = useMemo(() => {
    try { return { bytes: readTextAttachmentBytes(attachment), error: null } }
    catch { return { bytes: null, error: '本地附件内容读取失败，请尝试下载原文件查看' } }
  }, [attachment])
  const decoded = useMemo(() => {
    if (!file.bytes) return null
    const text = decodeTextAttachment(file.bytes, encoding)
    return { fullText: text, ...truncateTextPreview(text) }
  }, [file, encoding])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Tab' && dialogRef.current) {
        const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]'))
        const first = controls[0]
        const last = controls.at(-1)
        const current = document.activeElement
        if (first && last && (!dialogRef.current.contains(current) || event.shiftKey && current === first || !event.shiftKey && current === last)) {
          event.preventDefault()
          const nextFocus = event.shiftKey ? last : first
          nextFocus.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [onClose])

  const copyText = async (): Promise<void> => {
    if (!decoded) return
    try { await navigator.clipboard.writeText(decoded.fullText); setCopyResult('已复制全文') }
    catch { setCopyResult('复制失败，请选择正文复制或下载原文件') }
  }

  return (
    <div className="image-preview-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialogRef} className="text-preview-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId}>
        <header className="text-preview-header">
          <div>
            <h2 id={titleId} title={attachment.name}>{attachment.name}</h2>
            <small>{getTextAttachmentFormat(attachment) === 'markdown' ? 'Markdown 源码' : '文本预览'} · 本地文件</small>
          </div>
          <button ref={closeRef} className="text-preview-close" type="button" aria-label="关闭文件预览" onClick={onClose}>×</button>
        </header>
        <div className="text-preview-toolbar">
          <button type="button" disabled={!decoded} onClick={() => void copyText()}>复制全文</button>
          <button type="button" onClick={onDownload}>下载原文件</button>
          <label>
            编码
            <select value={encoding} disabled={!decoded} onChange={(event) => {
              setEncoding(event.target.value as TextAttachmentEncoding)
              setCopyResult(null)
            }}>
              <option value="auto">自动识别</option>
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030 / GBK</option>
              <option value="utf-16le">UTF-16 LE</option>
              <option value="utf-16be">UTF-16 BE</option>
            </select>
          </label>
          <label><input type="checkbox" checked={wrapLines} onChange={(event) => setWrapLines(event.target.checked)} />自动换行</label>
          {copyResult && <span role="status">{copyResult}</span>}
        </div>
        {file.error ? <div className="text-preview-error" role="alert">{file.error}</div> : (
          <pre className={wrapLines ? 'text-preview-content text-preview-wrap' : 'text-preview-content'} tabIndex={0} aria-label="文件正文">{decoded?.text}</pre>
        )}
        <p id={hintId} className="text-preview-hint">
          {decoded?.truncated ? '文件较大，仅预览前 20 万字符；复制全文和下载保留完整内容。' : '保留原文换行与缩进；点击遮罩或按 Esc 关闭。'}
        </p>
      </section>
    </div>
  )
}
