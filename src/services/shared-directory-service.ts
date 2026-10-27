import { getAllAccounts } from '../db/accounts'
import { getAllConversations, getConversation } from '../db/conversations'
import { deleteConversationWithExclusionPolicy } from '../db/conversation-exclusions'
import {
  clearSharedDirectoryHandle,
  getLocalEnvironment,
  getSharedDirectoryHandle,
  putSharedDirectoryHandle,
  updateLocalEnvironment,
} from '../db/environment'
import { getSettings } from '../db/settings'
import {
  getEnvironmentDirectoryName,
  isEnvironmentId,
} from '../shared/environments'
import type {
  Account,
  Conversation,
  EnvironmentSummary,
  ConversationExportEnvironment,
  SharedDirectoryState,
  SharedDirectoryStatus,
} from '../shared/models'
import { stripConversationAttachmentData } from '../shared/attachments'
import {
  selectPreferredAccount,
  selectPreferredConversation,
  validateAccount,
  validateConversation,
} from './data-management-service'

const ENVIRONMENTS_DIRECTORY = 'environments'
const ENVIRONMENT_METADATA_FILE = 'environment.json'
const ACCOUNTS_FILE = 'accounts.json'
const CONVERSATIONS_DIRECTORY = 'conversations'
const DELETIONS_DIRECTORY = 'deletions'
const ROOT_METADATA_FILE = 'ai-chat-memory.json'
const FILE_SCHEMA_VERSION = 1
const MAX_ENVIRONMENTS = 100
const MAX_CONVERSATIONS_PER_ENVIRONMENT = 10_000
const MAX_METADATA_BYTES = 64 * 1024
const MAX_ACCOUNTS_BYTES = 5 * 1024 * 1024
const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024
const CONVERSATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/i
const SHARED_READ_CACHE_MS = 2_000

interface StoredEnvironmentMetadata {
  schemaVersion: 1
  environmentId: string
  label: string
  createdAt: number
  updatedAt: number
  conversationCount: number
}

interface SharedDeletionRequest {
  schemaVersion: 1
  environmentId: string
  requestId: string
  conversationId: string
}

async function readDeletionRequests(
  directory: FileSystemDirectoryHandle,
  environmentId: string,
): Promise<SharedDeletionRequest[]> {
  const deletions = await getDirectory(directory, DELETIONS_DIRECTORY, false)
  if (deletions === null) return []
  const requests: SharedDeletionRequest[] = []
  for await (const [name, entry] of deletions.entries()) {
    if (entry.kind !== 'file' || !name.endsWith('.json') ||
      !isEnvironmentId(name.slice(0, -5))) continue
    const value = await readJson(deletions, name, MAX_METADATA_BYTES)
    if (typeof value !== 'object' || value === null) continue
    const request = value as Partial<SharedDeletionRequest>
    if (request.schemaVersion === FILE_SCHEMA_VERSION &&
      request.environmentId === environmentId &&
      request.requestId === name.slice(0, -5) &&
      typeof request.conversationId === 'string' &&
      /^[a-f0-9]{64}$/.test(request.conversationId)) {
      requests.push(request as SharedDeletionRequest)
    }
  }
  return requests
}

export interface SharedEnvironmentData {
  environment: EnvironmentSummary
  accounts: Account[]
  conversations: Conversation[]
}

let fileWriteQueue: Promise<void> = Promise.resolve()
let directoryGeneration = 0
let sharedReadCache: {
  key: string
  expiresAt: number
  data: SharedEnvironmentData[]
} | null = null

function enqueueFileWrite(operation: () => Promise<void>): Promise<void> {
  const next = fileWriteQueue.then(operation, operation)
  fileWriteQueue = next.catch(() => undefined)
  return next
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

async function queryDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite',
): Promise<PermissionState | 'unavailable'> {
  if (typeof handle.queryPermission !== 'function') {
    return 'unavailable'
  }
  try {
    return await handle.queryPermission({ mode })
  } catch {
    return 'unavailable'
  }
}

