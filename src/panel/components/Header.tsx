import type { ReactNode } from 'react'

interface HeaderProps {
  title: string
  onBack?: () => void
  onClose: () => void
  locked?: boolean
  onToggleLock?: () => void
  action?: ReactNode
  showTitle?: boolean
}

export function Header({
  title,
  onBack,
  onClose,
  locked = false,
  onToggleLock,
  action,
  showTitle = true,
}: HeaderProps) {
  return (
    <header className="app-header">
      <div className="header-side">
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
        >
          ×
        </button>
        {onToggleLock && (
          <button
            className={locked ? 'header-lock-button active' : 'header-lock-button'}
            type="button"
            aria-label={locked ? '解除面板锁定' : '锁定面板'}
            aria-pressed={locked}
            title={locked ? '已锁定，点击后允许外部关闭' : '锁定后点击外部不会关闭'}
            onClick={onToggleLock}
          >
            {locked ? '已锁定' : '锁定'}
          </button>
        )}
        {onBack && (
          <button
            className="icon-button"
            type="button"
            onClick={onBack}
            aria-label="返回"
            title="返回"
          >
            ←
          </button>
        )}
      </div>
      {showTitle && <h1 title={title}>{title}</h1>}
      <div className="header-side header-side-end">
        {action ?? <span className="mini-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>}
      </div>
    </header>
  )
}
