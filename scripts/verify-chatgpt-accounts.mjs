import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { verificationModule } from './load-verification-module.mjs'
const same = (actual, expected, message) => assert.deepEqual(structuredClone(actual), structuredClone(expected), message)

// Synthetic identities only. No real browser profile, account or filesystem is read.
const hashes = verificationModule('src/utils/hash.ts')
const identities = verificationModule('src/shared/chatgpt-account.ts')
const accountA = await hashes.createAccountId('chatgpt', 'alice@example.com')
const accountB = await hashes.createAccountId('chatgpt', 'bob@example.com')
assert.match(accountA, /^chatgpt:email:[a-f0-9]{64}$/)
assert.notEqual(accountA, accountB)
assert.equal(accountA, await hashes.createAccountId('chatgpt', ' ALICE@EXAMPLE.COM '))
for (const label of [null, '', 'Same Display Name', 'PLUS', 'Name <alice@example.com>']) {
  assert.equal(await hashes.createAccountId('chatgpt', label), 'unknown')
}

const { window, document } = parseHTML(`<html><body><aside>
  <button data-testid="accounts-profile-button" data-email="alice@example.com" data-user-name="Same Name"><span class="truncate">Same Name</span></button>
</aside><main><img data-email="intruder@example.com"></main></body></html>`)
const { ChatGPTAdapter } = verificationModule('src/adapters/chatgpt/chatgpt-adapter.ts', {
  document, window, location: { href: 'https://chatgpt.com/c/synthetic-account-test' },
  Element: window.Element, HTMLElement: window.HTMLElement,
})
const adapter = new ChatGPTAdapter()
const profile = document.querySelector('button')
assert.equal(adapter.getAccountIdentity().kind, 'email')
assert.equal(adapter.getAccountIdentifier(), 'alice@example.com', 'Conversation-body attributes cannot supply login identity')
profile.setAttribute('data-email', 'bob@example.com')
assert.equal(adapter.getAccountIdentifier(), 'bob@example.com', 'Same-name accounts remain distinct')
profile.setAttribute('data-user-name', 'Renamed Account')
assert.equal(adapter.getAccountIdentifier(), 'bob@example.com', 'Renaming does not change identity')
profile.removeAttribute('data-email')
assert.equal(adapter.getAccountIdentifier(), null)
assert.equal(adapter.getAccountLabel(), 'Renamed Account', 'A label may exist without reliable identity')
profile.setAttribute('data-email', 'bob@example.com')
profile.setAttribute('hidden', '')
assert.equal(adapter.getAccountIdentifier(), null, 'Hidden stale profile controls cannot identify a login')
profile.removeAttribute('hidden')
profile.innerHTML += '<span data-email="alice@example.com"></span>'
assert.equal(adapter.getAccountIdentifier(), null, 'Conflicting profile emails fail closed')

let contextEmail = 'alice@example.com'
const sender = { tab: { id: 1 }, frameId: 0, documentId: 'synthetic-source-document', url: 'https://chatgpt.com/c/synthetic-account-test' }
const pageAccount = verificationModule('src/background/page-account.ts', { chrome: { tabs: { sendMessage: async (_id, _message, options) => {
  assert.equal(options.documentId, sender.documentId)
  return { platform: 'chatgpt', conversationId: 'synthetic-account-test', url: sender.url, contentScriptBuildId: 'synthetic-build', accountIdentifier: contextEmail }
} } } }, { '../shared/build-id': { EXTENSION_BUILD_ID: 'synthetic-build' } })
assert.equal(await pageAccount.isChatGPTPageAccountCurrent(sender, 'synthetic-account-test', accountA), true)
contextEmail = 'bob@example.com'
assert.equal(await pageAccount.isChatGPTPageAccountCurrent(sender, 'synthetic-account-test', accountA), false, 'A changed login revokes an in-flight DOM save')
contextEmail = null
assert.equal(await pageAccount.isChatGPTPageAccountCurrent(sender, 'synthetic-account-test', accountA), false)
assert.equal(await pageAccount.isChatGPTPageAccountCurrent({ ...sender, documentId: undefined }, 'synthetic-account-test', 'unknown'), false)

