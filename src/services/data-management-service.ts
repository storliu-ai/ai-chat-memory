import { getAllAccounts } from '../db/accounts'
import { getAllConversations } from '../db/conversations'
import { isLegacyChatGPTProfileLabel } from '../shared/account-labels'
import { CHATGPT_UNKNOWN_ACCOUNT_ID, CHATGPT_UNKNOWN_ACCOUNT_LABEL } from '../shared/chatgpt-account'
import {
  openDatabase,
  requestToPromise,
  STORE_NAME,
  transactionToPromise,
} from '../db/database'
import { initializeSettings } from '../db/settings'
import type {
  Account,
  ChatMessage,
  ConversationAttachment,
  Conversation,
  ExportData,
  ImportResult,
} from '../shared/models'
import { createContentHash, createConversationId } from '../utils/hash'
import { ImportValidationError } from './errors'
import {
  hasValidStoredConversationAttachments,
  isAccountSource,
  isChatMessage,
  isFiniteTimestamp,
  isPlatform,
  isPendingCapture,
  isRecord,
} from './validation'

interface ValidatedImport {
  accounts: Account[]
  conversations: Conversation[]
}

function mergeImageAttachmentPermission(
  left: Conversation['imageAttachmentPermission'] | undefined,
  right: Conversation['imageAttachmentPermission'] | undefined,
): Conversation['imageAttachmentPermission'] {
  if (left === false || right === false) {
    return false
  }
  if (left === true || right === true) {
    return true
  }
  return null
}

function getConversationIdentityKey(
  conversation: Pick<Conversation, 'platform' | 'accountId' | 'conversationId'>,
): string {
  return `${conversation.platform}\0${conversation.accountId}\0${conversation.conversationId}`
}

export function selectPreferredConversation(
  current: Conversation,
  candidate: Conversation,
): Conversation {
  let preferred: Conversation
  if (candidate.updatedAt !== current.updatedAt) {
    preferred = candidate.updatedAt > current.updatedAt ? candidate : current
  } else if (candidate.messageCount !== current.messageCount) {
    preferred = candidate.messageCount > current.messageCount ? candidate : current
  } else {
    preferred = candidate.contentHash > current.contentHash ? candidate : current
  }
  return {
    ...preferred,
    pinned: Boolean(preferred.pinned),
    important: Boolean(current.important) || Boolean(candidate.important),
    imageAttachmentPermission: mergeImageAttachmentPermission(
      current.imageAttachmentPermission,
      candidate.imageAttachmentPermission,
    ),
    fileAttachmentPermission:
      Boolean(current.fileAttachmentPermission) ||
      Boolean(candidate.fileAttachmentPermission),
  }
}

export function selectPreferredAccount(
  current: Account,
  candidate: Account,
): Account {
  const rank = (account: Account): number => {
    if (account.source === 'manual') {
      return 2
    }
    return account.source === 'detected' ? 1 : 0
  }
  const currentRank = rank(current)
  const candidateRank = rank(candidate)
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank ? candidate : current
  }
  return candidate.updatedAt > current.updatedAt ? candidate : current
}

function parseImportData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) {
        return parsed
      }
    } catch {
      throw new ImportValidationError('The selected file is not valid JSON')
    }
  }
  if (!isRecord(value)) {
    throw new ImportValidationError('Import data must be a JSON object')
  }
  return value
}