async function getGrantedRoot(
  mode: 'read' | 'readwrite',
): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getSharedDirectoryHandle()
  if (handle === null) {
    return null
  }
  return await queryDirectoryPermission(handle, mode) === 'granted' ? handle : null
}

async function getDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create })
  } catch (error: unknown) {
    if (!create && isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

async function getFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await directory.getFileHandle(name)
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

async function writeJson(
  directory: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(JSON.stringify(value, null, 2))
    await writable.close()
  } catch (error: unknown) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

async function readJson(
  directory: FileSystemDirectoryHandle,
  name: string,
  maximumBytes: number,
): Promise<unknown | null> {
  const fileHandle = await getFile(directory, name)
  if (fileHandle === null) {
    return null
  }
  const file = await fileHandle.getFile()
  if (file.size > maximumBytes) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(await file.text())
    return parsed
  } catch {
    return null
  }
}

function toStoredMetadata(
  environment: EnvironmentSummary,
): StoredEnvironmentMetadata {
  return {
    schemaVersion: FILE_SCHEMA_VERSION,
    environmentId: environment.id,
    label: environment.label,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
    conversationCount: environment.conversationCount,
  }
}

function parseStoredMetadata(value: unknown): EnvironmentSummary | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const metadata = value as Partial<StoredEnvironmentMetadata>
  if (
    metadata.schemaVersion !== FILE_SCHEMA_VERSION ||
    !isEnvironmentId(metadata.environmentId) ||
    typeof metadata.label !== 'string' ||
    metadata.label.trim() === '' ||
    metadata.label.length > 80 ||
    typeof metadata.createdAt !== 'number' ||
    !Number.isFinite(metadata.createdAt) ||
    typeof metadata.updatedAt !== 'number' ||
    !Number.isFinite(metadata.updatedAt) ||
    typeof metadata.conversationCount !== 'number' ||
    !Number.isFinite(metadata.conversationCount)
  ) {
    return null
  }
  return {
    id: metadata.environmentId,
    label: metadata.label,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    conversationCount: Math.max(0, Math.floor(metadata.conversationCount)),
  }
}

async function getEnvironmentDirectory(
  root: FileSystemDirectoryHandle,
  environmentId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const environments = await getDirectory(root, ENVIRONMENTS_DIRECTORY, create)
  if (environments === null) {
    return null
  }
  return getDirectory(
    environments,
    getEnvironmentDirectoryName(environmentId),
    create,
  )
}

async function readEnvironmentMetadata(
  directory: FileSystemDirectoryHandle,
): Promise<EnvironmentSummary | null> {
  return parseStoredMetadata(
    await readJson(directory, ENVIRONMENT_METADATA_FILE, MAX_METADATA_BYTES),
  )
}

async function scanEnvironmentMetadata(
  root: FileSystemDirectoryHandle,
): Promise<EnvironmentSummary[]> {
  const environments = await getDirectory(root, ENVIRONMENTS_DIRECTORY, false)
  if (environments === null) {
    return []
  }
  const results: EnvironmentSummary[] = []
  for await (const [directoryName, entry] of environments.entries()) {
    if (results.length >= MAX_ENVIRONMENTS) {
      break
    }
    if (entry.kind !== 'directory' || !directoryName.startsWith('env-')) {
      continue
    }
    const metadata = await readEnvironmentMetadata(entry)
    if (
      metadata !== null &&
      getEnvironmentDirectoryName(metadata.id) === directoryName
    ) {
      results.push(metadata)
    }
  }
  return results.sort((left, right) => left.label.localeCompare(right.label))
}

async function writeLocalMetadata(
  root: FileSystemDirectoryHandle,
  environment: EnvironmentSummary,
): Promise<FileSystemDirectoryHandle> {
  const directory = await getEnvironmentDirectory(root, environment.id, true)
  if (directory === null) {
    throw new Error('Failed to create the local environment directory')
  }
  await writeJson(directory, ENVIRONMENT_METADATA_FILE, toStoredMetadata(environment))
  return directory
}

