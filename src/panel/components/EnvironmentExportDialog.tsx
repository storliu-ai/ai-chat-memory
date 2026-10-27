import { useEffect, useState } from 'react'
import type { SharedDirectoryStatus } from '../../shared/models'
import { downloadEnvironmentMarkdownArchive } from '../conversation-export'
import { getExportEnvironments } from '../services/panel-api'

interface EnvironmentExportDialogProps {
  directory: SharedDirectoryStatus
  onClose: () => void
  onNotice: (message: string) => void
  onError: (message: string) => void
}

export function EnvironmentExportDialog({
  directory,
  onClose,
  onNotice,
  onError,
}: EnvironmentExportDialogProps) {
  const [scope, setScope] = useState(directory.currentEnvironment.id)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  const exportArchive = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    onError('')
    try {
      const environments = await getExportEnvironments(
        scope === 'all' ? 'all' : [scope],
      )
      if (scope !== 'all' && !environments.some(
        ({ environment }) => environment.id === scope,
      )) {
        throw new Error('所选环境当前不可读取')
      }
      const result = downloadEnvironmentMarkdownArchive(environments)
      onNotice(
        `已导出 ${environments.length} 个环境、${result.conversationCount} 条独立对话文件`,
      )
      onClose()
    } catch (exportError: unknown) {
      onError(exportError instanceof Error ? exportError.message : '环境对话导出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="confirm-backdrop export-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-export-title"
      >
        <header>
          <span>
            <small>批量导出</small>
            <h2 id="environment-export-title">每条对话一个文件</h2>
          </span>
          <button type="button" disabled={busy} aria-label="关闭导出" onClick={onClose}>×</button>
        </header>
        <p className="export-dialog-description">
          生成 ZIP，并按环境建立目录。每条对话完整导出为独立 Markdown，不受当前搜索和分页影响。
        </p>
        <label className="export-field">
          <span>导出范围</span>
          <select
            value={scope}
            disabled={busy}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value={directory.currentEnvironment.id}>
              本环境 · {directory.currentEnvironment.label}
            </option>
            {directory.otherEnvironments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.label} · {environment.conversationCount} 条
              </option>
            ))}
            {directory.otherEnvironments.length > 0 && (
              <option value="all">
                全部环境 · {directory.otherEnvironments.length + 1} 个
              </option>
            )}
          </select>
        </label>
        <div className="export-dialog-note">
          批量 Markdown 只包含可见正文与附件清单；完整附件备份请继续使用设置页的整库 JSON。
        </div>
        <footer>
          <button className="export-secondary" type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="export-primary" type="button" disabled={busy} onClick={() => void exportArchive()}>
            {busy ? '正在整理…' : '导出 ZIP'}
          </button>
        </footer>
      </section>
    </div>
  )
}
