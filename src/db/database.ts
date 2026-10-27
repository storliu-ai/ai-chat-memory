export const DATABASE_NAME = 'AIChatMemoryDB'
export const DATABASE_VERSION = 3

export const STORE_NAME = {
  CONVERSATIONS: 'conversations',
  ACCOUNTS: 'accounts',
  SETTINGS: 'settings',
  ENVIRONMENT: 'environment',
  CONVERSATION_EXCLUSIONS: 'conversationExclusions',
} as const

export const CONVERSATION_INDEX = {
  UPDATED_AT: 'updatedAt',
  CREATED_AT: 'createdAt',
  PLATFORM: 'platform',
  ACCOUNT_ID: 'accountId',
  CONVERSATION_ID: 'conversationId',
  PLATFORM_ACCOUNT: 'platformAccount',
} as const

export const ACCOUNT_INDEX = {
  PLATFORM: 'platform',
  UPDATED_AT: 'updatedAt',
} as const

function ensureConversationStore(database: IDBDatabase, transaction: IDBTransaction): void {
  const store = database.objectStoreNames.contains(STORE_NAME.CONVERSATIONS)
    ? transaction.objectStore(STORE_NAME.CONVERSATIONS)
    : database.createObjectStore(STORE_NAME.CONVERSATIONS, { keyPath: 'id' })

  if (!store.indexNames.contains(CONVERSATION_INDEX.UPDATED_AT)) {
    store.createIndex(CONVERSATION_INDEX.UPDATED_AT, 'updatedAt')
  }
  if (!store.indexNames.contains(CONVERSATION_INDEX.CREATED_AT)) {
    store.createIndex(CONVERSATION_INDEX.CREATED_AT, 'createdAt')
  }
  if (!store.indexNames.contains(CONVERSATION_INDEX.PLATFORM)) {
    store.createIndex(CONVERSATION_INDEX.PLATFORM, 'platform')
  }
  if (!store.indexNames.contains(CONVERSATION_INDEX.ACCOUNT_ID)) {
    store.createIndex(CONVERSATION_INDEX.ACCOUNT_ID, 'accountId')
  }
  if (!store.indexNames.contains(CONVERSATION_INDEX.CONVERSATION_ID)) {
    store.createIndex(CONVERSATION_INDEX.CONVERSATION_ID, 'conversationId')
  }
  if (!store.indexNames.contains(CONVERSATION_INDEX.PLATFORM_ACCOUNT)) {
    store.createIndex(CONVERSATION_INDEX.PLATFORM_ACCOUNT, ['platform', 'accountId'])
  }
}

function ensureAccountStore(database: IDBDatabase, transaction: IDBTransaction): void {
  const store = database.objectStoreNames.contains(STORE_NAME.ACCOUNTS)
    ? transaction.objectStore(STORE_NAME.ACCOUNTS)
    : database.createObjectStore(STORE_NAME.ACCOUNTS, { keyPath: 'id' })

  if (!store.indexNames.contains(ACCOUNT_INDEX.PLATFORM)) {
    store.createIndex(ACCOUNT_INDEX.PLATFORM, 'platform')
  }
  if (!store.indexNames.contains(ACCOUNT_INDEX.UPDATED_AT)) {
    store.createIndex(ACCOUNT_INDEX.UPDATED_AT, 'updatedAt')
  }
}

function upgradeDatabase(database: IDBDatabase, transaction: IDBTransaction | null): void {
  if (transaction === null) {
    throw new Error('IndexedDB upgrade transaction is unavailable')
  }

  ensureConversationStore(database, transaction)
  ensureAccountStore(database, transaction)

  if (!database.objectStoreNames.contains(STORE_NAME.SETTINGS)) {
    database.createObjectStore(STORE_NAME.SETTINGS, { keyPath: 'key' })
  }
  if (!database.objectStoreNames.contains(STORE_NAME.ENVIRONMENT)) {
    database.createObjectStore(STORE_NAME.ENVIRONMENT, { keyPath: 'key' })
  }
  if (!database.objectStoreNames.contains(STORE_NAME.CONVERSATION_EXCLUSIONS)) {
    database.createObjectStore(STORE_NAME.CONVERSATION_EXCLUSIONS, { keyPath: 'id' })
  }
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      try {
        upgradeDatabase(request.result, request.transaction)
      } catch (error: unknown) {
        request.transaction?.abort()
        reject(error)
      }
    }

    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }

    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open IndexedDB'))
    }

    request.onblocked = () => {
      reject(new Error('IndexedDB upgrade is blocked by another extension context'))
    }
  })
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

export function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted'))
    }
  })
}
