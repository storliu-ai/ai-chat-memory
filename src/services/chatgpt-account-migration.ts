import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from '../db/database'
import type { Account } from '../shared/models'
import { CHATGPT_UNKNOWN_ACCOUNT_ID, CHATGPT_UNKNOWN_ACCOUNT_LABEL } from '../shared/chatgpt-account'

/** Legacy unknown records have no recoverable login ownership. Never merge,
 * rekey, or relabel them with the current login, and preserve manual labels.
 * Existing distinct account keys and all conversation/exclusion data survive. */
export async function normalizeChatGPTUnknownAccount(): Promise<{ changed: boolean }> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ACCOUNTS, 'readwrite')
    const completion = transactionToPromise(transaction)
    const store = transaction.objectStore(STORE_NAME.ACCOUNTS)
    const account = await requestToPromise<Account | undefined>(store.get(CHATGPT_UNKNOWN_ACCOUNT_ID))
    const changed = account?.platform === 'chatgpt' && account.source !== 'manual' &&
      (account.label !== CHATGPT_UNKNOWN_ACCOUNT_LABEL || account.source !== 'unknown')
    if (changed) {
      await requestToPromise(store.put({ ...account, label: CHATGPT_UNKNOWN_ACCOUNT_LABEL, source: 'unknown' }))
    }
    await completion
    return { changed }
  } finally {
    database.close()
  }
}
