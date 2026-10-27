import type { LibraryConversation } from '../../shared/models'
import type { DisplayColorAssignments } from '../../shared/display-colors'
import { ConversationCard } from './ConversationCard'

interface ConversationListProps {
  conversations: LibraryConversation[]
  onOpen: (conversation: LibraryConversation) => void
  onDelete: (conversation: LibraryConversation) => void
  onToggleImportant: (conversation: LibraryConversation) => void
  accountColors: DisplayColorAssignments
  environmentColors: DisplayColorAssignments
  environmentColorsEnabled: boolean
}

export function ConversationList({
  conversations,
  onOpen,
  onDelete,
  onToggleImportant,
  accountColors,
  environmentColors,
  environmentColorsEnabled,
}: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <div className="empty-state">
        <span aria-hidden="true">◎</span>
        <strong>还没有对话</strong>
        <p>打开一条支持的 AI 对话后会自动保存在本地。</p>
      </div>
    )
  }

  return (
    <div className="conversation-list">
      {conversations.map((conversation) => (
        <ConversationCard
          key={conversation.id}
          conversation={conversation}
          accountColor={accountColors[conversation.accountId]}
          environmentColor={environmentColorsEnabled
            ? environmentColors[conversation.sourceEnvironmentId]
            : undefined}
          onOpen={() => onOpen(conversation)}
          onDelete={() => onDelete(conversation)}
          onToggleImportant={() => onToggleImportant(conversation)}
        />
      ))}
    </div>
  )
}
