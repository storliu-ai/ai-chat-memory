import { useEffect, useId, useRef } from 'react'
import type { ConversationAttachment } from '../../shared/models'

interface ImagePreviewDialogProps {
  attachment: ConversationAttachment
  onClose: () => void
}

export function ImagePreviewDialog({
  attachment,
  onClose,
}: ImagePreviewDialogProps) {
  const titleId = useId()
  const hintId = useId()
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        closeButtonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) {
        previousFocus.focus()
      }
    }
  }, [onClose])

  if (attachment.dataUrl === undefined) {
    return null
  }

  return (
    <div
      className="image-preview-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
      >
        <header className="image-preview-header">
          <h2 id={titleId} title={attachment.name}>{attachment.name}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭图片预览"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="image-preview-canvas">
          <img src={attachment.dataUrl} alt={attachment.name} />
        </div>
        <p id={hintId} className="image-preview-hint">
          点击遮罩或按 Esc 关闭
        </p>
      </section>
    </div>
  )
}
