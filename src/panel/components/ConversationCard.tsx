import { PLATFORM_LABELS, type LibraryConversation } from '../../shared/models'
import type { DisplayColorToken } from '../../shared/display-colors'
import { getManagerConversationColorStyle } from '../conversation-colors'

interface ConversationCardProps {
  conversation: LibraryConversation
  onOpen: () => void
  onDelete: () => void
  onToggleImportant: () => void
  accountColor: DisplayColorToken | undefined
  environmentColor: DisplayColorToken | undefined
}

function formatUpdatedAt(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return `今天 ${new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)}`
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function getSummary(conversation: LibraryConversation): string {
  const content = conversation.messages.find((message) => message.content.trim() !== '')?.content
  if (!content) {
    return '暂无内容摘要'
  }
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
}

export function ConversationCard({
  conversation,
  onOpen,
  onDelete,
  onToggleImportant,
  accountColor,
  environmentColor,
}: ConversationCardProps) {
  return (
    <article className={[
      'conversation-card',
      conversation.important ? 'conversation-card-important' : '',
      conversation.sourceIsLocal ? '' : 'conversation-card-readonly',
    ].filter(Boolean).join(' ')} style={getManagerConversationColorStyle(
      accountColor,
      environmentColor,
    )}>
      <button className="card-main" type="button" onClick={onOpen}>
        <span className="card-eyebrow">
          {conversation.important && <span aria-hidden="true">★ </span>}
          <span>{PLATFORM_LABELS[conversation.platform]}</span>
          {conversation.pendingCapture && <span className="capture-status capture-status-pending">待补全</span>}
          <span aria-hidden="true">·</span>
          <span
            className={accountColor === undefined
              ? 'account-color-tag'
              : 'account-color-tag account-color-tag-colored'}
            title={`账户：${conversation.accountLabel}`}
          >
            {conversation.accountLabel}
          </span>
          {!conversation.sourceIsLocal && (
            <span className="source-environment-pill">
              {conversation.sourceEnvironmentLabel}
            </span>
          )}
        </span>
        <strong>{conversation.title}</strong>
        <span className="card-meta">
          {formatUpdatedAt(conversation.updatedAt)} · {conversation.messageCount} 条消息
        </span>
        <span className="card-summary">{getSummary(conversation)}</span>
      </button>
      <div className="card-actions">
        {conversation.sourceIsLocal && (
          <button
            className={conversation.important ? 'card-important active' : 'card-important'}
            type="button"
            onClick={onToggleImportant}
            aria-label={`${conversation.important ? '取消' : '标记'}重要对话：${conversation.title}`}
            title={conversation.important ? '取消重要标记' : '标记为重要'}
          >
            {conversation.important ? '★' : '☆'}
          </button>
        )}
        <button
          className="card-delete"
          type="button"
          onClick={onDelete}
          aria-label={`删除 ${conversation.title}`}
          title={conversation.sourceIsLocal ? '删除对话' : '从来源环境删除对话'}
        >
          ×
        </button>
      </div>
    </article>
  )
}
