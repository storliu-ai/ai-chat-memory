import { useEffect, useId, useRef, type ReactNode } from 'react'

interface ConfirmDialogProps {
  title: string
  description: ReactNode
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    cancelButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) {
        previousFocus.focus()
      }
    }
  }, [busy, onCancel])

  return (
    <div
      className="confirm-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel()
        }
      }}
    >
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="confirm-icon" aria-hidden="true">
          !
        </div>
        <div className="confirm-copy">
          <h2 id={titleId}>{title}</h2>
          <div id={descriptionId}>{description}</div>
        </div>
        <div className="confirm-actions">
          <button
            ref={cancelButtonRef}
            className="confirm-cancel"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="confirm-danger"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '正在处理…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
