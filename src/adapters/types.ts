import type { ChatMessage, ExtractedConversation, Platform } from '../shared/models'

export interface AIAdapter {
  readonly platform: Platform
  isConversationPage(): boolean
  getConversationId(): string | null
  getConversationIdFromTarget(target: EventTarget | null): string | null
  getTitle(): string
  getMessages(): ChatMessage[]
  getAccountIdentifier(): string | null
  getAccountLabel(): string
  getConversationContainer(): Element | null
  getConversationObservationContainer(): Element | null
  getSidebarContainer(): Element | null
  getConversationSidebarElement(conversationId: string): Element | null
  supportsPinnedConversations(): boolean
  isPinActionTarget(target: EventTarget | null): boolean
  isUnpinActionTarget(target: EventTarget | null): boolean
  isCurrentConversationPinned(): boolean
  /** Observe user-revealed platform message times; returns a cleanup function. */
  observeMessageTimes?(onCaptured: () => void): () => void
  /** Explicit, user-triggered complete DOM collection for virtualized hosts. */
  collectConversation?(
    onProgress?: (messageCount: number) => void,
    isCancelled?: () => boolean,
  ): Promise<ExtractedConversation | null>
  extractConversation(): ExtractedConversation | null
}
