import {
  createEnvironmentId,
  isEnvironmentId,
  normalizeEnvironmentLabel,
} from '../shared/environments'
import type { EnvironmentSummary } from '../shared/models'
import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from './database'

const LOCAL_ENVIRONMENT_KEY = 'local-environment'
const SHARED_DIRECTORY_KEY = 'shared-directory'

interface LocalEnvironmentRecord extends EnvironmentSummary {
  key: typeof LOCAL_ENVIRONMENT_KEY
}

interface SharedDirectoryRecord {
  key: typeof SHARED_DIRECTORY_KEY
  handle: FileSystemDirectoryHandle
  connectedAt: number
}

function isLocalEnvironmentRecord(value: unknown): value is LocalEnvironmentRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Partial<LocalEnvironmentRecord>
  return (
    record.key === LOCAL_ENVIRONMENT_KEY &&
    isEnvironmentId(record.id) &&
    typeof record.label === 'string' &&
    record.label.trim() !== '' &&
    record.label.length <= 80 &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  )
}

function toSummary(record: LocalEnvironmentRecord): EnvironmentSummary {
  return {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    conversationCount: Math.max(0, Math.floor(record.conversationCount || 0)),
  }
}

let localEnvironmentPromise: Promise<EnvironmentSummary> | null = null

async function readLocalEnvironment(): Promise<LocalEnvironmentRecord | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ENVIRONMENT, 'readonly')
    const request = transaction.objectStore(STORE_NAME.ENVIRONMENT).get(LOCAL_ENVIRONMENT_KEY)
    const [record] = await Promise.all([
      requestToPromise<unknown>(request),
      transactionToPromise(transaction),
    ])
    return isLocalEnvironmentRecord(record) ? record : null
  } finally {
    database.close()
  }
}

async function putLocalEnvironment(
  record: LocalEnvironmentRecord,
): Promise<EnvironmentSummary> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.ENVIRONMENT).put(record)
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
    return toSummary(record)
  } finally {
    database.close()
  }
}

export function getLocalEnvironment(): Promise<EnvironmentSummary> {
  if (localEnvironmentPromise === null) {
    localEnvironmentPromise = (async () => {
      const existing = await readLocalEnvironment()
      if (existing !== null) {
        return toSummary(existing)
      }
      const now = Date.now()
      const id = createEnvironmentId()
      return putLocalEnvironment({
        key: LOCAL_ENVIRONMENT_KEY,
        id,
        label: `本环境 ${id.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        conversationCount: 0,
      })
    })().catch((error: unknown) => {
      localEnvironmentPromise = null
      throw error
    })
  }
  return localEnvironmentPromise
}

export async function updateLocalEnvironment(
  patch: { label?: string; conversationCount?: number },
): Promise<EnvironmentSummary> {
  const current = await getLocalEnvironment()
  const next: LocalEnvironmentRecord = {
    key: LOCAL_ENVIRONMENT_KEY,
    ...current,
    label: patch.label === undefined
      ? current.label
      : normalizeEnvironmentLabel(patch.label),
    conversationCount: patch.conversationCount === undefined
      ? current.conversationCount
      : Math.max(0, Math.floor(patch.conversationCount)),
    updatedAt: Date.now(),
  }
  const summary = await putLocalEnvironment(next)
  localEnvironmentPromise = Promise.resolve(summary)
  return summary
}

export async function getSharedDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ENVIRONMENT, 'readonly')
    const request = transaction.objectStore(STORE_NAME.ENVIRONMENT).get(SHARED_DIRECTORY_KEY)
    const [record] = await Promise.all([
      requestToPromise<SharedDirectoryRecord | undefined>(request),
      transactionToPromise(transaction),
    ])
    return record?.handle?.kind === 'directory' ? record.handle : null
  } finally {
    database.close()
  }
}

export async function putSharedDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    const record: SharedDirectoryRecord = {
      key: SHARED_DIRECTORY_KEY,
      handle,
      connectedAt: Date.now(),
    }
    const request = transaction.objectStore(STORE_NAME.ENVIRONMENT).put(record)
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}

export async function clearSharedDirectoryHandle(): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.ENVIRONMENT, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.ENVIRONMENT).delete(SHARED_DIRECTORY_KEY)
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}
