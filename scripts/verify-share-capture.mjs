import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
  const exports = {}
  runInNewContext(code, { exports, URL, crypto, setTimeout, clearTimeout, ...globals, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`)
    return dependencies[name]
  } }, { filename: path })
  return exports
}
const share = load('src/shared/share-capture.ts')
const reconciliation = load('src/shared/conversation-reconciliation.ts')
const continuity = load('src/shared/capture-continuity.ts')
const sampleUrl = 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherUrl = 'https://chatgpt.com/share/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const message = (order, extra = {}) => ({ role: order % 2 ? 'user' : 'assistant', content: `Synthetic unique message number ${order}; source verification only.`, sourceOrder: order, sourceTurnId: `turn-${order}`, ...extra })
const messages = Array.from({ length: 20 }, (_, i) => message(i + 1))
const capture = { platform: 'chatgpt', conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Public title', url: sampleUrl, accountIdentifier: null, accountLabel: 'Unknown', messages, captureComplete: true }
assert.equal(share.getShareCaptureProgress(null), 3)
assert.equal(share.getShareCaptureProgress({ phase: 'scanning', progress: 48 }), 48)
assert.equal(share.getShareCaptureProgress({ phase: 'needs-foreground', progress: 48 }), 48)
assert.equal(share.getShareCaptureProgress({ phase: 'scanning', progress: 100 }), 85, 'Reading the page cannot report a confirmed save')
assert.equal(share.getShareCaptureProgress({ phase: 'ready', progress: 85 }), 95)
assert.equal(share.getShareCaptureProgress({ phase: 'complete' }), 100)
assert.equal(share.normalizeChatGPTShareUrl(`${sampleUrl}?tracking=1#fragment`), sampleUrl)
for (const url of ['http://chatgpt.com/share/x', 'https://chatgpt.com.evil.test/share/x', 'https://user:secret@chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'https://chatgpt.com/c/conversation-a', `${sampleUrl}/extra`]) assert.equal(share.normalizeChatGPTShareUrl(url), null)
const oldSnapshot = messages.slice(0, 10)
const local = [message(3, { sentAt: 60_000, sentAtPrecision: 'minute' }), message(4), message(8, { content: 'Newer edited local text', attachmentNames: ['kept.png'] }), message(11), message(12)]
const supplemented = share.supplementConversationMessages(local, oldSnapshot)
assert.deepEqual(Array.from(supplemented, (m) => m.sourceOrder), Array.from({ length: 12 }, (_, i) => i + 1))
assert.equal(supplemented[7].content, 'Newer edited local text')
assert.equal(supplemented[2].sentAt, 60_000)
assert.deepEqual(Array.from(supplemented[7].attachmentNames), ['kept.png'])
assert.equal(local.length, 5, 'The merge must not mutate its source')
assert.throws(() => share.supplementConversationMessages(local, messages.map((m) => ({ ...m, content: 'Unrelated text' }))), /锚点/)
const repeated = [message(1), message(2), message(1), message(2)]
assert.equal(share.findShareAnchor(messages.slice(0, 2), repeated), null, 'Repeated question/answer text must not authorize an ambiguous link')

const originatingFile = { name: 'origin upload.txt', kind: 'file', mimeType: 'text/plain', size: 1, sourceUrl: 'data:text/plain;base64,YQ==', messageIndex: 0, sourceTurnId: messages[4].sourceTurnId }
const sourceWithFile = { ...capture, accountIdentifier: 'Fixture Account', accountLabel: 'Fixture Account', messages: messages.slice(4, 8), attachmentCandidates: [originatingFile] }
const retainedFile = share.supplementShareCapture(sourceWithFile, { ...capture, attachmentCandidates: [{ ...originatingFile, sourceUrl: null, messageIndex: 4 }] })
assert.equal(retainedFile.accountLabel, 'Fixture Account', 'A public Unknown label never replaces the original account')
assert.equal(retainedFile.attachmentCandidates.length, 1, 'Native and public cards for the same file are deduplicated')
assert.equal(retainedFile.attachmentCandidates[0].sourceUrl, originatingFile.sourceUrl)
assert.equal(retainedFile.attachmentCandidates[0].messageIndex, 4, 'Source window indexes are remapped by message identity')
assert.equal(retainedFile.messages[4].role, 'user')
const noPublicFiles = share.supplementShareCapture(sourceWithFile, capture)
assert.equal(noPublicFiles.attachmentCandidates[0].messageIndex, 4, 'Original-page uploads survive an empty public attachment list')
const sparseFileSource = { ...sourceWithFile, messages: [messages[4], messages[5], messages[10]], attachmentCandidates: [{ ...originatingFile, messageIndex: 2, sourceTurnId: messages[10].sourceTurnId }] }
assert.equal(share.supplementShareCapture(sparseFileSource, capture).attachmentCandidates[0].messageIndex, 10)
const legacyFileSource = { ...sourceWithFile, messages: messages.slice(4, 8).map(({ role, content }) => ({ role, content })), attachmentCandidates: [{ ...originatingFile, sourceTurnId: undefined }] }
assert.equal(share.supplementShareCapture(legacyFileSource, { ...capture, messages: messages.map(({ role, content }) => ({ role, content })) }).attachmentCandidates[0].messageIndex, 4, 'Unique contiguous content anchors support older message formats')
const sameNameAnswer = share.supplementShareCapture(sourceWithFile, { ...capture, attachmentCandidates: [{ ...originatingFile, sourceUrl: null, messageIndex: 5, sourceTurnId: messages[5].sourceTurnId }] })
assert.equal(sameNameAnswer.attachmentCandidates.length, 2, 'A same-named assistant file is a separate attachment')
assert.deepEqual(Array.from(sameNameAnswer.attachmentCandidates, (candidate) => candidate.messageIndex).sort(), [4, 5])

// Exercise the actual collector with a virtualized public-viewer layout: main
// and its inner content report scrollHeight, but only an ancestor can scroll.
// First and last turns remain mounted while the middle window moves.
async function scan({ missing = null, cancelAt = null, skipped = [] } = {}) {
  let position = 1600
  let alive = true
  let steps = 0
  let root
  let main
  let layer
  class Element {
    parentElement = null
    isConnected = true
    clientHeight = 200
    scrollHeight = 2000
    get scrollTop() { return this === root ? position : 0 }
    set scrollTop(value) { if (this === root) position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) }
    contains(element) { return this === element || this === main && element === layer }
    querySelectorAll(selector) { return selector === '*' ? this === main ? [layer] : [] : turns() }
    querySelector() { return turns()[0] ?? null }
    getBoundingClientRect() { return { top: 0, bottom: 200, height: 200 } }
  }
  root = new Element()
  main = new Element()
  layer = new Element()
  main.parentElement = root
  layer.parentElement = main
  const visible = () => {
    const first = Math.floor(position / 100) + 1
    return messages.filter((m) => m.sourceOrder !== missing && (m.sourceOrder === 1 || m.sourceOrder === 20 || m.sourceOrder >= first && m.sourceOrder <= first + 3))
  }
  const turns = () => visible().map((m) => ({ parentElement: main, getBoundingClientRect: () => ({ top: (m.sourceOrder - 1) * 100 - position, bottom: m.sourceOrder * 100 - position, height: 100 }) }))
  const window = { innerHeight: 200, scrollY: 0, getComputedStyle: (element) => ({ overflowY: element === root ? 'auto' : 'visible' }), setTimeout: (callback) => setTimeout(callback, 1), clearTimeout, requestAnimationFrame: (callback) => setTimeout(callback, 1) }
  const collector = load('src/adapters/dom-scroll-collector.ts', { '../shared/conversation-reconciliation': reconciliation, '../shared/capture-continuity': continuity }, { Element, window, document: { body: null, documentElement: { scrollHeight: 200 }, scrollingElement: null }, MutationObserver: class { observe() {} disconnect() {} } })
  return collector.collectConversationByScrolling({ strategy: 'overlapping-forward', container: main, getContainer: () => main, conversationId: 'test', getConversationId: () => alive ? 'test' : null, extractConversation: () => ({ ...capture, conversationId: 'test', messages: visible() }), turnSelector: 'turn', getVerifiedEmptySourceOrders: () => skipped, beforeStep: async () => { steps += 1; if (cancelAt === steps) alive = false } })
}
const scanned = await scan()
assert.equal(scanned.captureComplete, true)
assert.equal(scanned.messages.length, 20)
const hole = await scan({ missing: 10 })
assert.equal(hole.captureComplete, false)
assert.equal(hole.captureIncompleteReason, 'gap', 'Sticky distant rows cannot excuse a skipped middle message')
assert.notEqual((await scan({ cancelAt: 3 })).captureComplete, true)
assert.equal((await scan({ missing: 10, skipped: [10] })).captureComplete, true, 'Only adapter-verified non-message turns can explain a missing source order')

// Execute the capture-page lifecycle, including background rendering pauses.
// Browser visibility/timers are deterministic; the production runner owns all
// retry, cancellation, progress and finish decisions.
async function capturePage({ hidden = true, rendered = true, collect, onDelay = () => undefined }) {
  const requests = []
  const statuses = []
  const visibilityListeners = new Set()
  const runtimeListeners = []
  const intervals = new Set()
  const location = { href: sampleUrl }
  let clock = 0
  let delays = 0
  let scans = 0
  let status = { id: 'capture-page-job', conversationId: 'conversation-a', originTabId: 1, captureTabId: 101, phase: 'loading', messageCount: 0, progress: 3, message: 'Loading', updatedAt: clock }
  const document = {
    get hidden() { return hidden },
    addEventListener: (type, listener) => { assert.equal(type, 'visibilitychange'); visibilityListeners.add(listener) },
    removeEventListener: (type, listener) => { assert.equal(type, 'visibilitychange'); visibilityListeners.delete(listener) },
  }
  const notify = (phase) => {
    status = { ...status, phase }
    for (const listener of runtimeListeners) listener({ type: share.SHARE_TASK_STATUS_EVENT, status }, {}, () => undefined)
  }
  const control = {
    get phase() { return status.phase },
    get scans() { return scans },
    get elapsed() { return clock },
    advance: (ms) => { clock += ms },
    setHidden: (value) => { hidden = value; for (const listener of visibilityListeners) listener() },
    render: () => { rendered = true },
    cancel: () => notify('cancelled'),
  }
  const runner = load('src/content/share-capture.ts', {
    '../adapters/chatgpt/chatgpt-share-adapter': { ChatGPTShareAdapter: class {
      getMessages() { return rendered ? messages : [] }
      async collectShareConversation(beforeStep, onProgress, onScanProgress) {
        scans += 1
        await beforeStep()
        return collect(control, beforeStep, onProgress, onScanProgress)
      }
    } },
    '../shared/build-id': { EXTENSION_BUILD_ID: 'test-build' },
    '../shared/runtime-messages': load('src/shared/runtime-messages.ts'),
    '../shared/share-capture': share,
    './share-capture-status': { showShareCaptureStatus: (initial) => {
      statuses.push(structuredClone(initial))
      return (next) => statuses.push(structuredClone(next))
    } },
    '../shared/runtime-client': { sendRuntimeRequest: async (request) => {
      requests.push(structuredClone(request))
      assert.equal(request.contentScriptBuildId, 'test-build')
      if (request.action === 'progress') {
        status = { ...status, phase: request.phase, messageCount: Math.max(status.messageCount, request.messageCount), progress: Math.max(status.progress, request.progress), updatedAt: clock }
      } else if (request.action === 'finish') {
        notify(request.error ? 'failed' : 'complete')
      } else assert.equal(request.action, 'claim')
      return { status: structuredClone(status) }
    } },
  }, {
    location, document, Date: class extends Date { static now() { return clock } },
    chrome: { runtime: { onMessage: { addListener: (listener) => runtimeListeners.push(listener) } } },
    window: {
      setTimeout: (callback, ms) => setTimeout(() => {
        clock += ms
        assert.ok(++delays < 200, 'The capture-page scenario must settle or cancel')
        onDelay(control)
        callback()
      }, 0),
      setInterval: (callback) => { intervals.add(callback); return callback },
      clearInterval: (callback) => intervals.delete(callback),
    },
  })
  await runner.runShareCapturePage()
  assert.equal(intervals.size, 0, 'Every exit must stop the heartbeat')
  assert.equal(visibilityListeners.size, 0, 'Every exit must remove visibility tracking')
  return { requests, statuses, scans, elapsed: clock }
}
const backgroundScan = await capturePage({ collect: async (control, beforeStep, onProgress) => {
  control.advance(20_000)
  await beforeStep()
  onProgress(20)
  await beforeStep()
  return capture
} })
assert.equal(backgroundScan.requests.some((request) => request.phase === 'needs-foreground'), false, 'Elapsed time alone must not interrupt a productive hidden scan')
assert.equal(backgroundScan.requests.find((request) => request.action === 'finish').capture.captureComplete, true)

const repeatedPauses = await capturePage({
  onDelay: (control) => { assert.equal(control.phase, 'needs-foreground'); control.setHidden(false) },
  collect: async (control, beforeStep, onProgress, onScanProgress) => {
    onProgress(control.scans === 1 ? 12 : control.scans === 4 ? 20 : 6)
    await beforeStep()
    onScanProgress(control.scans === 1 ? 0.6 : control.scans === 4 ? 1 : 0.2)
    await beforeStep()
    if (control.scans === 4) return capture
    if (control.scans === 2) control.setHidden(true)
    // A hidden/visible transition during a render wait must also allow retry,
    // even if the page has already returned to the foreground when it ends.
    if (control.scans === 3) { control.setHidden(true); control.setHidden(false) }
    return { ...capture, captureComplete: false, captureIncompleteReason: 'gap' }
  },
})
assert.equal(repeatedPauses.scans, 4, 'Repeated visibility interruptions must reuse the live job until a fully rendered scan completes')
assert.equal(repeatedPauses.requests.filter((request) => request.phase === 'needs-foreground').length, 2)
assert.equal(repeatedPauses.requests.filter((request) => request.action === 'claim').length, 1)
const reported = repeatedPauses.requests.filter((request) => request.action === 'progress')
assert.ok(reported.every((request, index) => index === 0 || request.messageCount >= reported[index - 1].messageCount && request.progress >= reported[index - 1].progress), 'Retries must preserve both count and progress')
assert.equal(repeatedPauses.requests.find((request) => request.action === 'finish').capture.captureComplete, true)

const incompleteVisible = await capturePage({ hidden: false, collect: async () => ({ ...capture, captureComplete: false, captureIncompleteReason: 'gap' }) })
assert.equal(incompleteVisible.scans, 1, 'Real completeness failures in an uninterrupted foreground scan must not retry forever')
assert.match(incompleteVisible.requests.find((request) => request.action === 'finish').error, /消息序号缺口/)
assert.equal(incompleteVisible.requests.some((request) => request.capture), false, 'Incomplete content cannot enter the save stage')

const cancelledPause = await capturePage({ collect: async () => ({ ...capture, captureComplete: false }), onDelay: (control) => control.cancel() })
assert.equal(cancelledPause.scans, 1)
assert.equal(cancelledPause.requests.some((request) => request.action === 'finish'), false, 'Cancelling a paused job must prevent both retry and finish')

const slowLoad = await capturePage({ rendered: false, collect: async () => capture, onDelay: (control) => {
  if (control.phase === 'needs-foreground') {
    assert.ok(control.elapsed > 30_000, 'Give the hidden page its loading grace period')
    control.setHidden(false)
    control.render()
  }
} })
assert.equal(slowLoad.scans, 1)
assert.equal(slowLoad.requests.find((request) => request.action === 'finish').capture.captureComplete, true)
const unreadableVisible = await capturePage({ hidden: false, rendered: false, collect: async () => capture })
assert.equal(unreadableVisible.scans, 0)
assert.match(unreadableVisible.requests.find((request) => request.action === 'finish').error, /未显示可读取消息/)

// Execute the real ChatGPT fallback extraction against small structural DOM
// fixtures. No thought label or expanded thought markdown becomes message text.
let clock = 0
class DomElement {
  attrs = {}
  children = []
  textContent = ''
  get innerText() { return this.textContent }
  getAttribute(name) { return this.attrs[name] ?? null }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)) }
  matches(selector) { return selector.includes('data-testid') && !!this.attrs['data-testid'] }
  closest() { return this.turn ?? null }
  querySelectorAll() { return [] }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  getBoundingClientRect() { return this.bounds ?? { top: 10, bottom: 50 } }
}
const selectors = load('src/adapters/chatgpt/selectors.ts', {}, { CSS: { escape: (value) => value } })
const baseAdapter = load('src/adapters/base-adapter.ts', {
  '../shared/message-timestamps': load('src/shared/message-timestamps.ts'),
  './pin-descriptors': load('src/adapters/pin-descriptors.ts'),
}, { HTMLElement: DomElement, HTMLTimeElement: class extends DomElement {} })
const nativeAdapter = load('src/adapters/chatgpt/chatgpt-adapter.ts', {
  '../base-adapter': baseAdapter,
  '../../shared/account-labels': load('src/shared/account-labels.ts'),
  './selectors': selectors,
  '../attachment-candidates': { collectAttachmentCandidates: ([{ root }]) => root.attachments ?? [] },
  '../dom-scroll-collector': {},
  './message-time': {},
}, { HTMLElement: DomElement, Date: { now: () => clock }, location: { href: 'https://chatgpt.com/c/source' }, window: { innerHeight: 800 } })
const fixture = ({ order, thought = false, expanded = false, answer = '', empty = false, busy = false, offscreen = false, attachment = false }) => {
  const turn = new DomElement()
  turn.attrs = { 'data-turn': 'assistant', 'data-turn-id': `native-${order}`, 'data-testid': `conversation-turn-${order}` }
  if (offscreen) turn.bounds = { top: 900, bottom: 950 }
  const thoughtRoot = new DomElement()
  const button = new DomElement()
  button.textContent = thought === 'pending' ? 'Thinking for 1m' : '思考了 1m 44s'
  button.attrs = { 'aria-expanded': expanded ? 'true' : 'false' }
  button.parentElement = thoughtRoot
  const thoughtText = new DomElement()
  thoughtText.textContent = 'Synthetic thought details must never be saved'
  thoughtRoot.children = [button, thoughtText]
  const answerNode = new DomElement()
  answerNode.textContent = answer
  answerNode.turn = turn
  const marker = new DomElement()
  turn.attachments = attachment ? [{ name: 'synthetic.png', kind: 'image' }] : []
  turn.querySelectorAll = (selector) => {
    if (selector === '[data-streaming-response-group] button[aria-expanded]') return thought ? [button] : []
    if (selector === selectors.CHATGPT_SELECTORS.MESSAGE_CONTENT.join(',')) return [...(thought && expanded ? [thoughtText] : []), ...(answer ? [answerNode] : [])]
    if (selector === 'span.sr-only:has(> br)') return empty ? [marker] : []
    if (selector === '[aria-busy="true"], [role="progressbar"]') return busy ? [marker] : []
    return []
  }
  return turn
}
const adapter = new nativeAdapter.ChatGPTAdapter()
const thoughtOnly = fixture({ order: 2, thought: true, expanded: true })
assert.equal(adapter.readTurnEntries(thoughtOnly).length, 0)
clock = 900
assert.equal(adapter.readTurnEntries(thoughtOnly).length, 0)
assert.deepEqual(Array.from(adapter.getVerifiedEmptySourceOrders()), [2])
const answered = adapter.readTurnEntries(fixture({ order: 4, thought: true, expanded: true, answer: 'The actual answer remains intact' }))
assert.equal(answered[0].message.content, 'The actual answer remains intact')
assert.equal(answered[0].message.sentAt, undefined, 'Thought duration is not message time')
const attachmentOnly = adapter.readTurnEntries(fixture({ order: 6, attachment: true }))
assert.equal(attachmentOnly[0].message.content, '')
assert.deepEqual(Array.from(attachmentOnly[0].message.attachmentNames), ['synthetic.png'])
for (const [order, flags] of [[8, { offscreen: true }], [10, { busy: true }], [12, { thought: 'pending' }], [14, {}]]) {
  const turn = fixture({ order, ...flags })
  adapter.readTurnEntries(turn)
  clock += 1000
  adapter.readTurnEntries(turn)
  assert.ok(!adapter.getVerifiedEmptySourceOrders().includes(order), 'Offscreen, busy, thinking and unmarked empty turns cannot prove a gap')
}
const blank = fixture({ order: 16, empty: true })
adapter.readTurnEntries(blank)
clock += 1000
adapter.readTurnEntries(blank)
assert.ok(adapter.getVerifiedEmptySourceOrders().includes(16))

