import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from './database'
import type { ShareCaptureStatus } from '../shared/share-capture'

const PREFIX = 'share-capture:'

export async function readShareCaptureJobs(): Promise<ShareCaptureStatus[]> {
  const db = await openDatabase()
  try {
    const transaction = db.transaction(STORE_NAME.ENVIRONMENT, 'readonly')
    const [rows] = await Promise.all([
      requestToPromise<Array<{ key: string; status?: ShareCaptureStatus }>>(transaction.objectStore(STORE_NAME.ENVIRONMENT).getAll()),
      transactionToPromise(transaction),
    ])
    return rows.flatMap((row) => row.key.startsWith(PREFIX) && row.status ? [row.status] : [])
  } finally { db.close() }
}

export async function putShareCaptureJob(status: ShareCaptureStatus): Promise<void> {
  const db = await openDatabase()
  try {
    const transaction = db.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    await Promise.all([
      requestToPromise(transaction.objectStore(STORE_NAME.ENVIRONMENT).put({ key: `${PREFIX}${status.originTabId}`, status })),
      transactionToPromise(transaction),
    ])
  } finally { db.close() }
}

export async function deleteShareCaptureJob(originTabId: number): Promise<void> {
  const db = await openDatabase()
  try {
    const transaction = db.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    await Promise.all([
      requestToPromise(transaction.objectStore(STORE_NAME.ENVIRONMENT).delete(`${PREFIX}${originTabId}`)),
      transactionToPromise(transaction),
    ])
  } finally { db.close() }
}
