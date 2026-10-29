import type { Account } from '../shared/models'
import { isLegacyChatGPTProfileLabel } from '../shared/account-labels'
import { CHATGPT_UNKNOWN_ACCOUNT_ID, CHATGPT_UNKNOWN_ACCOUNT_LABEL } from '../shared/chatgpt-account'
import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from './database'

function normalizeAccount(account: Account): Account {
  if (account.platform === 'chatgpt' && account.id === CHATGPT_UNKNOWN_ACCOUNT_ID && account.source !== 'manual') {
    return { ...account, label: CHATGPT_UNKNOWN_ACCOUNT_LABEL, source: 'unknown' }
  }
  if (
    account.platform === 'chatgpt' &&
    account.source !== 'manual' &&
    isLegacyChatGPTProfileLabel(account.label)
  ) {
    return {
      ...account,
      label: 'Unknown',
      source: 'unknown',
    }
  }
  return account
}

export async function putAccount(account: Account): Promise<Account> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ACCOUNTS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.ACCOUNTS).put(account)
    const result = requestToPromise(request)
    await Promise.all([result, transactionToPromise(transaction)])
    return account
  } finally {
    database.close()
  }
}

export async function getAccount(id: string): Promise<Account | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ACCOUNTS, 'readonly')
    const request = transaction.objectStore(STORE_NAME.ACCOUNTS).get(id)
    const [account] = await Promise.all([
      requestToPromise<Account | undefined>(request),
      transactionToPromise(transaction),
    ])
    return account === undefined ? null : normalizeAccount(account)
  } finally {
    database.close()
  }
}

export async function getAllAccounts(): Promise<Account[]> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ACCOUNTS, 'readonly')
    const request = transaction.objectStore(STORE_NAME.ACCOUNTS).getAll()
    const [accounts] = await Promise.all([
      requestToPromise<Account[]>(request),
      transactionToPromise(transaction),
    ])
    return accounts.map(normalizeAccount)
  } finally {
    database.close()
  }
}

export async function deleteAccount(id: string): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ACCOUNTS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.ACCOUNTS).delete(id)
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}

export async function clearAccounts(): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ACCOUNTS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.ACCOUNTS).clear()
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}