// Settings normalization upgrades old records without changing independent
// permission, color or platform choices. Merely selecting share opens no tab.
const models = load('src/shared/models.ts')
let storedSettings = { key: 'app', autoSavePolicyVersion: 1, autoSave: false, autoSavePlatforms: ['gemini'], autoSavePinnedOnly: false, saveImages: false, fileSavePolicy: 'never', attachmentMaxSizeMb: 4, overlayPanelWidth: 480, visibleEnvironmentIds: [], accountTagColors: {}, environmentCardColors: {} }
const settingsModule = load('src/db/settings.ts', {
  '../shared/models': models,
  '../shared/environments': { isEnvironmentId: () => false },
  '../shared/display-colors': { normalizeDisplayColorAssignments: (value) => value ?? {}, hasCanonicalDisplayColorAssignments: (value, normalized) => JSON.stringify(value) === JSON.stringify(normalized) },
  './database': { STORE_NAME: { SETTINGS: 'settings' }, openDatabase: async () => ({ close() {}, transaction: () => ({ objectStore: () => ({ get: () => ({ result: structuredClone(storedSettings) }), put: (value) => { storedSettings = structuredClone(value); return { result: 'app' } } }) }) }), requestToPromise: async (request) => request.result, transactionToPromise: async () => undefined },
})
assert.equal((await settingsModule.getSettings()).chatgptCaptureMode, 'conversation')
await settingsModule.updateSettings({ chatgptCaptureMode: 'share' })
assert.equal(storedSettings.chatgptCaptureMode, 'share')
assert.equal(storedSettings.autoSave, false)
assert.equal(storedSettings.fileSavePolicy, 'never')
assert.equal(storedSettings.saveImages, false)
assert.deepEqual(storedSettings.autoSavePlatforms, ['gemini'])

