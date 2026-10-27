import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from '../db/database'
import type {
  Account,
  Conversation,
  ConversationAttachment,
  ConversationExclusion,
} from '../shared/models'
import { sanitizeChatGPTAccountLabel } from '../shared/account-labels'
import { mergeConversationAttachments } from '../shared/attachments'
import { createContentHash, createConversationId } from '../utils/hash'

export const CHATGPT_ACCOUNT_ID = 'unknown'

export interface ChatGPTAccountMigrationResult {
  changed: boolean
  mergedAccounts: number
  mergedConversations: number
}

function selectPreferredConversation(
  current: Conversation,
  candidate: Conversation,
): Conversation {
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt ? candidate : current
  }
  if (candidate.messageCount !== current.messageCount) {
    return candidate.messageCount > current.messageCount ? candidate : current
  }
  return candidate.contentHash > current.contentHash ? candidate : current
}

function mergeAttachments(
  conversations: Conversation[],
): ConversationAttachment[] {
  return conversations.reduce<ConversationAttachment[]>(
    (attachments, conversation) =>
      mergeConversationAttachments(attachments, conversation.attachments),
    [],
  )
}

function selectCanonicalAccount(
  accounts: Account[],
  conversations: Conversation[],
  exclusions: ConversationExclusion[],
): Account | null {
  if (
    accounts.length === 0 &&
    conversations.length === 0 &&
    exclusions.length === 0
  ) {
    return null
  }

  const sorted = [...accounts].sort((left, right) => {
    if ((left.source === 'manual') !== (right.source === 'manual')) {
      return left.source === 'manual' ? -1 : 1
    }
    return right.updatedAt - left.updatedAt
  })
  const manual = sorted.find((account) => account.source === 'manual')
  const detected = sorted.find(
    (account) =>
      account.source !== 'manual' &&
      sanitizeChatGPTAccountLabel(account.label) !== '',
  )
  const preferred = manual ?? detected
  const timestamps = [
    ...accounts.flatMap((account) => [account.createdAt, account.updatedAt]),
    ...conversations.flatMap((conversation) => [
      conversation.createdAt,
      conversation.updatedAt,
    ]),
    ...exclusions.map((exclusion) => exclusion.excludedAt),
  ]
  const now = Date.now()
  const label = preferred === undefined
    ? 'Unknown'
    : preferred.source === 'manual'
      ? preferred.label.trim()
      : sanitizeChatGPTAccountLabel(preferred.label) || 'Unknown'

  return {
    id: CHATGPT_ACCOUNT_ID,
    platform: 'chatgpt',
    label,
    source: preferred?.source === 'manual'
      ? 'manual'
      : label === 'Unknown'
        ? 'unknown'
        : 'detected',
    createdAt: timestamps.length > 0 ? Math.min(...timestamps) : now,
    updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : now,
  }
}