const stores = new Map(['accounts', 'conversations', 'conversationExclusions'].map((name) => [name, new Map()]))
const writes = []
const database = {
  close() {},
  transaction(names) {
    return { objectStore(name) {
      assert.ok((Array.isArray(names) ? names : [names]).includes(name))
      const rows = stores.get(name)
      return {
        get: async (id) => structuredClone(rows.get(id)),
        getAll: async () => structuredClone([...rows.values()]),
        put: async (value) => { writes.push([name, 'put', value.id]); rows.set(value.id, structuredClone(value)); return value.id },
        delete: async (id) => { writes.push([name, 'delete', id]); rows.delete(id) },
        index: () => ({ getAll: async (id) => structuredClone([...rows.values()].filter((row) => row.conversationId === id)) }),
      }
    } }
  },
}
const db = {
  STORE_NAME: { ACCOUNTS: 'accounts', CONVERSATIONS: 'conversations', CONVERSATION_EXCLUSIONS: 'conversationExclusions' },
  CONVERSATION_INDEX: { CONVERSATION_ID: 'conversationId' },
  openDatabase: async () => database, requestToPromise: (request) => request, transactionToPromise: async () => {},
}
const overrides = { './database': db, '../db/database': db, '../db/settings': { initializeSettings: async () => {} } }
const service = verificationModule('src/services/conversation-service.ts', {}, overrides)
const accounts = verificationModule('src/services/account-service.ts', {}, overrides)
const migration = verificationModule('src/services/chatgpt-account-migration.ts', {}, overrides)
const data = verificationModule('src/services/data-management-service.ts', {}, overrides)
const exclusions = verificationModule('src/db/conversation-exclusions.ts', {}, overrides)
const payload = (accountId, label = 'Same Name', conversationId = 'synthetic-account-test') => ({
  platform: 'chatgpt', accountId, accountLabel: label, accountSource: 'detected', conversationId,
  title: 'Synthetic account isolation', url: `https://chatgpt.com/c/${conversationId}`,
  messages: [{ role: 'user', content: 'Synthetic question' }, { role: 'assistant', content: 'Synthetic answer' }],
  contentHash: 'a'.repeat(64), pinned: true,
})
const legacy = (await service.saveConversation(payload('unknown', 'Old Login Name'), 'manual')).conversation
stores.get('conversations').set(legacy.id, { ...legacy, important: true, imageAttachmentPermission: false, fileAttachmentPermission: true,
  pendingCapture: { reason: 'synthetic pending', source: 'page' },
  attachments: [{ id: 'f'.repeat(64), kind: 'file', name: 'fixture.txt', mimeType: 'text/plain', size: 1, status: 'saved', dataUrl: 'data:text/plain;base64,eA==' }],
})
const originalLegacy = structuredClone(stores.get('conversations').get(legacy.id))
const a = (await service.saveConversation(payload(accountA), 'manual')).conversation
const b = (await service.saveConversation(payload(accountB), 'manual')).conversation
assert.notEqual(a.id, b.id)
assert.equal(stores.get('conversations').size, 3, 'Old unknown data is retained alongside identified captures')
same(stores.get('conversations').get(legacy.id), originalLegacy, 'Recapture never assigns old unknown records to the current login')
assert.equal((await service.getSavedConversationBySource('chatgpt', a.conversationId, accountA)).id, a.id)
assert.equal((await service.getSavedConversationBySource('chatgpt', b.conversationId, accountB)).id, b.id)
assert.equal((await service.getSavedConversationBySource('chatgpt', a.conversationId)).id, legacy.id, 'Unscoped legacy requests never select another login')
assert.equal(await service.hasSavedConversation('chatgpt', 'synthetic-missing', accountA), false)
await service.updateConversationPinnedBySource('chatgpt', accountA, a.conversationId, false)
assert.equal(stores.get('conversations').get(b.id).pinned, true)
await accounts.syncDetectedAccountLabel('chatgpt', 'unknown', 'Another Login Name')
assert.equal(stores.get('accounts').get('unknown').label, identities.CHATGPT_UNKNOWN_ACCOUNT_LABEL)
await accounts.syncDetectedAccountLabel('chatgpt', accountA, 'New Display Name')
assert.equal(stores.get('accounts').get(accountB).label, 'Same Name')
await accounts.updateAccountLabel(accountA, 'Manual Group Label')
await service.saveConversation(payload(accountA, 'Host Renamed Again'), 'manual')
assert.equal(stores.get('accounts').get(accountA).label, 'Manual Group Label')
const knownBeforeLoss = structuredClone(stores.get('conversations').get(a.id))
await service.saveConversation(payload('unknown', 'New Display Name'), 'manual')
same(stores.get('conversations').get(a.id), knownBeforeLoss, 'Temporary identity loss does not rekey or update an identified record')

