import { normalizeChatGPTShareUrl, type ChatGPTCaptureMode } from '../shared/share-capture'
import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from './database'
import type { ChatGPTSaveMethod } from '../shared/network-capture'

export async function getConversationSaveMethod(conversationId: string): Promise<ChatGPTSaveMethod | null> {
  const key = preferenceKey(conversationId).replace('capture-mode:', 'save-method:')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readonly')
    const [record] = await Promise.all([
      requestToPromise<{ method?: unknown } | undefined>(transaction.objectStore(STORE_NAME.SETTINGS).get(key)),
      transactionToPromise(transaction),
    ])
    return record?.method === 'dom' || record?.method === 'network' ? record.method : null
  } finally { database.close() }
}

export async function setConversationSaveMethod(conversationId: string, method: ChatGPTSaveMethod | null): Promise<ChatGPTSaveMethod | null> {
  const key = preferenceKey(conversationId).replace('capture-mode:', 'save-method:')
  if (method !== null && method !== 'dom' && method !== 'network') throw new Error('Invalid save method')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readwrite')
    const store = transaction.objectStore(STORE_NAME.SETTINGS)
    await Promise.all([method === null ? requestToPromise(store.delete(key)) : requestToPromise(store.put({ key, method })), transactionToPromise(transaction)])
    return method
  } finally { database.close() }
}

function preferenceKey(conversationId: string): string {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 256) {
    throw new Error('Invalid conversation ID')
  }
  return `capture-mode:chatgpt:${conversationId}`
}

/** Local preferences also apply before the first save; clearing data clears them. */
export async function getConversationCaptureMode(conversationId: string): Promise<ChatGPTCaptureMode | null> {
  const key = preferenceKey(conversationId)
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readonly')
    const [record] = await Promise.all([
      requestToPromise<{ mode?: unknown } | undefined>(transaction.objectStore(STORE_NAME.SETTINGS).get(key)),
      transactionToPromise(transaction),
    ])
    return record?.mode === 'conversation' || record?.mode === 'share' ? record.mode : null
  } finally {
    database.close()
  }
}

export async function setConversationCaptureMode(conversationId: string, mode: ChatGPTCaptureMode | null): Promise<ChatGPTCaptureMode | null> {
  const key = preferenceKey(conversationId)
  if (mode !== null && mode !== 'conversation' && mode !== 'share') throw new Error('Invalid capture mode')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readwrite')
    const store = transaction.objectStore(STORE_NAME.SETTINGS)
    const write = mode === null ? requestToPromise(store.delete(key)) : requestToPromise(store.put({ key, mode }))
    await Promise.all([write, transactionToPromise(transaction)])
    return mode
  } finally {
    database.close()
  }
}

/** Explicitly pasted links are local UI preferences, never shared/exported. */
export async function getConversationShareLink(conversationId: string): Promise<string | null> {
  const key = preferenceKey(conversationId).replace('capture-mode:', 'share-link:')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readonly')
    const [record] = await Promise.all([
      requestToPromise<{ url?: unknown } | undefined>(transaction.objectStore(STORE_NAME.SETTINGS).get(key)),
      transactionToPromise(transaction),
    ])
    return normalizeChatGPTShareUrl(record?.url)
  } finally { database.close() }
}

export async function setConversationShareLink(conversationId: string, value: string | null): Promise<string | null> {
  const key = preferenceKey(conversationId).replace('capture-mode:', 'share-link:')
  const url = normalizeChatGPTShareUrl(value)
  if (value !== null && !url) throw new Error('分享链接格式无效')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readwrite')
    const store = transaction.objectStore(STORE_NAME.SETTINGS)
    await Promise.all([
      url ? requestToPromise(store.put({ key, url })) : requestToPromise(store.delete(key)),
      transactionToPromise(transaction),
    ])
    return url
  } finally { database.close() }
}
