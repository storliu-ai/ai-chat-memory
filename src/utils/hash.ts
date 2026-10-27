import type {
  ChatMessage,
  ConversationAttachment,
  Platform,
} from '../shared/models'
import { stableSerialize } from './stable-serialize'

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
  // ChatGPT does not currently expose a stable account identifier in its
  // rendered, logged-in DOM. Profile-button text and avatar alt text are UI
  // labels (for example `PLUS` or `个人资料图片`) and can change without the
  // signed-in account changing. Keep the historical single-account key so one
  // ChatGPT login cannot split into multiple local accounts.
  if (platform === 'chatgpt') {
    return 'unknown'
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