export function validateAccount(value: unknown, index: number): Account {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    value.id.length > 128 ||
    !isPlatform(value.platform) ||
    typeof value.label !== 'string' ||
    value.label.trim() === '' ||
    value.label.length > 100 ||
    !isAccountSource(value.source) ||
    !isFiniteTimestamp(value.createdAt) ||
    !isFiniteTimestamp(value.updatedAt) ||
    value.createdAt > value.updatedAt
  ) {
    throw new ImportValidationError(`Account ${index + 1} has an invalid structure`)
  }

  const unknownChatGPT = value.platform === 'chatgpt' && value.id === CHATGPT_UNKNOWN_ACCOUNT_ID && value.source !== 'manual'
  const label = unknownChatGPT ? CHATGPT_UNKNOWN_ACCOUNT_LABEL : value.platform === 'chatgpt' &&
    value.source !== 'manual' &&
    isLegacyChatGPTProfileLabel(value.label)
    ? 'Unknown'
    : value.label
  const source = unknownChatGPT || label === 'Unknown' && label !== value.label
    ? 'unknown'
    : value.source

  return {
    id: value.id,
    platform: value.platform,
    label,
    source,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function isValidConversationUrl(
  value: string,
  platform: Conversation['platform'],
  conversationId: string,
): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      return false
    }
    const routes: Record<Conversation['platform'], { host: string; path: RegExp }> = {
      chatgpt: { host: 'chatgpt.com', path: /^\/c\/([^/?#]+)/ },
      gemini: {
        host: 'gemini.google.com',
        path: /^(?:\/u\/\d+)?\/app\/([^/?#]+)/,
      },
      deepseek: { host: 'chat.deepseek.com', path: /^\/a\/chat\/s\/([^/?#]+)/ },
    }
    const route = routes[platform]
    const match = route.path.exec(url.pathname)
    return url.hostname === route.host &&
      match !== null &&
      decodeURIComponent(match[1]) === conversationId
  } catch {
    return false
  }
}

export async function validateConversation(
  value: unknown,
  index: number,
): Promise<Conversation> {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isPlatform(value.platform) ||
    typeof value.accountId !== 'string' ||
    value.accountId === '' ||
    value.accountId.length > 128 ||
    typeof value.conversationId !== 'string' ||
    value.conversationId === '' ||
    value.conversationId.length > 512 ||
    typeof value.title !== 'string' ||
    value.title.trim() === '' ||
    typeof value.url !== 'string' ||
    !isValidConversationUrl(value.url, value.platform, value.conversationId) ||
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    !value.messages.every(isChatMessage) ||
    !hasValidStoredConversationAttachments(value.attachments) ||
    (Array.isArray(value.attachments) && value.attachments.some((attachment) =>
      isRecord(attachment) &&
      attachment.messageIndex !== undefined &&
      Number(attachment.messageIndex) >= (
        Array.isArray(value.messages) ? value.messages.length : 0
      )
    )) ||
    !isFiniteTimestamp(value.createdAt) ||
    !isFiniteTimestamp(value.updatedAt) ||
    value.createdAt > value.updatedAt ||
    typeof value.messageCount !== 'number' ||
    value.messageCount !== value.messages.length ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.contentHash) ||
    (value.pinned !== undefined && typeof value.pinned !== 'boolean') ||
    (value.important !== undefined && typeof value.important !== 'boolean') ||
    (value.imageAttachmentPermission !== undefined &&
      value.imageAttachmentPermission !== null &&
      typeof value.imageAttachmentPermission !== 'boolean') ||
    (value.pendingCapture !== undefined && !isPendingCapture(value.pendingCapture)) ||
    (value.fileAttachmentPermission !== undefined &&
      typeof value.fileAttachmentPermission !== 'boolean')
  ) {
    throw new ImportValidationError(`Conversation ${index + 1} has an invalid structure`)
  }

  const messages: ChatMessage[] = value.messages
  const attachments = (value.attachments ?? []) as ConversationAttachment[]
  const contentHash = await createContentHash(value.title, messages, attachments)
  if (contentHash !== value.contentHash.toLowerCase()) {
    throw new ImportValidationError(`Conversation ${index + 1} has an invalid content hash`)
  }

  const accountId = value.accountId
  const id = await createConversationId(value.platform, accountId, value.conversationId)
  return {
    id,
    platform: value.platform,
    accountId,
    conversationId: value.conversationId,
    title: value.title,
    url: value.url,
    messages,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messageCount: messages.length,
    contentHash,
    pinned: value.pinned === true,
    important: value.important === true,
    imageAttachmentPermission:
      typeof value.imageAttachmentPermission === 'boolean'
        ? value.imageAttachmentPermission
        : null,
    fileAttachmentPermission: value.fileAttachmentPermission === true,
    ...(value.pendingCapture ? { pendingCapture: value.pendingCapture as Conversation['pendingCapture'] } : {}),
  }
}

async function validateImport(value: unknown): Promise<ValidatedImport> {
  const data = parseImportData(value)
  if (data.version !== 1) {
    throw new ImportValidationError('Only export version 1 is supported')
  }
  if (!Array.isArray(data.accounts) || !Array.isArray(data.conversations)) {
    throw new ImportValidationError('Import accounts and conversations must be arrays')
  }

  const validatedAccounts = data.accounts.map(validateAccount)
  const validatedConversations = await Promise.all(
    data.conversations.map(validateConversation),
  )

  const accountMap = new Map<string, Account>()
  for (const account of validatedAccounts) {
    const existing = accountMap.get(account.id)
    accountMap.set(
      account.id,
      existing === undefined ? account : selectPreferredAccount(existing, account),
    )
  }

  const conversationMap = new Map<string, Conversation>()
  for (const conversation of validatedConversations) {
    const identityKey = getConversationIdentityKey(conversation)
    const existing = conversationMap.get(identityKey)
    conversationMap.set(
      identityKey,
      existing === undefined
        ? conversation
        : selectPreferredConversation(existing, conversation),
    )
  }

  return { accounts: [...accountMap.values()], conversations: [...conversationMap.values()] }
}

export async function exportAllData(): Promise<ExportData> {
  const [accounts, conversations] = await Promise.all([
    getAllAccounts(),
    getAllConversations(),
  ])
  return {
    version: 1,
    exportedAt: Date.now(),
    accounts,
    conversations,
  }
}

export async function importAllData(value: unknown): Promise<ImportResult> {
  const incoming = await validateImport(value)
  const [existingAccounts, existingConversations] = await Promise.all([
    getAllAccounts(),
    getAllConversations(),
  ])
  const accountMap = new Map(existingAccounts.map((account) => [account.id, account]))
  const conversationsByIdentity = new Map<string, Conversation[]>()
  for (const conversation of existingConversations) {
    const identityKey = getConversationIdentityKey(conversation)
    const matches = conversationsByIdentity.get(identityKey)
    if (matches === undefined) {
      conversationsByIdentity.set(identityKey, [conversation])
    } else {
      matches.push(conversation)
    }
  }

  const knownAccounts = new Map(existingAccounts.map((account) => [account.id, account]))
  incoming.accounts.forEach((account) => knownAccounts.set(account.id, account))
  for (const conversation of incoming.conversations) {
    const known = knownAccounts.get(conversation.accountId)
    if (known && known.platform !== conversation.platform) throw new ImportValidationError('Conversation account platform mismatch')
    if (known !== undefined) {
      continue
    }
    if (
      conversation.accountId !== 'unknown' &&
      !conversation.accountId.endsWith(':unknown')
    ) {
      throw new ImportValidationError(
        `Conversation ${conversation.conversationId} references a missing account`,
      )
    }
    const unknownAccount: Account = {
      id: conversation.accountId,
      platform: conversation.platform,
      label: conversation.platform === 'chatgpt' ? CHATGPT_UNKNOWN_ACCOUNT_LABEL : 'Unknown',
      source: 'unknown',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    }
    incoming.accounts.push(unknownAccount)
    knownAccounts.set(unknownAccount.id, unknownAccount)
  }

  const accountWrites = incoming.accounts.filter((account) => {
    const existing = accountMap.get(account.id)
    return existing === undefined || selectPreferredAccount(existing, account) === account
  })

  const conversationWrites: Conversation[] = []
  const conversationDeletes = new Set<string>()
  const exclusionDeletes = new Set(
    incoming.conversations.map((conversation) => conversation.id),
  )
  let inserted = 0
  let updated = 0
  let unchanged = 0

  for (const conversation of incoming.conversations) {
    const identityKey = getConversationIdentityKey(conversation)
    const matches = conversationsByIdentity.get(identityKey) ?? []
    const existing = matches.reduce<Conversation | undefined>(
      (preferred, candidate) =>
        preferred === undefined
          ? candidate
          : selectPreferredConversation(preferred, candidate),
      undefined,
    )
    const earliestCreatedAt = matches.reduce(
      (earliest, candidate) => Math.min(earliest, candidate.createdAt),
      conversation.createdAt,
    )
    const important = Boolean(existing?.important) || Boolean(conversation.important)
    const imageAttachmentPermission = mergeImageAttachmentPermission(
      existing?.imageAttachmentPermission,
      conversation.imageAttachmentPermission,
    )
    const fileAttachmentPermission =
      Boolean(existing?.fileAttachmentPermission) ||
      Boolean(conversation.fileAttachmentPermission)

    for (const match of matches) {
      if (match.id !== conversation.id) {
        conversationDeletes.add(match.id)
      }
    }

    if (existing === undefined) {
      conversationWrites.push({
        ...conversation,
        important,
        imageAttachmentPermission,
        fileAttachmentPermission,
      })
      inserted += 1
    } else if (
      (existing.contentHash !== conversation.contentHash || JSON.stringify(existing.pendingCapture) !== JSON.stringify(conversation.pendingCapture)) &&
      conversation.updatedAt > existing.updatedAt
    ) {
      conversationWrites.push({
        ...conversation,
        createdAt: earliestCreatedAt,
        important,
        imageAttachmentPermission,
        fileAttachmentPermission,
      })
      updated += 1
    } else {
      unchanged += 1
      if (
        existing.id !== conversation.id ||
        matches.length > 1 ||
        Boolean(existing.important) !== important ||
        existing.imageAttachmentPermission !== imageAttachmentPermission ||
        Boolean(existing.fileAttachmentPermission) !== fileAttachmentPermission
      ) {
        conversationWrites.push({
          ...existing,
          id: conversation.id,
          createdAt: earliestCreatedAt,
          important,
          imageAttachmentPermission,
          fileAttachmentPermission,
        })
      }
    }
  }

  if (
    accountWrites.length === 0 &&
    conversationWrites.length === 0 &&
    conversationDeletes.size === 0 &&
    exclusionDeletes.size === 0
  ) {
    return { inserted, updated, unchanged }
  }

  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      [
        STORE_NAME.ACCOUNTS,
        STORE_NAME.CONVERSATIONS,
        STORE_NAME.CONVERSATION_EXCLUSIONS,
      ],
      'readwrite',
    )
    const accountStore = transaction.objectStore(STORE_NAME.ACCOUNTS)
    const conversationStore = transaction.objectStore(STORE_NAME.CONVERSATIONS)
    const exclusionStore = transaction.objectStore(
      STORE_NAME.CONVERSATION_EXCLUSIONS,
    )
    const requests = [
      ...accountWrites.map((account) => requestToPromise(accountStore.put(account))),
      ...conversationWrites.map((conversation) =>
        requestToPromise(conversationStore.put(conversation)),
      ),
      ...[...conversationDeletes].map((id) =>
        requestToPromise(conversationStore.delete(id)),
      ),
      ...[...exclusionDeletes].map((id) =>
        requestToPromise(exclusionStore.delete(id)),
      ),
    ]
    await Promise.all([...requests, transactionToPromise(transaction)])
  } finally {
    database.close()
  }

  return { inserted, updated, unchanged }
}

export async function deleteAllData(): Promise<{ deletedConversations: number }> {
  const conversations = await getAllConversations()
  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      [
        STORE_NAME.CONVERSATIONS,
        STORE_NAME.CONVERSATION_EXCLUSIONS,
        STORE_NAME.ACCOUNTS,
        STORE_NAME.SETTINGS,
      ],
      'readwrite',
    )
    const requests = [
      requestToPromise(transaction.objectStore(STORE_NAME.CONVERSATIONS).clear()),
      requestToPromise(
        transaction.objectStore(STORE_NAME.CONVERSATION_EXCLUSIONS).clear(),
      ),
      requestToPromise(transaction.objectStore(STORE_NAME.ACCOUNTS).clear()),
      requestToPromise(transaction.objectStore(STORE_NAME.SETTINGS).clear()),
    ]
    await Promise.all([...requests, transactionToPromise(transaction)])
  } finally {
    database.close()
  }

  await initializeSettings()
  return { deletedConversations: conversations.length }
}
