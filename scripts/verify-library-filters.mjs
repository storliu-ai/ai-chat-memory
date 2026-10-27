import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

const require = createRequire(import.meta.url)
function load(path, dependencies) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  new Function('require', 'exports', code)((name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, exports)
  return exports
}

const account = (id, label, platform = 'chatgpt') => ({ id, label, platform, source: 'manual', createdAt: 1, updatedAt: 2 })
const conversation = (id, accountId, updatedAt = 10) => ({
  id, accountId, platform: 'chatgpt', title: id, messages: [{ role: 'user', content: id }],
  messageCount: 1, createdAt: 1, updatedAt, contentHash: id, important: false,
})
const local = { id: 'local', label: 'Local' }
const remote = { id: 'remote', label: 'Remote' }
const hidden = { id: 'hidden', label: 'Hidden' }
let visible = []
let reads = 0
const shared = [
  { environment: remote, accounts: [account('same', 'Remote name'), account('remote-only', 'Only remote'), account('unused', 'No conversations', 'gemini')], conversations: [conversation('collision', 'same', 20), conversation('remote-chat', 'remote-only')] },
  { environment: hidden, accounts: [account('hidden-only', 'Hidden name')], conversations: [conversation('hidden-chat', 'hidden-only')] },
]
const library = load('src/services/library-service.ts', {
  '../db/accounts': { getAllAccounts: async () => [account('same', 'Local name')] },
  '../db/conversations': { getAllConversations: async () => [conversation('collision', 'same')] },
  '../db/environment': { getLocalEnvironment: async () => local },
  '../shared/attachments': { stripConversationAttachmentData: (value) => value },
  './shared-directory-service': {
    getSharedDirectoryStatus: async () => ({ currentEnvironment: local, otherEnvironments: [remote, hidden], visibleEnvironmentIds: visible }),
    readVisibleSharedEnvironments: async () => { reads += 1; return shared.filter((item) => visible.includes(item.environment.id)) },
  },
})
const first = await library.getLibraryView()
assert.equal(reads, 0, 'Local-only display must not read shared accounts')
assert.deepEqual(first.filterAccounts.map((item) => item.label), ['Local name'])
visible = ['remote']
const all = await library.getLibraryView()
assert.equal(all.page.total, 2)
assert.equal(all.page.items.find((item) => item.id === 'collision').sourceIsLocal, true, 'Combined view retains local preference')
assert.equal(all.filterAccounts.filter((item) => item.id === 'same').length, 2, 'Equal account IDs keep their separate environment names')
assert.ok(all.filterAccounts.some((item) => item.id === 'unused'), 'Include shared accounts even without conversations')
assert.ok(!all.filterAccounts.some((item) => item.sourceEnvironmentId === 'hidden'))
const remoteView = await library.getLibraryView({ sourceEnvironmentId: 'remote' })
assert.equal(remoteView.page.total, 2)
assert.ok(remoteView.page.items.every((item) => item.sourceEnvironmentId === 'remote'))
assert.equal(remoteView.page.items.find((item) => item.id === 'collision').accountLabel, 'Remote name')
assert.ok(remoteView.filterAccounts.every((item) => item.sourceEnvironmentId === 'remote'))
const selectedAccount = await library.getLibraryView({ accountId: 'same', accountSourceEnvironmentId: 'remote' })
assert.equal(selectedAccount.page.total, 1)
assert.equal(selectedAccount.page.items[0].sourceEnvironmentId, 'remote', 'Select account environment before resolving duplicate conversations')
assert.equal(selectedAccount.filterAccounts.length, all.filterAccounts.length, 'Selecting an account must not shrink account options')
assert.equal((await library.getLibraryView({ sourceEnvironmentId: 'hidden' })).page.total, 0, 'A filter cannot authorize reading an undisplayed environment')
assert.equal((await library.getLibraryView({ sourceEnvironmentId: 'local', accountSourceEnvironmentId: 'remote', accountId: 'same' })).page.total, 0)
visible = []
assert.deepEqual((await library.getLibraryView()).filterAccounts.map((item) => item.sourceEnvironmentId), ['local'])

const { FilterBar } = load('src/panel/components/FilterBar.tsx', {
  'react/jsx-runtime': require('react/jsx-runtime'),
  '../../shared/models': { PLATFORM_LABELS: { chatgpt: 'ChatGPT', gemini: 'Gemini', deepseek: 'DeepSeek' } },
})
const props = { environmentId: 'all', environments: [local, remote], platform: 'all', accountId: 'all', time: 'all', importance: 'all', accounts: all.filterAccounts }
const html = renderToStaticMarkup(createElement(FilterBar, props))
assert.equal((html.match(/<select/g) ?? []).length, 5)
assert.ok(html.includes('全部显示环境'))
assert.ok(html.includes('Remote name · Remote'))
assert.ok(html.includes('Local name · Local'))
assert.ok(!renderToStaticMarkup(createElement(FilterBar, { ...props, platform: 'chatgpt' })).includes('No conversations'))
console.log('library filters verification passed: environment scope, shared account labels, duplicate copies, display authorization and five controls')
