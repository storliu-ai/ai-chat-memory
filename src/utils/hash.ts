import type {
  ChatMessage,
  ConversationAttachment,
  Platform,
} from '../shared/models'
import { stableSerialize } from './stable-serialize'
import { CHATGPT_UNKNOWN_ACCOUNT_ID, normalizeChatGPTAccountEmail } from '../shared/chatgpt-account'

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function normalizeAccountIdentifier(identifier: string): string {
  return identifier.normalize('NFKC').trim().toLowerCase()
}

export async function createAccountId(
  platform: Platform,
  identifier: string | null,
): Promise<string> {
  if (platform === 'chatgpt') {
    const email = normalizeChatGPTAccountEmail(identifier)
    return email === null
      ? CHATGPT_UNKNOWN_ACCOUNT_ID
      : `chatgpt:email:${await sha256Hex(`chatgpt:email:${email}`)}`
  }

  if (identifier === null || normalizeAccountIdentifier(identifier) === '') {
    return `${platform}:unknown`
  }

  return sha256Hex(`${platform}:${normalizeAccountIdentifier(identifier)}`)
}

export async function createConversationId(
  platform: Platform,
  accountId: string,
  conversationId: string,
): Promise<string> {
  return sha256Hex(`${platform}\0${accountId}\0${conversationId}`)
}

export function serializeConversationContent(
  title: string,
  messages: ChatMessage[],
  attachments: ConversationAttachment[] = [],
): string {
  return stableSerialize(
    attachments.length > 0
      ? { title, messages, attachments }
      : { title, messages },
  )
}

export async function createContentHash(
  title: string,
  messages: ChatMessage[],
  attachments: ConversationAttachment[] = [],
): Promise<string> {
  return sha256Hex(serializeConversationContent(title, messages, attachments))
}