async function synchronizeLocalEnvironmentUnlocked(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  await applyPendingSharedDeletionsUnlocked(root)
  const [accounts, conversations, currentEnvironment] = await Promise.all([
    getAllAccounts(),
    getAllConversations(),
    getLocalEnvironment(),
  ])
  const environment = await updateLocalEnvironment({
    conversationCount: conversations.length,
  })
  await writeJson(root, ROOT_METADATA_FILE, {
    schemaVersion: FILE_SCHEMA_VERSION,
    kind: 'ai-chat-memory-root',
  })
  const environmentDirectory = await writeLocalMetadata(root, {
    ...currentEnvironment,
    ...environment,
  })
  await writeJson(environmentDirectory, ACCOUNTS_FILE, accounts)
  const conversationsDirectory = await getDirectory(
    environmentDirectory,
    CONVERSATIONS_DIRECTORY,
    true,
  )
  if (conversationsDirectory === null) {
    throw new Error('Failed to create the conversations directory')
  }

  const expectedFiles = new Set(conversations.map(({ id }) => `${id}.json`))
  for (const conversation of conversations) {
    await writeJson(
      conversationsDirectory,
      `${conversation.id}.json`,
      conversation,
    )
  }
  for await (const [name, entry] of conversationsDirectory.entries()) {
    if (
      entry.kind === 'file' &&
      CONVERSATION_FILE_PATTERN.test(name) &&
      !expectedFiles.has(name)
    ) {
      await conversationsDirectory.removeEntry(name)
    }
  }
}

export async function connectSharedDirectory(
  handle: FileSystemDirectoryHandle,
): Promise<SharedDirectoryStatus> {
  await putSharedDirectoryHandle(handle)
  directoryGeneration += 1
  sharedReadCache = null
  await synchronizeLocalEnvironment()
  return getSharedDirectoryStatus()
}

export async function requestStoredDirectoryPermission(): Promise<PermissionState> {
  const handle = await getSharedDirectoryHandle()
  if (handle === null || typeof handle.requestPermission !== 'function') {
    return 'denied'
  }
  const permission = await handle.requestPermission({ mode: 'readwrite' })
  if (permission === 'granted') {
    await synchronizeLocalEnvironment()
  }
  return permission
}

export async function disconnectSharedDirectory(): Promise<void> {
  await clearSharedDirectoryHandle()
  directoryGeneration += 1
  sharedReadCache = null
}

export function synchronizeLocalEnvironment(): Promise<void> {
  return enqueueFileWrite(async () => {
    const root = await getGrantedRoot('readwrite')
    if (root !== null) {
      await synchronizeLocalEnvironmentUnlocked(root)
    }
  })
}

export function mirrorLocalConversation(conversation: Conversation): Promise<void> {
  return enqueueFileWrite(async () => {
    const root = await getGrantedRoot('readwrite')
    if (root === null) {
      return
    }
    await applyPendingSharedDeletionsUnlocked(root)
    // A queued mirror can hold a pre-deletion snapshot. Only mirror the record
    // that still exists after applying shared deletion requests.
    const current = await getConversation(conversation.id)
    if (current === null) return
    const environment = await getLocalEnvironment()
    const environmentDirectory = await getEnvironmentDirectory(
      root,
      environment.id,
      true,
    )
    if (environmentDirectory === null) {
      return
    }
    const conversationsDirectory = await getDirectory(
      environmentDirectory,
      CONVERSATIONS_DIRECTORY,
      true,
    )
    if (conversationsDirectory === null) {
      return
    }
    await writeJson(
      conversationsDirectory,
      `${conversation.id}.json`,
      current,
    )
    const conversations = await getAllConversations()
    const nextEnvironment = await updateLocalEnvironment({
      conversationCount: conversations.length,
    })
    await writeLocalMetadata(root, nextEnvironment)
  })
}

