import { ChatGPTAdapter } from './chatgpt-adapter'
import { CHATGPT_SELECTORS } from './selectors'
import { collectConversationByScrolling } from '../dom-scroll-collector'
import { normalizeChatGPTShareUrl } from '../../shared/share-capture'
import type { ExtractedConversation } from '../../shared/models'

export class ChatGPTShareAdapter extends ChatGPTAdapter {
  protected includeSearchSourceOrder = true
  private renderedConversationId: string | null = null
  protected matchesRenderedConversationId(renderedId: string): boolean {
    // The public URL's share ID and the transcript's native conversation ID
    // are different identities. Bind the visible transcript once; never mix
    // unrelated retained or subsequently replaced transcripts.
    const ids = [...new Set(this.queryAll(CHATGPT_SELECTORS.CONVERSATION_ID)
      .filter((node) => node.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null)
      .map((node) => node.getAttribute('data-chatgpt-selection-conversation-id')))]
    if (ids.length !== 1 || !ids[0]) return false
    this.renderedConversationId ??= ids[0]
    return renderedId === this.renderedConversationId && ids[0] === this.renderedConversationId
  }
  getAccountIdentifier(): null { return null }
  getAccountLabel(): string { return 'Unknown' }
  getConversationId(): string | null {
    return normalizeChatGPTShareUrl(location.href)?.split('/').at(-1) ?? null
  }

  private getSourceOrderTarget(order: number): Element | null {
    const container = this.getConversationContainer()
    if (!container) return null
    const native = container.querySelector(`[data-testid="conversation-turn-${order}"]`)
    if (native) return native
    const turn = container.querySelector(`[data-content-search-turn-key="fallback-turn-${Math.floor(order / 2)}"]`)
    const role = order % 2 ? 'assistant' : 'user'
    return turn?.querySelector(`[data-chatgpt-search-unit-key$=":${role}"], [data-content-search-unit-key$=":${role}"]`) ??
      (role === 'assistant' && turn ? this.getCompletedThoughtLabel(turn) : null) ?? turn
  }

  async collectShareConversation(beforeStep: () => Promise<void>, onProgress: (count: number) => void, onScanProgress: (coverage: number) => void = () => undefined): Promise<ExtractedConversation | null> {
    const container = this.getConversationContainer()
    const conversationId = this.getConversationId()
    if (!container || !conversationId) return null
    return collectConversationByScrolling({
      container,
      getContainer: () => this.getConversationContainer(),
      conversationId,
      getConversationId: () => this.getConversationId(),
      extractConversation: () => this.extractConversation(),
      turnSelector: CHATGPT_SELECTORS.MESSAGE_TURN.join(','),
      strategy: 'overlapping-forward', beforeStep, onProgress, onScanProgress,
      hasPendingRenderedTurns: () => this.hasPendingRenderedTurns(),
      getVerifiedEmptySourceOrders: () => this.getVerifiedEmptySourceOrders(),
      getSourceOrderTarget: (order) => this.getSourceOrderTarget(order),
    })
  }
}
