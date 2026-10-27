import type { Conversation, Platform } from '../shared/models'
import {
  CONVERSATION_INDEX,
  openDatabase,
  requestToPromise,
  STORE_NAME,
  transactionToPromise,
} from './database'

function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    pinned: Boolean(conversation.pinned),
    important: Boolean(conversation.important),
    imageAttachmentPermission:
      typeof conversation.imageAttachmentPermission === 'boolean'
        ? conversation.imageAttachmentPermission
        : null,
    fileAttachmentPermission: Boolean(conversation.fileAttachmentPermission),
  }
}

export async function putConversation(conversation: Conversation): Promise<Conversation> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.CONVERSATIONS).put(conversation)
    const result = requestToPromise(request)
    await Promise.all([result, transactionToPromise(transaction)])
    return conversation
  } finally {
    database.close()
  }
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readonly')
    const request = transaction.objectStore(STORE_NAME.CONVERSATIONS).get(id)
    const [conversation] = await Promise.all([
      requestToPromise<Conversation | undefined>(request),
      transactionToPromise(transaction),
    ])
    return conversation === undefined ? null : normalizeConversation(conversation)
  } finally {
    database.close()
  }
}

export async function getAllConversations(): Promise<Conversation[]> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readonly')
    const request = transaction.objectStore(STORE_NAME.CONVERSATIONS).getAll()
    const [conversations] = await Promise.all([
      requestToPromise<Conversation[]>(request),
      transactionToPromise(transaction),
    ])
    return conversations.map(normalizeConversation)
  } finally {
    database.close()
  }
}

export async function getConversationsBySource(
  platform: Platform,
  conversationId: string,
): Promise<Conversation[]> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readonly')
    const request = transaction
      .objectStore(STORE_NAME.CONVERSATIONS)
      .index(CONVERSATION_INDEX.CONVERSATION_ID)
      .getAll(conversationId)
    const [conversations] = await Promise.all([
      requestToPromise<Conversation[]>(request),
      transactionToPromise(transaction),
    ])
    return conversations
      .filter((conversation) => conversation.platform === platform)
      .map(normalizeConversation)
  } finally {
    database.close()
  }
}

export async function countConversations(): Promise<number> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readonly')
    const request = transaction.objectStore(STORE_NAME.CONVERSATIONS).count()
    const [count] = await Promise.all([
      requestToPromise<number>(request),
      transactionToPromise(transaction),
    ])
    return count
  } finally {
    database.close()
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.CONVERSATIONS).delete(id)
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}

export async function clearConversations(): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.CONVERSATIONS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.CONVERSATIONS).clear()
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}