export function mirrorLocalAccounts(): Promise<void> {
  return enqueueFileWrite(async () => {
    const root = await getGrantedRoot('readwrite')
    if (root === null) {
      return
    }
    const [environment, accounts] = await Promise.all([
      getLocalEnvironment(),
      getAllAccounts(),
    ])
    const directory = await getEnvironmentDirectory(root, environment.id, true)
    if (directory !== null) {
      await writeJson(directory, ACCOUNTS_FILE, accounts)
    }
  })
}

export function removeMirroredConversation(conversationId: string): Promise<void> {
  return enqueueFileWrite(async () => {
    if (!/^[a-f0-9]{64}$/i.test(conversationId)) {
      return
    }
    const root = await getGrantedRoot('readwrite')
    if (root === null) {
      return
    }
    const environment = await getLocalEnvironment()
    const environmentDirectory = await getEnvironmentDirectory(
      root,
      environment.id,
      false,
    )
    if (environmentDirectory === null) {
      return
    }
    const conversationsDirectory = await getDirectory(
      environmentDirectory,
      CONVERSATIONS_DIRECTORY,
      false,
    )
    if (conversationsDirectory !== null) {
      try {
        await conversationsDirectory.removeEntry(`${conversationId}.json`)
      } catch (error: unknown) {
        if (!isNotFoundError(error)) {
          throw error
        }
      }
    }
    const conversations = await getAllConversations()
    const nextEnvironment = await updateLocalEnvironment({
      conversationCount: conversations.length,
    })
    await writeLocalMetadata(root, nextEnvironment)
  })
}

export async function updateEnvironmentLabelAndMirror(
  label: string,
): Promise<EnvironmentSummary> {
  const environment = await updateLocalEnvironment({ label })
  await enqueueFileWrite(async () => {
    const root = await getGrantedRoot('readwrite')
    if (root !== null) {
      await writeLocalMetadata(root, environment)
    }
  })
  return environment
}

export async function getSharedDirectoryStatus(): Promise<SharedDirectoryStatus> {
  const [handle, currentEnvironment, settings] = await Promise.all([
    getSharedDirectoryHandle(),
    getLocalEnvironment(),
    getSettings(),
  ])
  if (handle === null) {
    return {
      state: 'disconnected',
      rootName: null,
      currentEnvironment,
      otherEnvironments: [],
      visibleEnvironmentIds: [],
    }
  }
  const permission = await queryDirectoryPermission(handle, 'readwrite')
  let state: SharedDirectoryState
  if (permission === 'granted') {
    state = 'granted'
  } else if (permission === 'prompt' || permission === 'denied') {
    state = 'permission-required'
  } else {
    state = 'unavailable'
  }
  if (state !== 'granted') {
    return {
      state,
      rootName: handle.name,
      currentEnvironment,
      otherEnvironments: [],
      visibleEnvironmentIds: settings.visibleEnvironmentIds,
    }
  }
  const environments = await scanEnvironmentMetadata(handle)
  const otherEnvironments = environments.filter(
    ({ id }) => id !== currentEnvironment.id,
  )
  return {
    state,
    rootName: handle.name,
    currentEnvironment,
    otherEnvironments,
    visibleEnvironmentIds: settings.visibleEnvironmentIds.filter((id) =>
      otherEnvironments.some((environment) => environment.id === id),
    ),
  }
}

async function readAccounts(
  directory: FileSystemDirectoryHandle,
): Promise<Account[]> {
  const value = await readJson(directory, ACCOUNTS_FILE, MAX_ACCOUNTS_BYTES)
  if (!Array.isArray(value)) {
    return []
  }
  const accounts = value.flatMap((account, index) => {
    try {
      return [validateAccount(account, index)]
    } catch {
      return []
    }
  })
  const accountMap = new Map<string, Account>()
  for (const account of accounts) {
    const existing = accountMap.get(account.id)
    accountMap.set(
      account.id,
      existing === undefined ? account : selectPreferredAccount(existing, account),
    )
  }
  return [...accountMap.values()]
}