const tombstone = { id: await hashes.createConversationId('chatgpt', 'unknown', 'synthetic-excluded'), platform: 'chatgpt', accountId: 'unknown', conversationId: 'synthetic-excluded', title: 'Synthetic excluded', excludedAt: 1 }
stores.get('conversationExclusions').set(tombstone.id, structuredClone(tombstone))
assert.equal(await service.saveConversation(payload(accountA, 'Same Name', 'synthetic-excluded'), 'automatic'), null,
  'Identity discovery cannot bypass a legacy automatic-save exclusion')
const restored = await service.saveConversation(payload(accountA, 'Same Name', 'synthetic-excluded'), 'manual')
assert.ok(restored)
assert.ok(await service.saveConversation(payload(accountA, 'Same Name', 'synthetic-excluded'), 'automatic'), 'A manually restored identified record can keep updating')
same(stores.get('conversationExclusions').get(tombstone.id), tombstone)
await exclusions.deleteConversationWithExclusionPolicy(b.id)
assert.equal(stores.get('conversationExclusions').get(b.id).accountId, accountB)
assert.equal(await service.saveConversation(payload(accountB), 'automatic'), null)
assert.ok(await service.saveConversation(payload(accountA), 'automatic'), 'Another login exclusion cannot block this identified login')
await service.saveConversation(payload(accountB), 'manual')
const beforeRevokedSave = stores.get('conversations').size
let authorityChecks = 0
await assert.rejects(service.saveConversation(payload(accountA, 'Same Name', 'synthetic-revoked'), 'manual', async () => ++authorityChecks === 1), /账号保存授权已撤销/)
assert.equal(stores.get('conversations').size, beforeRevokedSave, 'Final authorization rejects a login change after preparation')

// Startup must not touch conversations, exclusions, distinct keys, colors or manual labels.
stores.get('accounts').set('unknown', { ...stores.get('accounts').get('unknown'), label: 'Old Detected Name', source: 'detected' })
const beforeRows = structuredClone([...stores.get('conversations')])
const beforeExclusions = structuredClone([...stores.get('conversationExclusions')])
writes.length = 0
assert.equal((await migration.normalizeChatGPTUnknownAccount()).changed, true)
assert.ok(writes.every(([name]) => name === 'accounts'))
same([...stores.get('conversations')], beforeRows)
same([...stores.get('conversationExclusions')], beforeExclusions)
assert.equal(stores.get('accounts').get(accountA).label, 'Manual Group Label')
assert.equal((await migration.normalizeChatGPTUnknownAccount()).changed, false)
stores.get('accounts').set('unknown', { ...stores.get('accounts').get('unknown'), label: 'Manual Historical Label', source: 'manual' })
assert.equal((await migration.normalizeChatGPTUnknownAccount()).changed, false)
assert.equal(stores.get('accounts').get('unknown').label, 'Manual Historical Label')