export async function canonicalizeChatGPTAccountData(): Promise<ChatGPTAccountMigrationResult> {
  const database = await openDatabase()
  try {
    const readTransaction = database.transaction(
      [
        STORE_NAME.ACCOUNTS,
        STORE_NAME.CONVERSATIONS,
        STORE_NAME.CONVERSATION_EXCLUSIONS,
      ],
      'readonly',
    )
    const [allAccounts, allConversations, allExclusions] = await Promise.all([
      requestToPromise<Account[]>(
        readTransaction.objectStore(STORE_NAME.ACCOUNTS).getAll(),
      ),
      requestToPromise<Conversation[]>(
        readTransaction.objectStore(STORE_NAME.CONVERSATIONS).getAll(),
      ),
      requestToPromise<ConversationExclusion[]>(
        readTransaction.objectStore(STORE_NAME.CONVERSATION_EXCLUSIONS).getAll(),
      ),
      transactionToPromise(readTransaction),
    ])
    const accounts = allAccounts.filter((account) => account.platform === 'chatgpt')
    const conversations = allConversations.filter(
      (conversation) => conversation.platform === 'chatgpt',
    )
    const exclusions = allExclusions.filter(
      (exclusion) => exclusion.platform === 'chatgpt',
    )
    const canonicalAccount = selectCanonicalAccount(
      accounts,
      conversations,
      exclusions,
    )

    const conversationGroups = new Map<string, Conversation[]>()
    for (const conversation of conversations) {
      const group = conversationGroups.get(conversation.conversationId) ?? []
      group.push(conversation)
      conversationGroups.set(conversation.conversationId, group)
    }
    const exclusionGroups = new Map<string, ConversationExclusion[]>()
    for (const exclusion of exclusions) {
      const group = exclusionGroups.get(exclusion.conversationId) ?? []
      group.push(exclusion)
      exclusionGroups.set(exclusion.conversationId, group)
    }

    const canonicalConversations: Conversation[] = []
    const canonicalExclusions: ConversationExclusion[] = []
    const remoteIds = new Set([
      ...conversationGroups.keys(),
      ...exclusionGroups.keys(),
    ])
    for (const conversationId of remoteIds) {
      const matches = conversationGroups.get(conversationId) ?? []
      const matchingExclusions = exclusionGroups.get(conversationId) ?? []
      const canonicalId = await createConversationId(
        'chatgpt',
        CHATGPT_ACCOUNT_ID,
        conversationId,
      )
      const latestExclusion = matchingExclusions.reduce<ConversationExclusion | null>(
        (latest, exclusion) =>
          latest === null || exclusion.excludedAt > latest.excludedAt
            ? exclusion
            : latest,
        null,
      )
      const preferred = matches.reduce<Conversation | null>(
        (current, candidate) =>
          current === null
            ? candidate
            : selectPreferredConversation(current, candidate),
        null,
      )

      if (
        latestExclusion !== null &&
        (preferred === null || latestExclusion.excludedAt >= preferred.updatedAt)
      ) {
        canonicalExclusions.push({
          ...latestExclusion,
          id: canonicalId,
          accountId: CHATGPT_ACCOUNT_ID,
        })
        continue
      }
      if (preferred === null) {
        continue
      }

      const attachments = mergeAttachments(matches)
      const imageAttachmentPermission = matches.some(
        (conversation) => conversation.imageAttachmentPermission === false,
      )
        ? false
        : matches.some(
            (conversation) => conversation.imageAttachmentPermission === true,
          )
          ? true
          : null
      canonicalConversations.push({
        ...preferred,
        id: canonicalId,
        accountId: CHATGPT_ACCOUNT_ID,
        ...(attachments.length > 0 ? { attachments } : { attachments: undefined }),
        createdAt: Math.min(...matches.map((conversation) => conversation.createdAt)),
        updatedAt: Math.max(...matches.map((conversation) => conversation.updatedAt)),
        contentHash: await createContentHash(
          preferred.title,
          preferred.messages,
          attachments,
        ),
        pinned: Boolean(preferred.pinned),
        important: matches.some((conversation) => Boolean(conversation.important)),
        imageAttachmentPermission,
        fileAttachmentPermission: matches.some((conversation) =>
          Boolean(conversation.fileAttachmentPermission),
        ),
      })
    }

    const accountChanged =
      accounts.some((account) => account.id !== CHATGPT_ACCOUNT_ID) ||
      accounts.length > 1 ||
      (canonicalAccount !== null && accounts.every((account) =>
        account.id !== canonicalAccount.id ||
        account.label !== canonicalAccount.label ||
        account.source !== canonicalAccount.source
      ))
    const conversationChanged = conversations.some((conversation) =>
      conversation.accountId !== CHATGPT_ACCOUNT_ID ||
      !canonicalConversations.some((canonical) =>
        canonical.id === conversation.id &&
        canonical.contentHash === conversation.contentHash &&
        canonical.pinned === Boolean(conversation.pinned) &&
        canonical.important === Boolean(conversation.important) &&
        canonical.imageAttachmentPermission === (
          typeof conversation.imageAttachmentPermission === 'boolean'
            ? conversation.imageAttachmentPermission
            : null
        ) &&
        canonical.fileAttachmentPermission === Boolean(
          conversation.fileAttachmentPermission,
        )
      )
    ) || canonicalConversations.length !== conversations.length
    const exclusionChanged = exclusions.some((exclusion) =>
      exclusion.accountId !== CHATGPT_ACCOUNT_ID ||
      !canonicalExclusions.some((canonical) =>
        canonical.id === exclusion.id &&
        canonical.excludedAt === exclusion.excludedAt
      )
    ) || canonicalExclusions.length !== exclusions.length

    if (!accountChanged && !conversationChanged && !exclusionChanged) {
      return {
        changed: false,
        mergedAccounts: 0,
        mergedConversations: 0,
      }
    }

    const writeTransaction = database.transaction(
      [
        STORE_NAME.ACCOUNTS,
        STORE_NAME.CONVERSATIONS,
        STORE_NAME.CONVERSATION_EXCLUSIONS,
      ],
      'readwrite',
    )
    const accountStore = writeTransaction.objectStore(STORE_NAME.ACCOUNTS)
    const conversationStore = writeTransaction.objectStore(STORE_NAME.CONVERSATIONS)
    const exclusionStore = writeTransaction.objectStore(
      STORE_NAME.CONVERSATION_EXCLUSIONS,
    )
    const requests: Promise<unknown>[] = [
      ...accounts.map((account) => requestToPromise(accountStore.delete(account.id))),
      ...conversations.map((conversation) =>
        requestToPromise(conversationStore.delete(conversation.id)),
      ),
      ...exclusions.map((exclusion) =>
        requestToPromise(exclusionStore.delete(exclusion.id)),
      ),
    ]
    if (canonicalAccount !== null) {
      requests.push(requestToPromise(accountStore.put(canonicalAccount)))
    }
    requests.push(
      ...canonicalConversations.map((conversation) =>
        requestToPromise(conversationStore.put(conversation)),
      ),
      ...canonicalExclusions.map((exclusion) =>
        requestToPromise(exclusionStore.put(exclusion)),
      ),
    )
    await Promise.all([...requests, transactionToPromise(writeTransaction)])

    return {
      changed: true,
      mergedAccounts: Math.max(0, accounts.length - (canonicalAccount === null ? 0 : 1)),
      mergedConversations: Math.max(
        0,
        conversations.length - canonicalConversations.length,
      ),
    }
  } finally {
    database.close()
  }
}