// Persist through the real conversation service: supplementation preserves
// title, importance, permissions, times, newer text, and existing binaries.
const attachmentHelpers = load('src/shared/attachments.ts', { './models': models }, { atob })
const labels = load('src/shared/account-labels.ts')
const hash = async (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
let storedConversation = { id: 'local-id', platform: 'chatgpt', accountId: 'canonical-chatgpt', conversationId: 'conversation-a', title: 'Original local title', url: 'https://chatgpt.com/c/conversation-a', messages: local, attachments: [{ id: 'image-id', kind: 'image', name: 'kept.png', mimeType: 'image/png', status: 'saved', size: 1, dataUrl: 'data:image/png;base64,YQ==', sourceTurnId: 'turn-8', messageIndex: 2 }], pinned: true, important: true, imageAttachmentPermission: false, fileAttachmentPermission: true, createdAt: 1, updatedAt: 2, messageCount: local.length, contentHash: 'old' }
const conversationService = load('src/services/conversation-service.ts', {
  '../shared/share-capture': share,
  '../db/conversations': { getConversation: async () => structuredClone(storedConversation), putConversation: async (value) => { storedConversation = structuredClone(value); return value } },
  '../db/conversation-exclusions': { putConversationWithExclusionPolicy: async (value) => { storedConversation = structuredClone(value); return value } },
  '../shared/attachments': attachmentHelpers,
  '../shared/account-labels': labels,
  '../utils/hash': { createConversationId: async () => 'local-id', createContentHash: hash },
  '../shared/conversation-reconciliation': reconciliation,
  './account-service': { ensureConversationAccount: async () => undefined },
  './chatgpt-account-migration': { CHATGPT_ACCOUNT_ID: 'canonical-chatgpt' },
  './errors': { NotFoundError: class extends Error {} },
})
const persisted = await conversationService.saveConversation({ platform: 'chatgpt', accountId: 'canonical-chatgpt', accountLabel: 'Original account', accountSource: 'detected', conversationId: 'conversation-a', title: 'Public title must not replace local title', url: 'https://chatgpt.com/c/conversation-a', pinned: false, messages: oldSnapshot, captureSnapshotComplete: true, supplementOnly: true, contentHash: 'a'.repeat(64) }, 'manual')
assert.equal(persisted.conversation.title, 'Original local title')
assert.equal(persisted.conversation.pinned, true)
assert.equal(persisted.conversation.important, true)
assert.equal(persisted.conversation.imageAttachmentPermission, false)
assert.equal(persisted.conversation.fileAttachmentPermission, true)
assert.equal(persisted.conversation.createdAt, 1)
assert.equal(persisted.conversation.messages[7].content, 'Newer edited local text')
assert.equal(persisted.conversation.attachments[0].dataUrl, 'data:image/png;base64,YQ==')
assert.equal(persisted.conversation.attachments[0].messageIndex, 7)

// Restart, cancellation, wrong-tab/source and completion checks run against
// the production coordinator with local deterministic browser/DB substitutes.
function coordinator(records = new Map(), verifiedTab = false) {
  const removed = []
  const opened = []
  let nextTab = 100
  let currentUrl = 'https://chatgpt.com/c/conversation-a'
  const notifications = []
  const chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` }, tabs: {
    create: async (options) => { opened.push(options); return { id: ++nextTab } },
    update: async () => ({}), remove: async (id) => { removed.push(id) }, sendMessage: async (_id, message, options) => {
      if (message.type === share.SHARE_SOURCE_CONTEXT_REQUEST) {
        assert.equal(options.documentId, 'source-doc')
        return { platform: 'chatgpt', conversationId: share.getChatGPTSourceId(currentUrl), url: currentUrl, contentScriptBuildId: 'test-build' }
      }
      if (message.type === share.SHARE_TASK_STATUS_EVENT) notifications.push(structuredClone(message.status))
      return verifiedTab ? { jobId: message.jobId } : {}
    },
  } }
  const api = load('src/background/share-capture-coordinator.ts', {
    '../db/share-capture-jobs': { readShareCaptureJobs: async () => structuredClone([...records.values()]), putShareCaptureJob: async (status) => records.set(status.originTabId, structuredClone(status)), deleteShareCaptureJob: async (originTabId) => records.delete(originTabId) },
    '../services/conversation-service': { getSavedConversationBySource: async () => null },
    '../services/validation': { isChatMessage: (m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' },
    '../shared/share-capture': share,
    '../shared/build-id': { EXTENSION_BUILD_ID: 'test-build' },
  }, { chrome })
  return { api, records, removed, opened, notifications, navigateSource(url) { currentUrl = url } }
}
const sender = { tab: { id: 1 }, frameId: 0, documentId: 'source-doc', url: 'https://chatgpt.com/c/conversation-a' }
const panelSender = { ...sender, frameId: 4, documentId: 'panel-doc', url: 'chrome-extension://test/panel.html?view=current' }
const start = { type: 'SHARE_CAPTURE', action: 'start', conversationId: 'conversation-a', shareUrl: sampleUrl, sourceMessages: messages.slice(4, 8) }
const harness = coordinator()
const initial = await harness.api.handleShareCapture(start, sender)
const jobId = initial.status.id
assert.equal(harness.opened[0].active, false, 'Starting a background task must not steal focus')
await assert.rejects(() => harness.api.handleShareCapture(start, sender), /已有/)
const captureSender = { tab: { id: initial.status.captureTabId }, frameId: 0, documentId: 'capture-doc', url: sampleUrl }
await assert.rejects(() => harness.api.handleShareCapture({ action: 'claim' }, { ...captureSender, tab: { id: 999 } }), /授权/)
await harness.api.handleShareCapture({ action: 'claim' }, captureSender)
await assert.rejects(() => harness.api.handleShareCapture({ action: 'finish', jobId, capture }, { ...captureSender, url: otherUrl }), /授权/)
await harness.api.handleShareCapture({ action: 'finish', jobId, capture }, captureSender)
assert.equal(await harness.api.isShareSaveAuthorized(sender, 'conversation-a'), true)
assert.equal(await harness.api.isShareSaveAuthorized({ ...sender, documentId: 'different-document' }, 'conversation-a'), false)
assert.equal(harness.notifications.at(-1).phase, 'ready', 'The capture page learns that scrolling has finished and saving has begun')
assert.equal((await harness.api.handleShareCapture({ action: 'status', conversationId: 'conversation-a' }, panelSender)).capture, undefined, 'The overlay receives progress, not the full public transcript')
assert.equal((await harness.api.handleShareCapture({ action: 'status', conversationId: 'conversation-a' }, sender)).capture.messages.length, 20)
await harness.api.handleShareCapture({ action: 'release', jobId, conversationId: 'conversation-a' }, sender)
assert.equal(harness.records.get(1).phase, 'complete')
assert.equal(harness.removed.length, 1)
assert.equal(await harness.api.isShareSaveAuthorized(sender, 'conversation-a'), false)
assert.doesNotMatch(JSON.stringify([...harness.records.values()]), /Synthetic|chatgpt\.com\/share/, 'Durable job metadata must contain neither message bodies nor public links')

const interrupted = coordinator()
const pending = await interrupted.api.handleShareCapture(start, sender)
const restarted = coordinator(interrupted.records)
await restarted.api.initializeShareCaptureJobs()
assert.equal(restarted.records.get(1).phase, 'failed')
assert.equal(restarted.removed.length, 0, 'A reused tab ID after restart must never close an unrelated tab')
assert.equal(await restarted.api.isShareSaveAuthorized(sender, 'conversation-a'), false)
const cancelled = coordinator()
const cancellable = await cancelled.api.handleShareCapture(start, sender)
await cancelled.api.handleShareTabNavigated(1, 'https://chatgpt.com/c/different')
assert.equal(cancelled.records.get(1).phase, 'cancelled')
assert.deepEqual(cancelled.removed, [cancellable.status.captureTabId ?? 101])
assert.equal(pending.status.phase, 'loading')

for (const invalid of [{ ...capture, captureComplete: false }, { ...capture, messages: messages.filter((m) => m.sourceOrder !== 10) }, { ...capture, conversationId: 'wrong-share' }, { ...capture, messages: messages.map((m) => ({ ...m, content: 'Unrelated complete conversation' })) }]) {
  const task = coordinator()
  const { status } = await task.api.handleShareCapture(start, sender)
  const taskSender = { ...captureSender, tab: { id: status.captureTabId } }
  await task.api.handleShareCapture({ action: 'claim' }, taskSender)
  await task.api.handleShareCapture({ action: 'finish', jobId: status.id, capture: invalid }, taskSender)
  assert.equal(task.records.get(1).phase, 'failed')
  assert.equal(await task.api.isShareSaveAuthorized(sender, 'conversation-a'), false)
}
const deleted = coordinator()
const pairedThought = coordinator()
const pairedJob = await pairedThought.api.handleShareCapture(start, sender)
const pairedSender = { ...captureSender, tab: { id: pairedJob.status.captureTabId } }
await pairedThought.api.handleShareCapture({ action: 'claim' }, pairedSender)
const pairedCapture = { ...capture,
  messages: messages.slice(0, 16).filter((message) => message.sourceOrder !== 2).map((message) => ({ ...message, sourceOrder: message.sourceOrder - 1 })),
  captureSkippedSourceOrders: [1],
}
await pairedThought.api.handleShareCapture({ action: 'finish', jobId: pairedJob.status.id, capture: pairedCapture }, pairedSender)
assert.equal(pairedThought.records.get(1).phase, 'ready', 'The worker must accept 15 messages covering 16 paired slots with one independently verified thought-only slot')
assert.equal(pairedThought.records.get(1).messageCount, 15)
assert.equal(await pairedThought.api.isShareSaveAuthorized(sender, 'conversation-a'), true)
const deletionJob = await deleted.api.handleShareCapture(start, sender)
const deletionSender = { ...captureSender, tab: { id: deletionJob.status.captureTabId } }
await deleted.api.handleShareCapture({ action: 'claim' }, deletionSender)
await deleted.api.handleShareCapture({ action: 'finish', jobId: deletionJob.status.id, capture }, deletionSender)
await deleted.api.cancelShareCaptureJobs('conversation-a')
assert.equal(await deleted.api.isShareSaveAuthorized(sender, 'conversation-a'), false, 'Deletion revokes even a ready scan before it can restore local data')
assert.equal(deleted.records.size, 0, 'Deleting local data must also remove its transient task identifiers')

// Regressions: initial SPA sender URL and queued about:blank updates must not
// reject a valid link or immediately cancel a just-created background tab.
const spa = coordinator()
const staleSender = { ...sender, url: 'https://chatgpt.com/' }
const spaJob = await spa.api.handleShareCapture(start, staleSender)
const spaTabId = spaJob.status.captureTabId
await spa.api.handleShareTabNavigated(spaTabId, 'about:blank')
assert.equal(spa.records.get(1).phase, 'loading')
await spa.api.handleShareTabNavigated(spaTabId, sampleUrl)
const spaCaptureSender = { ...captureSender, tab: { id: spaTabId } }
await spa.api.handleShareCapture({ action: 'claim' }, spaCaptureSender)
await spa.api.handleShareCapture({ action: 'progress', jobId: spaJob.status.id, phase: 'scanning', messageCount: 10, progress: 45 }, spaCaptureSender)
await spa.api.handleShareCapture({ action: 'progress', jobId: spaJob.status.id, phase: 'needs-foreground', messageCount: 2, progress: 12 }, spaCaptureSender)
assert.equal(spa.records.get(1).messageCount, 10, 'Foreground retries must not reset progress')
assert.equal(spa.records.get(1).progress, 45, 'Foreground retries must not shrink the progress bar')
assert.equal(spa.records.get(1).phase, 'needs-foreground', 'A rendering pause remains an active job')
assert.equal(spa.removed.length, 0, 'A rendering pause must keep the same capture tab open')
await spa.api.handleShareCapture({ action: 'progress', jobId: spaJob.status.id, phase: 'scanning', messageCount: 12, progress: 65 }, spaCaptureSender)
assert.equal(spa.records.get(1).phase, 'scanning', 'Progress resumes without starting another job')
await spa.api.handleShareCapture({ action: 'finish', jobId: spaJob.status.id, capture }, spaCaptureSender)
assert.equal(await spa.api.isShareSaveAuthorized(staleSender, 'conversation-a'), true)
assert.equal((await spa.api.handleShareCapture({ action: 'status', jobId: spaJob.status.id }, spaCaptureSender)).capture, undefined)
await spa.api.handleShareCapture({ action: 'release', conversationId: 'conversation-a', jobId: spaJob.status.id, error: 'Synthetic storage error' }, staleSender)
assert.equal(spa.records.get(1).phase, 'failed')
assert.match(spa.records.get(1).message, /Synthetic storage error/)
assert.equal(spa.notifications.at(-1).phase, 'failed')
const leftShare = coordinator()
const leftJob = await leftShare.api.handleShareCapture(start, sender)
const leftTabId = leftJob.status.captureTabId
await leftShare.api.handleShareTabNavigated(leftTabId, sampleUrl)
await leftShare.api.handleShareTabNavigated(leftTabId, 'about:blank')
assert.equal(leftShare.records.get(1).phase, 'cancelled', 'Navigating away after the share loads must still revoke the job')
const wrongSource = coordinator()
wrongSource.navigateSource('https://chatgpt.com/c/different')
await assert.rejects(() => wrongSource.api.handleShareCapture(start, sender), /原对话身份核对失败/)
await assert.rejects(() => wrongSource.api.handleShareCapture({ ...start, shareUrl: otherUrl + '/wrong' }, sender), /链接格式/)
await assert.rejects(() => wrongSource.api.handleShareCapture(start, panelSender), /原对话身份/)

// Exercise the production observer's save queue, coordinator and persistence
// service together: a completed scroll must create a readable source record,
// and a storage error must survive into the durable task result.
async function saveScannedShare(storageFailure = false, filePolicy = null) {
  storedConversation = null
  const task = coordinator()
  const source = { ...capture, conversationId: 'conversation-a', url: sender.url, title: 'Synthetic original title', messages: messages.slice(4, 8),
    ...(filePolicy ? { attachmentCandidates: [originatingFile, { ...originatingFile, name: 'metadata-only.txt', sourceUrl: null, messageIndex: 2, sourceTurnId: messages[6].sourceTurnId }] } : {}),
  }
  const sourceAdapter = {
    platform: 'chatgpt', getConversationId: () => source.conversationId,
    extractConversation: () => source, getMessages: () => source.messages,
    getTitle: () => source.title, getAccountIdentifier: () => filePolicy ? 'Fixture Account' : null, getAccountLabel: () => filePolicy ? 'Fixture Account' : 'Unknown',
  }
  const runtimeTypes = load('src/shared/runtime-messages.ts')
  const requests = []
  const fileReads = []
  class FixtureFileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
        this.onload?.()
      }).catch((error) => { this.error = error; this.onerror?.() })
    }
  }
  const attachmentCapture = load('src/content/attachment-capture.ts', {
    '../shared/attachments': attachmentHelpers,
    '../shared/runtime-client': { sendRuntimeRequest: () => { throw new Error('No remote attachment request is authorized by this fixture') } },
    '../shared/runtime-messages': runtimeTypes,
    '../shared/remote-images': load('src/shared/remote-images.ts'),
    '../utils/hash': { sha256Hex: async (value) => createHash('sha256').update(value).digest('hex') },
    './embedded-image-reader': {},
  }, { Blob, FileReader: FixtureFileReader, atob, fetch: async (url) => {
    assert.equal(filePolicy, 'per-conversation', 'Disabled ordinary files must never be read')
    assert.equal(url, originatingFile.sourceUrl)
    fileReads.push(url)
    return fetch(url)
  } })
  const observerModule = load('src/content/conversation-observer.ts', {
    '../adapters/adapter-factory': { createAdapter: () => sourceAdapter },
    '../shared/conversation-reconciliation': reconciliation,
    '../shared/share-capture': share,
    '../shared/runtime-messages': runtimeTypes,
    '../shared/build-id': { EXTENSION_BUILD_ID: 'test-build' },
    '../utils/hash': { createAccountId: async () => 'canonical-chatgpt', createContentHash: hash },
    '../utils/logger': { Logger: { warn() {}, error() {} } },
    './attachment-capture': attachmentCapture, './auto-save-policy': {},
    '../shared/runtime-client': { sendRuntimeRequest: async (request) => {
      requests.push(request)
      if (request.type === 'GET_SETTINGS') return { ...models.DEFAULT_SETTINGS, saveImages: false, fileSavePolicy: filePolicy ?? 'never' }
      if (request.type === 'UPDATE_CONVERSATION_FILE_PERMISSION') return conversationService.updateConversationFileAttachmentPermission(request.id, request.allowed)
      if (request.type === 'GET_SAVED_CONVERSATION') return structuredClone(storedConversation)
      if (request.type === 'SHARE_CAPTURE') {
        const response = await task.api.handleShareCapture(request, staleSender)
        if (request.action === 'start') {
          const ownedSender = { ...captureSender, tab: { id: response.status.captureTabId } }
          await task.api.handleShareTabNavigated(ownedSender.tab.id, 'about:blank')
          await task.api.handleShareCapture({ action: 'claim' }, ownedSender)
          await task.api.handleShareCapture({ action: 'finish', jobId: response.status.id,
            capture: { ...capture, messages: scanned.messages, captureComplete: scanned.captureComplete },
          }, ownedSender)
        }
        return response
      }
      if (request.type === 'SAVE_CONVERSATION') {
        assert.equal(await task.api.isShareSaveAuthorized(staleSender, request.conversation.conversationId), true)
        assert.equal(request.saveMode, 'manual')
        assert.equal(request.conversation.supplementOnly, true)
        if (storageFailure) throw new Error('Synthetic IndexedDB write failure')
        return (await conversationService.saveConversation(request.conversation, request.saveMode)).conversation
      }
      throw new Error(`Unexpected runtime request: ${request.type}`)
    } },
  }, { AbortController, Error, location: { href: sender.url }, window: {}, document: {} })
  const observer = new observerModule.ConversationObserver()
  observer.ensureCaptureRuntimeReady = async () => true
  observer.hasCurrentPinnedEvidence = () => false
  observer.captureRenderedWindow = () => undefined
  observer.scheduleExtraction = () => undefined
  const result = await observer.saveWithShare('conversation-a', filePolicy !== null, undefined, sampleUrl)
  return { result, task, requests, observer, fileReads }
}
const savedScan = await saveScannedShare()
assert.equal(savedScan.result.ok, true)
assert.equal(storedConversation.messageCount, 20, 'A completed scroll must persist every collected message')
assert.equal(storedConversation.conversationId, 'conversation-a', 'The library record belongs to the original conversation')
assert.equal(storedConversation.url, sender.url)
assert.equal(storedConversation.title, 'Synthetic original title')
assert.equal(savedScan.task.records.get(1).phase, 'complete')
assert.equal(savedScan.observer.completeCaptureInProgress, false)
assert.ok(savedScan.requests.some((request) => request.type === 'GET_SAVED_CONVERSATION'), 'Success requires rereading the persisted local copy')
const failedSave = await saveScannedShare(true)
assert.equal(failedSave.result.ok, false)
assert.match(failedSave.result.message, /IndexedDB write failure/)
assert.equal(storedConversation, null)
assert.equal(failedSave.task.records.get(1).phase, 'failed')
assert.match(failedSave.task.records.get(1).message, /IndexedDB write failure/, 'Reopening the panel must retain the original storage failure')
const fileSave = await saveScannedShare(false, 'per-conversation')
assert.equal(fileSave.result.ok, true, fileSave.result.message)
assert.equal(fileSave.fileReads.length, 1)
assert.equal(storedConversation.attachments.length, 2, 'Sharing retains original uploads even when the public transcript has no attachments')
assert.equal(storedConversation.attachments[0].status, 'saved')
assert.equal(storedConversation.attachments[0].dataUrl, originatingFile.sourceUrl)
assert.equal(storedConversation.attachments[0].messageIndex, 4)
assert.equal(storedConversation.attachments[1].status, 'unavailable', 'A preview-only card saves metadata without pretending bytes exist')
assert.equal(storedConversation.attachments[1].dataUrl, undefined)
assert.equal(storedConversation.attachments[1].messageIndex, 6)
assert.equal(storedConversation.fileAttachmentPermission, true)
assert.ok(fileSave.requests.filter((request) => request.type === 'SAVE_CONVERSATION').every((request) => request.conversation.accountLabel === 'Fixture Account' && request.conversation.accountSource === 'detected'), 'Refresh the originating account after scanning instead of persisting its earlier Unknown snapshot')
const disabledFiles = await saveScannedShare(false, 'never')
assert.equal(disabledFiles.result.ok, true)
assert.equal(disabledFiles.fileReads.length, 0)
assert.ok(storedConversation.attachments.every((file) => file.status === 'not-saved' && file.dataUrl === undefined))

assert.doesNotMatch(source('src/adapters/chatgpt/chatgpt-adapter.ts'), /\.click\(/, 'Sharing must remain a manual native operation')
assert.doesNotMatch(source('src/panel/pages/SettingsPage.tsx'), /conversation-and-share/, 'Only the two approved modes may be offered')
console.log('share capture verification passed: background scan/repeated pauses, monotonic progress, strict virtualized scan, conservative merge, source binding, cancellation and worker restart')
