import { GeminiAdapter } from './gemini-adapter'
import { getGeminiShareId } from './capture-urls'
import { collectConversationByScrolling } from '../dom-scroll-collector'
import type { ExtractedConversation } from '../../shared/models'

/** Used only by an explicitly authorized, extension-owned share task. */
export class GeminiShareAdapter extends GeminiAdapter {
  getConversationId(): string | null { return getGeminiShareId(location.href) }
  supportsPinnedConversations(): boolean { return false }
  isCurrentConversationPinned(): boolean { return false }
  getAccountIdentifier(): null { return null }
  getAccountLabel(): string { return 'Unknown' }

  async collectShareConversation(beforeStep: () => Promise<void>, onProgress: (count: number) => void, onScanProgress: (coverage: number) => void = () => undefined): Promise<ExtractedConversation | null> {
    const container = this.getConversationContainer(), id = this.getConversationId()
    if (!container || !id) return null
    const aliases = new Map<string, string[]>()
    const key = (message: ExtractedConversation['messages'][number]): string => JSON.stringify([message.role, message.sourceOrder, message.content])
    const extract = (): ExtractedConversation | null => {
      const capture = this.extractDomShareConversation()
      capture?.messages.forEach((message, index) => aliases.set(key(message), capture.domMessageAliases?.[index] ?? [message.content]))
      return capture
    }
    const capture = await collectConversationByScrolling({
      container, getContainer: () => this.getConversationContainer(), conversationId: id,
      getConversationId: () => this.getConversationId(), extractConversation: extract,
      turnSelector: 'share-turn-viewer', strategy: 'overlapping-forward', beforeStep, onProgress, onScanProgress,
      hasPendingRenderedTurns: () => {
        const turns = [...(this.getConversationContainer()?.querySelectorAll('share-turn-viewer') ?? [])]
        const capture = this.extractDomShareConversation()
        return !turns.length || !capture || capture.messages.length !== turns.length * 2 || capture.messages.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user') || message.sourceOrder !== index || !message.content.trim() && !message.attachmentNames?.length) || turns.some((turn) => !!turn.querySelector('[aria-busy="true"], mat-progress-spinner, .response-loading'))
      },
      getSourceOrderTarget: (order) => {
        const prompt = this.getConversationContainer()?.querySelector(`#user-query-content-${Math.floor(order / 2)}`)
        const turn = prompt?.closest('share-turn-viewer')
        return order % 2 ? turn?.querySelector('.presented-response-container, response-container') ?? turn ?? null : prompt ?? null
      },
    })
    return capture ? { ...capture, domMessageAliases: capture.messages.map((message) => aliases.get(key(message)) ?? [message.content]) } : null
  }
}
