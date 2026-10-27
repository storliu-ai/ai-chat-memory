import type { Platform } from './models'

export const CONTENT_EVENT_SOURCE = 'ai-chat-memory-background'

export interface ConversationDeletedContentEvent {
  source: typeof CONTENT_EVENT_SOURCE
  type: 'CONVERSATION_DELETED'
  platform: Platform
  conversationId: string
}

export function isConversationDeletedContentEvent(
  value: unknown,
): value is ConversationDeletedContentEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const event = value as Partial<ConversationDeletedContentEvent>
  return (
    event.source === CONTENT_EVENT_SOURCE &&
    event.type === 'CONVERSATION_DELETED' &&
    (event.platform === 'chatgpt' ||
      event.platform === 'gemini' ||
      event.platform === 'deepseek') &&
    typeof event.conversationId === 'string' &&
    event.conversationId !== ''
  )
}