async function readConversations(
  directory: FileSystemDirectoryHandle,
  matchingFiles?: Map<string, string[]>,
): Promise<Conversation[]> {
  const conversationsDirectory = await getDirectory(
    directory,
    CONVERSATIONS_DIRECTORY,
    false,
  )
  if (conversationsDirectory === null) {
    return []
  }
  const conversations = new Map<string, Conversation>()
  for await (const [name, entry] of conversationsDirectory.entries()) {
    if (conversations.size >= MAX_CONVERSATIONS_PER_ENVIRONMENT) {
      break
    }
    if (entry.kind !== 'file') {
      continue
    }
    const filenameMatch = CONVERSATION_FILE_PATTERN.exec(name)
    if (filenameMatch === null) {
      continue
    }
    const value = await readJson(
      conversationsDirectory,
      name,
      MAX_CONVERSATION_BYTES,
    )
    if (value === null) {
      continue
    }
    try {
      const conversation = await validateConversation(value, conversations.size)
      const storedId = typeof value === 'object' && value !== null &&
        typeof (value as { id?: unknown }).id === 'string'
        ? (value as { id: string }).id.toLowerCase()
        : ''
      if (
        conversation.id === filenameMatch[1].toLowerCase() ||
        (conversation.platform === 'chatgpt' &&
          storedId === filenameMatch[1].toLowerCase())
      ) {
        const files = matchingFiles?.get(conversation.id) ?? []
        files.push(name)
        matchingFiles?.set(conversation.id, files)
        const existing = conversations.get(conversation.id)
        conversations.set(
          conversation.id,
          existing === undefined
            ? conversation
            : selectPreferredConversation(existing, conversation),
        )
      }
    } catch {
      // Ignore an invalid file without hiding the rest of the environment.
    }
  }
  if (matchingFiles !== undefined) return [...conversations.values()]
  const environment = await readEnvironmentMetadata(directory)
  const pending = environment === null ? [] : await readDeletionRequests(directory, environment.id)
  const deletedIds = new Set(pending.map((request) => request.conversationId))
  return [...conversations.values()].filter(({ id }) => !deletedIds.has(id))
}

async function removeSharedFiles(
  directory: FileSystemDirectoryHandle,
  files: string[],
): Promise<void> {
  const conversations = await getDirectory(directory, CONVERSATIONS_DIRECTORY, false)
  if (conversations === null) return
  for (const name of files) {
    try {
      await conversations.removeEntry(name)
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error
    }
  }
}

async function applyPendingSharedDeletionsUnlocked(
  root: FileSystemDirectoryHandle,
): Promise<Conversation[]> {
  const environment = await getLocalEnvironment()
  const directory = await getEnvironmentDirectory(root, environment.id, false)
  if (directory === null) return []
  const metadata = await readEnvironmentMetadata(directory)
  if (metadata === null || metadata.id !== environment.id) return []
  const requests = await readDeletionRequests(directory, environment.id)
  if (requests.length === 0) return []
  const deletions = await getDirectory(directory, DELETIONS_DIRECTORY, false)
  if (deletions === null) return []
  const matchingFiles = new Map<string, string[]>()
  await readConversations(directory, matchingFiles)
  const deleted: Conversation[] = []
  try {
    for (const request of requests) {
      const conversation = await getConversation(request.conversationId)
      const result = await deleteConversationWithExclusionPolicy(request.conversationId, request)
      if (result.deleted && conversation !== null) deleted.push(conversation)
      // Keep the request until both the local transaction and shared cleanup
      // succeed. Failed removal is retried using the durable IndexedDB receipt.
      await removeSharedFiles(directory, matchingFiles.get(request.conversationId) ?? [])
      const current = await updateLocalEnvironment({
        conversationCount: (await getAllConversations()).length,
      })
      await writeLocalMetadata(root, current)
      try {
        await deletions.removeEntry(`${request.requestId}.json`)
      } catch (error: unknown) {
        if (!isNotFoundError(error)) throw error
      }
    }
  } finally {
    directoryGeneration += 1
    sharedReadCache = null
  }
  return deleted
}

