import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from './database'
import type { NetworkCaptureStatus } from '../shared/network-capture'

const PREFIX = 'network-capture:'
export async function readNetworkCaptureJobs(): Promise<NetworkCaptureStatus[]> {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE_NAME.ENVIRONMENT, 'readonly')
    const [rows] = await Promise.all([
      requestToPromise<Array<{ key: string; status?: NetworkCaptureStatus }>>(tx.objectStore(STORE_NAME.ENVIRONMENT).getAll()),
      transactionToPromise(tx),
    ])
    return rows.flatMap((row) => row.key.startsWith(PREFIX) && row.status ? [row.status] : [])
  } finally { db.close() }
}

export async function putNetworkCaptureJob(status: NetworkCaptureStatus): Promise<void> {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    await Promise.all([
      requestToPromise(tx.objectStore(STORE_NAME.ENVIRONMENT).put({ key: `${PREFIX}${status.originTabId}`, status })),
      transactionToPromise(tx),
    ])
  } finally { db.close() }
}

export async function deleteNetworkCaptureJob(tabId: number): Promise<void> {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    await Promise.all([requestToPromise(tx.objectStore(STORE_NAME.ENVIRONMENT).delete(`${PREFIX}${tabId}`)), transactionToPromise(tx)])
  } finally { db.close() }
}
