import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, dependencies = {}, globals = {}, append = '') {
  const code = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  runInNewContext(code + append, { exports, URL, Blob, TextEncoder, crypto: webcrypto, ...globals, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`)
    return dependencies[name]
  } }, { filename: path })
  return exports
}
const models = load('src/shared/models.ts')
const attachments = load('src/shared/attachments.ts', { './models': models })
const local = load('src/shared/local-attachments.ts', { './attachments': attachments })
const hash = load('src/utils/hash.ts', { './stable-serialize': load('src/utils/stable-serialize.ts') })
const errors = load('src/services/errors.ts')
const fixture = () => ({ id: 'conversation-local', platform: 'chatgpt', accountId: 'unknown', conversationId: 'native-fixture',
  title: 'Fixture title', url: 'https://chatgpt.com/c/native-fixture', messages: [{ role: 'user', content: 'File question', sourceTurnId: 'user-1', attachmentNames: ['upload.txt'] }, { role: 'assistant', content: 'File answer', sourceTurnId: 'answer-1', sentAt: 60000, sentAtPrecision: 'minute' }],
  attachments: [{ id: 'a'.repeat(64), kind: 'file', name: 'upload.txt', mimeType: 'application/octet-stream', size: null, status: 'unavailable', messageIndex: 0, sourceTurnId: 'user-1' }, { id: 'b'.repeat(64), kind: 'image', name: 'kept.png', mimeType: 'image/png', size: 1, status: 'saved', dataUrl: 'data:image/png;base64,YQ==', messageIndex: 1, sourceTurnId: 'answer-1' }],
  pinned: true, important: true, imageAttachmentPermission: false, fileAttachmentPermission: true, createdAt: 1, updatedAt: 2, messageCount: 2, contentHash: 'old' })
let record = fixture(), writes = 0, settings = { ...models.DEFAULT_SETTINGS, fileSavePolicy: 'per-conversation' }
const service = load('src/services/local-attachment-service.ts', {
  '../db/conversations': { getConversation: async (id) => id === record?.id ? structuredClone(record) : null, putConversation: async (value) => { writes++; record = structuredClone(value); return value } },
  '../db/settings': { getSettings: async () => settings },
  '../shared/attachments': attachments, '../shared/local-attachments': local,
  '../utils/hash': hash, './errors': errors,
})
const copy = { name: 'upload.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain;base64,YWJj' }
const before = structuredClone(record)
const saved = await service.supplementLocalAttachment(record.id, record.attachments[0].id, copy)
assert.equal(writes, 1)
assert.equal(saved.attachments[0].status, 'saved')
assert.equal(saved.attachments[0].dataUrl, copy.dataUrl)
assert.equal(saved.attachments[0].id, before.attachments[0].id)
assert.equal(saved.attachments[0].messageIndex, 0)
assert.equal(saved.attachments[0].sourceTurnId, 'user-1')
assert.deepEqual(saved.attachments[1], before.attachments[1])
for (const key of ['messages', 'accountId', 'conversationId', 'title', 'url', 'pinned', 'important', 'imageAttachmentPermission', 'fileAttachmentPermission', 'createdAt']) assert.deepEqual(saved[key], before[key], `Local supplementation preserves ${key}`)
assert.equal(saved.contentHash, await hash.createContentHash(saved.title, saved.messages, saved.attachments))
assert.deepEqual(JSON.parse(JSON.stringify(attachments.mergeConversationAttachments(saved.attachments, before.attachments)[0])), JSON.parse(JSON.stringify(saved.attachments[0])), 'A later metadata-only page update preserves the local binary')
await assert.rejects(() => service.supplementLocalAttachment(record.id, record.attachments[0].id, copy), /已有本地副本/)

async function rejected({ file = copy, alter = () => {}, attachmentId = 'a'.repeat(64), pattern } = {}) {
  record = fixture(); settings = { ...models.DEFAULT_SETTINGS, fileSavePolicy: 'per-conversation' }; writes = 0
  alter()
  await assert.rejects(() => service.supplementLocalAttachment('conversation-local', attachmentId, file), pattern)
  assert.equal(writes, 0, 'Rejected selections never alter an existing record')
}
await rejected({ file: { ...copy, name: 'wrong.txt' }, pattern: /同名/ })
await rejected({ file: { ...copy, size: 4 }, pattern: /无效/ })
await rejected({ file: { ...copy, dataUrl: 'https://example.test/remote-file' }, pattern: /无效/ })
await rejected({ file: { ...copy, dataUrl: 'data:text/plain;base64,invalid!' }, pattern: /无效/ })
await rejected({ alter: () => { record = null }, pattern: /已删除/ })
await rejected({ alter: () => { record.fileAttachmentPermission = false }, pattern: /权限/ })
await rejected({ alter: () => { settings.fileSavePolicy = 'never' }, pattern: /设置/ })
await rejected({ attachmentId: 'missing', pattern: /未找到/ })
await rejected({ attachmentId: 'b'.repeat(64), pattern: /普通文件/ })
const twoMb = { ...copy, size: 2 * 1024 * 1024, dataUrl: `data:text/plain;base64,${Buffer.alloc(2 * 1024 * 1024).toString('base64')}` }
await rejected({ file: twoMb, alter: () => { settings.attachmentMaxSizeMb = 1 }, pattern: /1 MB/ })
await rejected({ alter: () => {
  const bytes = 10 * 1024 * 1024
  const dataUrl = `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString('base64')}`
  record.attachments = [record.attachments[0], ...[1, 2, 3].map(index => ({ id: String(index).repeat(64), kind: 'file', name: `kept-${index}.bin`, mimeType: 'application/octet-stream', size: bytes, status: 'saved', dataUrl }))]
}, pattern: /30 MB/ })

let reads = 0
class FileReader {
  readAsDataURL(blob) {
    reads++
    blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.() })
  }
}
const reader = load('src/panel/local-attachment-file.ts', { '../shared/attachments': attachments, '../shared/local-attachments': local }, { FileReader })
const textPreview = load('src/panel/text-attachment-preview.ts', { '../shared/attachments': attachments })
const file = Object.assign(new Blob(['abc'], { type: 'text/plain' }), { name: 'upload.txt' })
assert.deepEqual(JSON.parse(JSON.stringify(await reader.readLocalAttachmentFile(file, 'upload.txt', 10 * 1024 * 1024))), copy)
assert.equal(reads, 1)
for (const [testFile, limit, pattern] of [[{ name: 'wrong.txt', size: 1 }, 100, /同名/], [{ name: 'upload.txt', size: 0 }, 100, /为空/], [{ name: 'upload.txt', size: 11 * 1024 * 1024 }, 50 * 1024 * 1024, /上限/]]) {
  await assert.rejects(() => reader.readLocalAttachmentFile(testFile, 'upload.txt', limit), pattern)
  assert.equal(reads, 1, 'Invalid files are rejected before their contents are read')
}

// Render the actual card: only missing local ordinary files expose a chooser.
const jsx = (type, props) => ({ type, props })
let chooserClicks = 0, selection
const page = load('src/panel/pages/ConversationDetailPage.tsx', {
  react: { useRef: () => ({ current: { click: () => chooserClicks++ } }) }, 'react/jsx-runtime': { jsx, jsxs: jsx },
  '../../shared/models': models, '../../shared/extension-events': {}, '../../shared/attachments': attachments,
  '../components/ConfirmDialog': {}, '../components/ConversationExportDialog': {}, '../components/ImagePreviewDialog': {}, '../components/MessageContent': {},
  '../components/TextAttachmentPreviewDialog': {}, '../text-attachment-preview': textPreview,
  '../services/panel-api': {}, '../attachment-placement': {}, '../local-attachment-file': reader,
}, {}, '\nexports.testCard = StoredAttachmentCard;')
const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)]
const props = { attachment: fixture().attachments[0], settings, saveImages: true, onPreview() {}, onSupplement: (attachment, file) => { selection = { attachment, file } } }
const tree = nodes(page.testCard(props))
tree.find(node => node.type === 'button').props.onClick()
assert.equal(chooserClicks, 1)
const input = tree.find(node => node.type === 'input')
assert.equal(input.props.type, 'file')
const target = { files: [file], value: 'selected' }
input.props.onChange({ currentTarget: target })
assert.equal(selection.file, file)
assert.equal(selection.attachment.id, props.attachment.id)
assert.equal(target.value, '', 'Reselecting the same file after an error is possible')
assert.equal(nodes(page.testCard({ ...props, onSupplement: undefined })).some(node => node.type === 'input'), false, 'Other environments expose no file picker')
assert.equal(nodes(page.testCard({ ...props, attachment: saved.attachments[0] })).some(node => node.type === 'input'), false, 'Saved files keep their download action')
assert.equal(nodes(page.testCard({ ...props, attachment: fixture().attachments[1] })).some(node => node.type === 'input'), false, 'Images keep their existing capture flow')
assert.equal(nodes(page.testCard({ ...props, supplementDisabledReason: 'Enable file permission' })).find(node => node.type === 'button').props.disabled, true)

// The detail page must discard a file-read result after the user navigates.
function detailHarness() {
  let props = { conversationId: 'conversation-local', sourceEnvironmentId: 'local', sourceEnvironmentLabel: '', sourceIsLocal: true, sourceAccountLabel: '', onDeleted() {} }
  const slots = [], effects = [], cleanups = [], saves = []
  let at = 0, dirty = true, tree, finishRead
  const hooks = {
    useState(initial) {
      const index = at++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], next => { const value = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true } }]
    },
    useRef(initial) { const index = at++; return slots[index] ??= { current: initial } },
    useMemo(callback) { return callback() },
    useCallback(callback) { return callback },
    useEffect(callback, deps) {
      const index = at++
      if (!slots[index] || deps.some((value, offset) => !Object.is(value, slots[index][offset]))) {
        slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = callback() })
      }
    },
  }
  const events = { addEventListener() {}, removeEventListener() {}, setTimeout: () => 1, clearTimeout() {} }
  const view = load('src/panel/pages/ConversationDetailPage.tsx', {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../shared/models': models, '../../shared/attachments': attachments,
    '../../shared/extension-events': {}, '../components/ConfirmDialog': {}, '../components/ConversationExportDialog': {}, '../components/ImagePreviewDialog': {}, '../components/MessageContent': {},
    '../components/TextAttachmentPreviewDialog': {}, '../text-attachment-preview': textPreview,
    '../attachment-placement': load('src/panel/attachment-placement.ts'),
    '../local-attachment-file': { readLocalAttachmentFile: () => new Promise(resolve => { finishRead = resolve }) },
    '../services/panel-api': {
      getConversation: async id => ({ ...fixture(), id }), getAccounts: async () => [], getSettings: async () => ({ ...models.DEFAULT_SETTINGS, fileSavePolicy: 'per-conversation' }),
      supplementConversationAttachment: async (id, attachmentId, file) => { saves.push({ id, attachmentId, file }); return { ...saved, id } },
    },
  }, { Error, window: events, document: events, chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } } })
  const flush = async () => { for (let round = 0; round < 30; round++) { if (dirty) { at = 0; dirty = false; tree = view.ConversationDetailPage(props); for (const effect of effects.splice(0)) effect() } await Promise.resolve() } }
  return { flush, saves, select: () => nodes(tree).find(node => node.type?.name === 'StoredAttachmentCard' && node.props.attachment.kind === 'file').props.onSupplement(fixture().attachments[0], file),
    navigate: id => { props = { ...props, conversationId: id }; dirty = true }, finish: () => finishRead(copy) }
}
const detail = detailHarness()
await detail.flush()
detail.select()
await detail.flush()
detail.navigate('other-conversation')
await detail.flush()
detail.finish()
await detail.flush()
assert.equal(detail.saves.length, 0, 'Navigation while choosing/reading a file must not write to either conversation')
detail.select()
await detail.flush()
detail.finish()
await detail.flush()
assert.equal(detail.saves.length, 1)
assert.equal(detail.saves[0].id, 'other-conversation')
assert.equal(detail.saves[0].attachmentId, fixture().attachments[0].id)

// Sender validation runs before copying bytes; host content scripts cannot use
// the Manager-only operation. The existing queue serializes all data mutations.
const workerSource = source('src/background/service-worker.ts')
const workerDependencies = Object.fromEntries(ts.preProcessFile(workerSource).importedFiles.map(({ fileName }) => [fileName, {}]))
let serviceCalls = 0, notifications = 0, mirrors = 0
Object.assign(workerDependencies, {
  '../shared/runtime-messages': load('src/shared/runtime-messages.ts'),
  '../shared/local-attachments': local, '../shared/attachments': attachments,
  '../services/local-attachment-service': { supplementLocalAttachment: async () => { serviceCalls++; return saved } },
  '../services/conversation-service': { getConversationById: async () => saved },
  '../services/shared-directory-service': { mirrorLocalConversation: async () => { mirrors++ } },
})
const listener = { addListener() {} }
const chrome = { runtime: { getURL: path => `chrome-extension://fixture/${path}`, sendMessage: async () => { notifications++ }, onInstalled: listener, onStartup: listener, onMessage: listener }, action: { onClicked: listener }, tabs: { onRemoved: listener, onUpdated: listener } }
const workerCode = ts.transpileModule(workerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText.replace(/\ninitializeExtension\(\);/, '\n')
const worker = {}
runInNewContext(workerCode + '\nexports.dispatch = dispatchRuntimeRequest;', { exports: worker, chrome, require: name => workerDependencies[name] })
const request = { type: 'SUPPLEMENT_LOCAL_ATTACHMENT', id: saved.id, attachmentId: saved.attachments[0].id, file: copy }
for (const url of ['https://chatgpt.com/c/native-fixture', 'chrome-extension://fixture/panel.html', 'https://example.test/manager.html']) assert.equal((await worker.dispatch(request, { url })).ok, false)
assert.equal(serviceCalls, 0)
assert.equal((await worker.dispatch({ ...request, file: { ...copy, size: 4 } }, { url: chrome.runtime.getURL('manager.html') })).ok, false)
assert.equal((await worker.dispatch(request, { url: `${chrome.runtime.getURL('manager.html')}?view=detail` })).ok, true)
assert.equal(serviceCalls, 1)
assert.equal(notifications, 1)
assert.equal(mirrors, 1)
assert.match(workerSource, /runtimeDataQueue\.then\(\(\) => handleRuntimeMessage/)
assert.doesNotMatch(source('src/services/local-attachment-service.ts') + source('src/panel/local-attachment-file.ts'), /\bfetch\s*\(/)
console.log('local attachment verification passed: explicit chooser, exact file mapping, byte limits, permissions, Manager-only requests and binary preservation')