export async function applyPendingSharedDeletions(): Promise<Conversation[]> {
  let deleted: Conversation[] = []
  await enqueueFileWrite(async () => {
    const root = await getGrantedRoot('readwrite')
    if (root !== null) deleted = await applyPendingSharedDeletionsUnlocked(root)
  })
  return deleted
}

// Explicit Manager cleanup is the only operation that mutates another
// environment's mirror. Never route this through local IndexedDB deletion.
export function deleteSharedConversation(
  environmentId: string,
  conversationId: string,
): Promise<void> {
  return enqueueFileWrite(async () => {
    if (!isEnvironmentId(environmentId) || !/^[a-f0-9]{64}$/.test(conversationId)) {
      throw new Error('Invalid shared conversation identity')
    }
    const [root, settings, currentEnvironment] = await Promise.all([
      getGrantedRoot('readwrite'),
      getSettings(),
      getLocalEnvironment(),
    ])
    if (
      root === null ||
      currentEnvironment.id.toLowerCase() === environmentId.toLowerCase() ||
      !settings.visibleEnvironmentIds.includes(environmentId)
    ) {
      throw new Error('Shared environment is not authorized for cleanup')
    }
    const directory = await getEnvironmentDirectory(root, environmentId, false)
    if (directory === null) {
      throw new Error('Shared environment is unavailable')
    }
    const environment = await readEnvironmentMetadata(directory)
    if (environment === null || environment.id !== environmentId) {
      throw new Error('Shared environment identity mismatch')
    }
    // Retain physical filenames: legacy ChatGPT account IDs can normalize to
    // one displayed conversation stored in several differently named files.
    const matchingFiles = new Map<string, string[]>()
    await readConversations(directory, matchingFiles)
    const files = matchingFiles.get(conversationId) ?? []
    try {
      const deletions = await getDirectory(directory, DELETIONS_DIRECTORY, true)
      if (deletions === null) throw new Error('Deletion directory is unavailable')
      // Unique immutable requests avoid overwriting a second environment's
      // deletion while the source is acknowledging an earlier one.
      const request: SharedDeletionRequest = {
        schemaVersion: FILE_SCHEMA_VERSION,
        environmentId,
        requestId: crypto.randomUUID(),
        conversationId,
      }
      await writeJson(deletions, `${request.requestId}.json`, request)
      await removeSharedFiles(directory, files)
      await writeJson(directory, ENVIRONMENT_METADATA_FILE, toStoredMetadata({
        ...environment,
        conversationCount: (await readConversations(directory)).length,
        updatedAt: Date.now(),
      }))
    } finally {
      directoryGeneration += 1
      sharedReadCache = null
    }
  })
}

export async function readVisibleSharedEnvironments(): Promise<SharedEnvironmentData[]> {
  const [root, settings, currentEnvironment] = await Promise.all([
    getGrantedRoot('read'),
    getSettings(),
    getLocalEnvironment(),
  ])
  if (root === null || settings.visibleEnvironmentIds.length === 0) {
    return []
  }
  const cacheKey = `${directoryGeneration}:${root.name}:${[...settings.visibleEnvironmentIds].sort().join(',')}`
  if (
    sharedReadCache !== null &&
    sharedReadCache.key === cacheKey &&
    sharedReadCache.expiresAt > Date.now()
  ) {
    return sharedReadCache.data
  }
  const selected = new Set(settings.visibleEnvironmentIds)
  selected.delete(currentEnvironment.id)
  const result: SharedEnvironmentData[] = []
  for (const environmentId of selected) {
    const directory = await getEnvironmentDirectory(root, environmentId, false)
    if (directory === null) {
      continue
    }
    const environment = await readEnvironmentMetadata(directory)
    if (environment === null || environment.id !== environmentId) {
      continue
    }
    const [accounts, conversations] = await Promise.all([
      readAccounts(directory),
      readConversations(directory),
    ])
    result.push({ environment, accounts, conversations })
  }
  sharedReadCache = {
    key: cacheKey,
    expiresAt: Date.now() + SHARED_READ_CACHE_MS,
    data: result,
  }
  return result
}

