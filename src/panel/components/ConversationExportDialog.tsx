import { useEffect, useMemo, useState } from 'react'
import type { Conversation } from '../../shared/models'
import {
  downloadConversationMarkdown,
  formatConversationMarkdown,
  type MessageExportRange,
} from '../conversation-export'

interface ConversationExportDialogProps {
  conversation: Conversation
  accountLabel: string
  environmentLabel: string
  onClose: () => void
  onNotice: (message: string) => void
  onError: (message: string) => void
}

export function ConversationExportDialog({
  conversation,
  accountLabel,
  environmentLabel,
  onClose,
  onNotice,
  onError,
}: ConversationExportDialogProps) {
  const [mode, setMode] = useState<MessageExportRange['mode']>('all')
  const [count, setCount] = useState(Math.min(20, conversation.messages.length))

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const range = useMemo<MessageExportRange>(() => mode === 'all'
    ? { mode: 'all' }
    : {
        mode,
        count: Math.min(
          conversation.messages.length,
          Math.max(1, Math.floor(count || 1)),
        ),
      }, [conversation.messages.length, count, mode])

  const options = {
    conversation,
    accountLabel,
    environmentLabel,
    range,
  }

  const copyMarkdown = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatConversationMarkdown(options))
      onNotice('已复制所选对话内容；未生成摘要或删改正文')
      onClose()
    } catch {
      onError('复制完整对话失败，请改用下载 Markdown')
    }
  }

  const downloadMarkdown = (): void => {
    try {
      const filename = downloadConversationMarkdown(options)
      onNotice(`已导出 ${filename}`)
      onClose()
    } catch {
      onError('导出对话 Markdown 失败')
    }
  }

  return (
    <div
      className="confirm-backdrop export-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-export-title"
      >
        <header>
          <span>
            <small>单条对话</small>
            <h2 id="conversation-export-title">导出完整正文</h2>
          </span>
          <button type="button" aria-label="关闭导出" onClick={onClose}>×</button>
        </header>
        <p className="export-dialog-description">
          按插件保存顺序原样输出 Markdown，不生成摘要。复制适合直接粘贴，长对话建议下载文件。
        </p>
        <label className="export-field">
          <span>消息范围</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as MessageExportRange['mode'])}
          >
            <option value="all">全部 {conversation.messages.length} 条</option>
            <option value="latest">最近若干条</option>
            <option value="earliest">最早若干条</option>
          </select>
        </label>
        {mode !== 'all' && (
          <label className="export-field">
            <span>消息数量</span>
            <input
              type="number"
              min="1"
              max={conversation.messages.length}
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
            />
          </label>
        )}
        <div className="export-dialog-note">
          附件在 Markdown 中保留名称、大小和状态，不嵌入本地二进制副本。
        </div>
        <footer>
          <button className="export-secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="export-secondary" type="button" onClick={() => void copyMarkdown()}>
            复制内容
          </button>
          <button className="export-primary" type="button" onClick={downloadMarkdown}>
            下载 Markdown
          </button>
        </footer>
      </section>
    </div>
  )
}