const exported = structuredClone(await data.exportAllData())
for (const store of stores.values()) store.clear()
const imported = await data.importAllData(exported)
assert.equal(imported.inserted, exported.conversations.length)
assert.equal(stores.get('accounts').size, exported.accounts.length)
same([...stores.get('conversations').keys()].sort(), exported.conversations.map((row) => row.id).sort())
const historical = stores.get('conversations').get(legacy.id)
assert.equal(historical.accountId, 'unknown')
assert.equal(historical.attachments[0].dataUrl, originalLegacy.attachments[0].dataUrl)
assert.equal(historical.important, true)
assert.equal(historical.imageAttachmentPermission, false)
assert.equal(historical.fileAttachmentPermission, true)
assert.equal(historical.pendingCapture.reason, 'synthetic pending')
assert.equal(stores.get('conversations').get(a.id).accountId, accountA)
assert.equal(stores.get('conversations').get(b.id).accountId, accountB)
// Shared-directory readers use these same validators; preserve legacy distinct keys too.
const oldKey = { ...exported.accounts.find((row) => row.id === accountA), id: 'legacy-distinct-key' }
assert.equal(data.validateAccount(oldKey, 0).id, oldKey.id)
assert.equal((await data.validateConversation({ ...exported.conversations.find((row) => row.id === a.id), accountId: oldKey.id }, 0)).accountId, oldKey.id)

// Read actual shared-directory files through production validators and routing.
class Directory {
  kind = 'directory'
  files = new Map()
  constructor(name) { this.name = name }
  async queryPermission() { return 'granted' }
  async getDirectoryHandle(name) {
    const entry = this.files.get(name)
    if (!entry || entry.kind !== 'directory') throw new DOMException('missing', 'NotFoundError')
    return entry
  }
  async getFileHandle(name) {
    const entry = this.files.get(name)
    if (!entry || entry.kind !== 'file') throw new DOMException('missing', 'NotFoundError')
    return entry
  }
  put(name, value) {
    this.files.set(name, { kind: 'file', getFile: async () => ({ size: JSON.stringify(value).length, text: async () => JSON.stringify(value) }) })
  }
  async *entries() { yield* this.files.entries() }
}
const localEnvironment = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherEnvironment = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const root = new Directory('synthetic-root')
const environments = new Directory('environments')
const remote = new Directory(`env-${otherEnvironment}`)
const files = new Directory('conversations')
root.files.set('environments', environments)
environments.files.set(remote.name, remote)
remote.files.set('conversations', files)
remote.put('environment.json', { schemaVersion: 1, environmentId: otherEnvironment, label: 'Synthetic environment', createdAt: 1, updatedAt: 2, conversationCount: exported.conversations.length })
remote.put('accounts.json', exported.accounts)
for (const row of exported.conversations) files.put(`${row.id}.json`, row)
const shared = verificationModule('src/services/shared-directory-service.ts', { DOMException }, {
  ...overrides,
  '../db/environment': { getSharedDirectoryHandle: async () => root, getLocalEnvironment: async () => ({ id: localEnvironment }) },
  '../db/settings': { getSettings: async () => ({ visibleEnvironmentIds: [otherEnvironment] }) },
})
const sharedEnvironment = (await shared.readVisibleSharedEnvironments())[0]
assert.equal(sharedEnvironment.accounts.length, exported.accounts.length)
same(sharedEnvironment.conversations.map((row) => row.id).sort(), exported.conversations.map((row) => row.id).sort())
assert.equal(sharedEnvironment.conversations.find((row) => row.id === a.id).accountId, accountA)
assert.equal(sharedEnvironment.conversations.find((row) => row.id === b.id).accountId, accountB)
assert.equal(sharedEnvironment.conversations.find((row) => row.id === legacy.id).attachments[0].dataUrl, originalLegacy.attachments[0].dataUrl)

console.log('ChatGPT account verification passed: scoped email evidence, same names/renames/loss, isolated saves/queries/pins/exclusions, document authorization, nondestructive startup, manual labels, lossless import and shared-directory read')
