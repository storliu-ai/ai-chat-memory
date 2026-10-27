export const EXTENSION_EVENT_SOURCE = 'ai-chat-memory-extension'

export interface ConversationUpdatedExtensionEvent {
  source: typeof EXTENSION_EVENT_SOURCE
  type: 'CONVERSATION_UPDATED'
  conversationId: string
}

export function isConversationUpdatedExtensionEvent(
  value: unknown,
): value is ConversationUpdatedExtensionEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const event = value as Partial<ConversationUpdatedExtensionEvent>
  return (
    event.source === EXTENSION_EVENT_SOURCE &&
    event.type === 'CONVERSATION_UPDATED' &&
    typeof event.conversationId === 'string' &&
    event.conversationId !== ''
  )
}
