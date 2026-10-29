import type {
  Conversation,
  ConversationExclusion,
  ConversationSaveMode,
} from '../shared/models'
import {
  openDatabase,
  requestToPromise,
  STORE_NAME,
  transactionToPromise,
} from './database'
import { createConversationId } from '../utils/hash'
import { CHATGPT_UNKNOWN_ACCOUNT_ID } from '../shared/chatgpt-account'

function createExclusion(conversation: Conversation): ConversationExclusion {
  return {
    id: conversation.id,
    platform: conversation.platform,
    accountId: conversation.accountId,
    conversationId: conversation.conversationId,
    title: conversation.title,
    excludedAt: Date.now(),
  }
}

export async function putConversationWithExclusionPolicy(
  conversation: Conversation,
  saveMode: ConversationSaveMode,
): Promise<Conversation | null> {
  // An old unknown-account exclusion cannot be attributed to a login. Retain
  // its conservative automatic-insertion block. Once explicitly restored, an
  // identified record may update without reassigning the historical tombstone.
  const legacyExclusionId = conversation.platform === 'chatgpt' && conversation.accountId !== CHATGPT_UNKNOWN_ACCOUNT_ID
    ? await createConversationId('chatgpt', CHATGPT_UNKNOWN_ACCOUNT_ID, conversation.conversationId)
    : conversation.id
  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      [STORE_NAME.CONVERSATIONS, STORE_NAME.CONVERSATION_EXCLUSIONS],
      'readwrite',
    )
    const completion = transactionToPromise(transaction)
    const conversationStore = transaction.objectStore(STORE_NAME.CONVERSATIONS)
    const exclusionStore = transaction.objectStore(
      STORE_NAME.CONVERSATION_EXCLUSIONS,
    )
    const exclusion = await requestToPromise<ConversationExclusion | undefined>(
      exclusionStore.get(conversation.id),
    )
    const legacyExclusion = saveMode === 'automatic' && legacyExclusionId !== conversation.id
      ? await requestToPromise<ConversationExclusion | undefined>(exclusionStore.get(legacyExclusionId))
      : undefined
    const existing = legacyExclusion !== undefined
      ? await requestToPromise<Conversation | undefined>(conversationStore.get(conversation.id))
      : undefined

    if ((exclusion !== undefined || legacyExclusion !== undefined && existing === undefined) && saveMode === 'automatic') {
      await completion
      return null
    }

    const writes: Promise<unknown>[] = [
      requestToPromise(conversationStore.put(conversation)),
    ]
    if (saveMode === 'manual') {
      writes.push(requestToPromise(exclusionStore.delete(conversation.id)))
    }
    await Promise.all([...writes, completion])
    return conversation
  } finally {
    database.close()
  }
}

export interface ConversationDeletionResult {
  deleted: boolean
  excluded: boolean
}

export async function deleteConversationWithExclusionPolicy(
  id: string,
  sharedRequest?: { environmentId: string; requestId: string },
): Promise<ConversationDeletionResult> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      [STORE_NAME.CONVERSATIONS, STORE_NAME.CONVERSATION_EXCLUSIONS,
        ...(sharedRequest ? [STORE_NAME.ENVIRONMENT] : [])],
      'readwrite',
    )
    const completion = transactionToPromise(transaction)
    const conversationStore = transaction.objectStore(STORE_NAME.CONVERSATIONS)
    const exclusionStore = transaction.objectStore(
      STORE_NAME.CONVERSATION_EXCLUSIONS,
    )
    const receiptKey = sharedRequest
      ? `shared-deletion:${sharedRequest.environmentId}:${sharedRequest.requestId}`
      : null
    if (receiptKey !== null) {
      const receiptStore = transaction.objectStore(STORE_NAME.ENVIRONMENT)
      if (await requestToPromise(receiptStore.get(receiptKey)) !== undefined) {
        await completion
        return { deleted: false, excluded: false }
      }
      // The receipt and deletion commit together. Retrying a pending file after
      // a crash must not delete a conversation that was manually restored later.
      await requestToPromise(receiptStore.put({ key: receiptKey }))
    }
    const conversation = await requestToPromise<Conversation | undefined>(
      conversationStore.get(id),
    )
    if (conversation === undefined) {
      await completion
      return { deleted: false, excluded: false }
    }

    const writes: Promise<unknown>[] = [
      requestToPromise(conversationStore.delete(id)),
    ]
    if (conversation.pinned === true) {
      writes.push(requestToPromise(exclusionStore.put(createExclusion(conversation))))
    } else {
      // An ordinary, unpinned deletion is only a local removal. Make sure an
      // obsolete exclusion cannot survive from older extension versions.
      writes.push(requestToPromise(exclusionStore.delete(id)))
    }
    await Promise.all([...writes, completion])
    return { deleted: true, excluded: conversation.pinned === true }
  } finally {
    database.close()
  }
}

export async function getConversationExclusions(): Promise<ConversationExclusion[]> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      STORE_NAME.CONVERSATION_EXCLUSIONS,
      'readonly',
    )
    const request = transaction
      .objectStore(STORE_NAME.CONVERSATION_EXCLUSIONS)
      .getAll()
    const [exclusions] = await Promise.all([
      requestToPromise<ConversationExclusion[]>(request),
      transactionToPromise(transaction),
    ])
    return exclusions.sort((left, right) => right.excludedAt - left.excludedAt)
  } finally {
    database.close()
  }
}

export async function deleteConversationExclusion(id: string): Promise<boolean> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      STORE_NAME.CONVERSATION_EXCLUSIONS,
      'readwrite',
    )
    const store = transaction.objectStore(STORE_NAME.CONVERSATION_EXCLUSIONS)
    const completion = transactionToPromise(transaction)
    const existing = await requestToPromise<ConversationExclusion | undefined>(
      store.get(id),
    )
    if (existing === undefined) {
      await completion
      return false
    }
    await Promise.all([requestToPromise(store.delete(id)), completion])
    return true
  } finally {
    database.close()
  }
}
