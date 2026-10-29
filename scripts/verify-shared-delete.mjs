import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

const require = createRequire(import.meta.url)
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, dependencies) {
  const code = ts.transpileModule(source(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
  const exports = {}
  new Function('require', 'exports', code)((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`)
    return dependencies[name]
  }, exports)
  return exports
}

// Exercise the real filesystem orchestration with deterministic in-memory
// handles. No user directory or profile database is opened by this script.
class Directory {
  kind = 'directory'
  files = new Map()
  permission = 'granted'
  failure = null
  constructor(name) { this.name = name }
  async queryPermission() { return this.permission }
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.files.has(name) && create) this.files.set(name, new Directory(name))
    const entry = this.files.get(name)
    if (!entry) throw new DOMException('missing', 'NotFoundError')
    return entry
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name) && create) this.put(name, null)
    const entry = this.files.get(name)
    if (!entry) throw new DOMException('missing', 'NotFoundError')
    return entry
  }
  put(name, value) {
    const entry = {
      kind: 'file', value,
      getFile: async () => ({
        size: JSON.stringify(entry.value).length,
        text: async () => JSON.stringify(entry.value),
      }),
      createWritable: async () => ({
        write: async (text) => { entry.value = JSON.parse(text) },
        close: async () => {},
        abort: async () => {},
      }),
    }
    this.files.set(name, entry)
    return entry
  }
  async *entries() { yield* this.files.entries() }
  async removeEntry(name) {
    if (this.failure) throw this.failure
    this.files.delete(name)
  }
}

const localId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const thirdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const targetId = 'a'.repeat(64)
const legacyId = 'b'.repeat(64)
const unrelatedId = 'c'.repeat(64)
const root = new Directory('shared')
const environments = await root.getDirectoryHandle('environments', { create: true })
const metadata = (id) => ({
  schemaVersion: 1, environmentId: id, label: id,
  createdAt: 1, updatedAt: 2, conversationCount: 2,
})
const folders = new Map()
for (const id of [localId, otherId, thirdId]) {
  const folder = await environments.getDirectoryHandle(`env-${id}`, { create: true })
  folder.put('environment.json', metadata(id))
  folder.put('accounts.json', [{ id: 'account', label: 'Preserved account' }])
  const files = await folder.getDirectoryHandle('conversations', { create: true })
  files.put(`${targetId}.json`, { id: targetId, platform: 'chatgpt', title: 'old' })
  folders.set(id, { folder, files })
}
const { folder, files } = folders.get(otherId)
files.put(`${legacyId}.json`, { id: legacyId, canonicalId: targetId, platform: 'chatgpt' })
files.put(`${unrelatedId}.json`, { id: unrelatedId, platform: 'gemini', attachments: ['preserved'] })
files.put('notes.json', { note: 'unrelated file' })
files.put(`${'d'.repeat(64)}.json`, { invalid: true })
let visible = [otherId]
const environmentHelpers = load('src/shared/environments.ts', {})
const service = load('src/services/shared-directory-service.ts', {
  '../db/accounts': { getAllAccounts: async () => { throw new Error('Local DB must not be read') } },
  '../db/conversations': { getAllConversations: async () => { throw new Error('Local DB must not be read') } },
  '../db/conversation-exclusions': {
    deleteConversationWithExclusionPolicy: async () => { throw new Error('Creator must not delete local records') },
  },
  '../db/environment': {
    getSharedDirectoryHandle: async () => root,
    getLocalEnvironment: async () => ({ id: localId }),
  },
  '../db/settings': { getSettings: async () => ({ visibleEnvironmentIds: visible }) },
  '../shared/environments': environmentHelpers,
  '../shared/attachments': { stripConversationAttachmentData: (value) => value },
  './data-management-service': {
    validateAccount: (value) => value,
    validateConversation: async (value) => {
      if (value.invalid) throw new Error('Invalid conversation')
      return { ...value, id: value.canonicalId ?? value.id }
    },
    selectPreferredAccount: (left) => left,
    selectPreferredConversation: (left) => left,
  },
})
const snapshot = () => JSON.stringify([...files.files].map(([name, entry]) => [name, entry.value]))
const before = snapshot()
await assert.rejects(service.deleteSharedConversation('../outside', targetId))
await assert.rejects(service.deleteSharedConversation(otherId, '../outside'))
await assert.rejects(service.deleteSharedConversation(localId, targetId))
await assert.rejects(service.deleteSharedConversation(localId.toUpperCase(), targetId))
await assert.rejects(service.deleteSharedConversation(thirdId, targetId))
visible = []
await assert.rejects(service.deleteSharedConversation(otherId, targetId))
visible = [otherId]
root.permission = 'prompt'
await assert.rejects(service.deleteSharedConversation(otherId, targetId))
root.permission = 'granted'
folder.put('environment.json', metadata(thirdId))
await assert.rejects(service.deleteSharedConversation(otherId, targetId))
folder.put('environment.json', metadata(otherId))
assert.equal(snapshot(), before, 'Rejected requests must leave all files intact')

assert.equal((await service.readVisibleSharedEnvironments())[0].conversations.length, 2)
files.failure = new DOMException('permission revoked', 'NotAllowedError')
await assert.rejects(service.deleteSharedConversation(otherId, targetId))
assert.equal(snapshot(), before, 'I/O failure must be reported, not successful deletion')
files.failure = null
await service.deleteSharedConversation(otherId, targetId)
assert.ok(!files.files.has(`${targetId}.json`))
assert.ok(!files.files.has(`${legacyId}.json`), 'Remove every validated legacy alias')
assert.ok(files.files.has(`${unrelatedId}.json`))
assert.ok(files.files.has('notes.json'))
assert.ok(files.files.has(`${'d'.repeat(64)}.json`), 'Invalid files are never deleted')
assert.equal(folder.files.get('environment.json').value.conversationCount, 1)
assert.equal(folder.files.get('accounts.json').value[0].label, 'Preserved account')
for (const id of [localId, thirdId]) {
  assert.ok(folders.get(id).files.files.has(`${targetId}.json`), 'Other copies remain intact')
}
assert.equal((await service.readVisibleSharedEnvironments())[0].conversations.length, 1,
  'Successful deletion must invalidate a warmed list cache immediately')
assert.equal(await service.getVisibleSharedConversation(otherId, targetId), null)
await service.deleteSharedConversation(otherId, targetId) // Missing copy is idempotent.

const deletions = await folder.getDirectoryHandle('deletions')
assert.ok(deletions.files.size > 0, 'Persist a deletion command for an offline source')
const requestCount = deletions.files.size
files.put(`${targetId}.json`, { id: targetId, platform: 'chatgpt', title: 'old source rewrite' })
assert.equal(await service.getVisibleSharedConversation(otherId, targetId), null,
  'Pending commands must hide files recreated by an old source version')
assert.equal((await service.readVisibleSharedEnvironments())[0].conversations.length, 1)

// Exercise the actual deletion transaction against an isolated database model.
// Commit all stores together, or roll them all back on an injected write error.
const tables = {
  conversations: new Map(), conversationExclusions: new Map(), environment: new Map(),
}
let failDelete = false
let lastStores = []
const db = {
  close() {},
  transaction(names) {
    lastStores = names
    const copies = Object.fromEntries(names.map((name) => [name, new Map(tables[name])]))
    const transaction = {
      failed: false,
      objectStore(name) {
        assert.ok(names.includes(name))
        const values = copies[name]
        return {
          get: (key) => Promise.resolve(values.get(key)),
          put: (value) => { values.set(value.key ?? value.id, value); return Promise.resolve() },
          delete: (key) => {
            if (failDelete && name === 'conversations') {
              transaction.failed = true
              return Promise.reject(new Error('injected database failure'))
            }
            values.delete(key)
            return Promise.resolve()
          },
        }
      },
    }
    transaction.completion = new Promise((resolve, reject) => setImmediate(() => {
      if (transaction.failed) return reject(new Error('transaction aborted'))
      for (const name of names) tables[name] = copies[name]
      resolve()
    }))
    return transaction
  },
}
const deletionDb = load('src/db/conversation-exclusions.ts', {
  '../utils/hash': { createConversationId: async () => targetId },
  '../shared/chatgpt-account': { CHATGPT_UNKNOWN_ACCOUNT_ID: 'unknown' },
  './database': {
    STORE_NAME: { CONVERSATIONS: 'conversations', CONVERSATION_EXCLUSIONS: 'conversationExclusions', ENVIRONMENT: 'environment' },
    openDatabase: async () => db,
    requestToPromise: (request) => request,
    transactionToPromise: (transaction) => transaction.completion,
  },
})
const pinned = { id: targetId, platform: 'chatgpt', accountId: 'unknown', conversationId: 'native',
  title: 'old', pinned: true, attachments: ['saved bytes'] }
const dbRequest = { environmentId: otherId, requestId: crypto.randomUUID() }
tables.conversations.set(targetId, pinned)
failDelete = true
await assert.rejects(deletionDb.deleteConversationWithExclusionPolicy(targetId, dbRequest))
await new Promise((resolve) => setImmediate(resolve))
assert.ok(tables.conversations.has(targetId))
assert.equal(tables.environment.size, 0, 'A failed deletion must not commit a receipt')
failDelete = false
await deletionDb.deleteConversationWithExclusionPolicy(targetId, dbRequest)
assert.deepEqual(lastStores, ['conversations', 'conversationExclusions', 'environment'])
assert.ok(!tables.conversations.has(targetId))
assert.ok(tables.conversationExclusions.has(targetId))
tables.conversations.set(targetId, pinned)
await deletionDb.deleteConversationWithExclusionPolicy(targetId, dbRequest)
assert.ok(tables.conversations.has(targetId), 'Replaying a receipt cannot delete a restoration')
tables.conversations.set(unrelatedId, { ...pinned, id: unrelatedId, pinned: false })
tables.conversationExclusions.set(unrelatedId, { id: unrelatedId })
await deletionDb.deleteConversationWithExclusionPolicy(unrelatedId, {
  environmentId: otherId, requestId: crypto.randomUUID(),
})
assert.ok(!tables.conversationExclusions.has(unrelatedId), 'Unpinned deletion keeps the existing policy')
tables.conversations.set(unrelatedId, { id: unrelatedId, platform: 'gemini', attachments: ['preserved'] })

let sourceEnvironment = { ...metadata(otherId), id: otherId }
const consumerDependencies = {
  '../db/accounts': { getAllAccounts: async () => [{ id: 'account', label: 'Preserved account' }] },
  '../db/conversations': {
    getAllConversations: async () => [...tables.conversations.values()],
    getConversation: async (id) => tables.conversations.get(id) ?? null,
  },
  '../db/conversation-exclusions': deletionDb,
  '../db/environment': {
    getSharedDirectoryHandle: async () => root,
    getLocalEnvironment: async () => sourceEnvironment,
    updateLocalEnvironment: async (patch) => (sourceEnvironment = { ...sourceEnvironment, ...patch }),
  },
  '../db/settings': { getSettings: async () => ({ visibleEnvironmentIds: [] }) },
  '../shared/environments': environmentHelpers,
  '../shared/attachments': { stripConversationAttachmentData: (value) => value },
  './data-management-service': {
    validateAccount: (value) => value,
    validateConversation: async (value) => {
      if (value.invalid) throw new Error('invalid')
      return { ...value, id: value.canonicalId ?? value.id }
    },
    selectPreferredAccount: (left) => left,
    selectPreferredConversation: (left) => left,
  },
}
let consumer = load('src/services/shared-directory-service.ts', consumerDependencies)
root.permission = 'prompt'
await consumer.applyPendingSharedDeletions()
assert.ok(tables.conversations.has(targetId))
assert.equal(deletions.files.size, requestCount, 'Permission loss preserves pending commands')
root.permission = 'granted'
assert.equal((await consumer.applyPendingSharedDeletions()).length, 1)
assert.ok(!tables.conversations.has(targetId), 'Source startup deletes its own saved record and attachments')
assert.ok(tables.conversationExclusions.has(targetId))
assert.equal(deletions.files.size, 0, 'Acknowledge only after both stores are cleaned')
assert.ok(!files.files.has(`${targetId}.json`))
assert.deepEqual(tables.conversations.get(unrelatedId).attachments, ['preserved'])
await consumer.mirrorLocalConversation(pinned)
assert.ok(!files.files.has(`${targetId}.json`), 'A queued pre-deletion mirror cannot resurrect the record')

// Simulate source termination after the DB commit but before request removal.
tables.conversations.set(targetId, pinned)
await service.deleteSharedConversation(otherId, targetId)
deletions.failure = new DOMException('acknowledgement failed', 'NotAllowedError')
await assert.rejects(consumer.applyPendingSharedDeletions())
assert.ok(!tables.conversations.has(targetId))
assert.equal(deletions.files.size, 1)
tables.conversations.set(targetId, { ...pinned, title: 'manually restored' })
deletions.failure = null
consumer = load('src/services/shared-directory-service.ts', consumerDependencies)
await consumer.applyPendingSharedDeletions()
assert.equal(tables.conversations.get(targetId).title, 'manually restored')
assert.equal(deletions.files.size, 0)
await consumer.mirrorLocalConversation(pinned)
assert.equal(files.files.get(`${targetId}.json`).value.title, 'manually restored')

// Full sync must consume first, rather than republishing a stale DB snapshot.
await service.deleteSharedConversation(otherId, targetId)
await consumer.synchronizeLocalEnvironment()
assert.ok(!tables.conversations.has(targetId))
assert.ok(!files.files.has(`${targetId}.json`))
assert.ok(files.files.has(`${unrelatedId}.json`))
const invalidRequestId = crypto.randomUUID()
deletions.put(`${invalidRequestId}.json`, {
  schemaVersion: 1, environmentId: thirdId, requestId: invalidRequestId, conversationId: unrelatedId,
})
await consumer.applyPendingSharedDeletions()
assert.ok(tables.conversations.has(unrelatedId), 'Reject a request for another environment')

const { ConversationCard } = load('src/panel/components/ConversationCard.tsx', {
  'react/jsx-runtime': require('react/jsx-runtime'),
  '../../shared/models': { PLATFORM_LABELS: { chatgpt: 'ChatGPT' } },
  '../conversation-colors': { getManagerConversationColorStyle: () => ({}) },
})
const card = (sourceIsLocal) => renderToStaticMarkup(createElement(ConversationCard, {
  conversation: {
    id: targetId, platform: 'chatgpt', title: 'Old conversation', messages: [],
    updatedAt: 1, messageCount: 0, sourceIsLocal, sourceEnvironmentLabel: 'Other',
  },
  onOpen() {}, onDelete() {}, onToggleImportant() {},
}))
assert.match(card(false), /class="card-delete"/)
assert.match(card(false), /从来源环境删除对话/)
assert.doesNotMatch(card(false), /class="card-important/)
assert.match(card(true), /class="card-delete"/)
assert.match(card(true), /class="card-important/)
const page = source('src/panel/pages/ConversationsPage.tsx')
assert.match(page, /removeSharedConversation\(conversation.sourceEnvironmentId, conversation.id\)/)
assert.match(page, /会删除本地记录及其附件/)
const worker = source('src/background/service-worker.ts')
assert.match(worker, /sender.url\?\.split/)
assert.match(worker, /Shared cleanup requires the Manager/)
assert.match(worker, /await ensureExtensionInitialized\(\)[\s\S]*await receiveSharedDeletions\(\)[\s\S]*dispatchRuntimeRequest\(message, sender\)/)
assert.match(worker, /runtimeDataQueue.then\(\(\) => handleRuntimeMessage\(message, sender\)\)/)
console.log('shared conversation deletion verification passed')