function prepareExportEnvironment(
  environment: EnvironmentSummary,
  accounts: Account[],
  conversations: Conversation[],
  sourceIsLocal: boolean,
): ConversationExportEnvironment {
  return {
    environment: {
      ...environment,
      conversationCount: conversations.length,
    },
    accounts,
    conversations: conversations
      .map(stripConversationAttachmentData)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    sourceIsLocal,
  }
}

export async function readExportEnvironments(
  requestedEnvironmentIds: 'all' | string[],
): Promise<ConversationExportEnvironment[]> {
  const [currentEnvironment, localAccounts, localConversations, root] =
    await Promise.all([
      getLocalEnvironment(),
      getAllAccounts(),
      getAllConversations(),
      getGrantedRoot('read'),
    ])
  const requested = requestedEnvironmentIds === 'all'
    ? null
    : new Set(requestedEnvironmentIds)
  const result: ConversationExportEnvironment[] = []

  if (requested === null || requested.has(currentEnvironment.id)) {
    result.push(prepareExportEnvironment(
      currentEnvironment,
      localAccounts,
      localConversations,
      true,
    ))
  }
  if (root === null) {
    return result
  }

  const environments = await scanEnvironmentMetadata(root)
  for (const environment of environments) {
    if (
      environment.id === currentEnvironment.id ||
      (requested !== null && !requested.has(environment.id))
    ) {
      continue
    }
    const directory = await getEnvironmentDirectory(root, environment.id, false)
    if (directory === null) {
      continue
    }
    const [accounts, conversations] = await Promise.all([
      readAccounts(directory),
      readConversations(directory),
    ])
    result.push(prepareExportEnvironment(
      environment,
      accounts,
      conversations,
      false,
    ))
  }

  return result
}

export async function getVisibleSharedConversation(
  environmentId: string,
  conversationId: string,
): Promise<Conversation | null> {
  if (!isEnvironmentId(environmentId) || !/^[a-f0-9]{64}$/i.test(conversationId)) {
    return null
  }
  const [root, settings, currentEnvironment] = await Promise.all([
    getGrantedRoot('read'),
    getSettings(),
    getLocalEnvironment(),
  ])
  if (
    root === null ||
    currentEnvironment.id === environmentId ||
    !settings.visibleEnvironmentIds.includes(environmentId)
  ) {
    return null
  }
  const directory = await getEnvironmentDirectory(root, environmentId, false)
  if (directory === null) {
    return null
  }
  const environment = await readEnvironmentMetadata(directory)
  if (environment === null || environment.id !== environmentId) {
    return null
  }
  if ((await readDeletionRequests(directory, environmentId)).some(
    (request) => request.conversationId === conversationId,
  )) return null
  const conversationsDirectory = await getDirectory(
    directory,
    CONVERSATIONS_DIRECTORY,
    false,
  )
  if (conversationsDirectory === null) {
    return null
  }
  const value = await readJson(
    conversationsDirectory,
    `${conversationId}.json`,
    MAX_CONVERSATION_BYTES,
  )
  if (value === null) {
    return (await readConversations(directory)).find(
      (conversation) => conversation.id === conversationId,
    ) ?? null
  }
  try {
    const conversation = await validateConversation(value, 0)
    return conversation.id === conversationId ? conversation : null
  } catch {
    return null
  }
}
