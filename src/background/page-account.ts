import { EXTENSION_BUILD_ID } from '../shared/build-id'
import { SHARE_SOURCE_CONTEXT_REQUEST, getChatGPTSourceId } from '../shared/share-capture'
import { createAccountId } from '../utils/hash'

/** Recheck the exact originating document at each ChatGPT DOM write boundary. */
export async function isChatGPTPageAccountCurrent(
  sender: chrome.runtime.MessageSender,
  conversationId: string,
  accountId: string,
): Promise<boolean> {
  if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.documentId) return false
  try {
    if (new URL(sender.url ?? '').origin !== 'https://chatgpt.com') return false
    const response: unknown = await chrome.tabs.sendMessage(sender.tab.id,
      { type: SHARE_SOURCE_CONTEXT_REQUEST }, { documentId: sender.documentId })
    if (!response || typeof response !== 'object') return false
    const context = response as { platform?: unknown; conversationId?: unknown; url?: unknown; accountIdentifier?: unknown; contentScriptBuildId?: unknown }
    if (context.platform !== 'chatgpt' || context.contentScriptBuildId !== EXTENSION_BUILD_ID ||
      context.conversationId !== conversationId || typeof context.url !== 'string' || getChatGPTSourceId(context.url) !== conversationId ||
      context.accountIdentifier !== null && typeof context.accountIdentifier !== 'string') return false
    return await createAccountId('chatgpt', context.accountIdentifier as string | null) === accountId
  } catch {
    return false
  }
}
