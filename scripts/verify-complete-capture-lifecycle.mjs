import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const readSource = (path) => readFileSync(new URL(path, root), 'utf8')
const compile = (source, module) => ts.transpileModule(source, {
  compilerOptions: { module, target: ts.ScriptTarget.ES2023 },
}).outputText
const reconciliation = await import(`data:text/javascript;base64,${Buffer.from(
  compile(readSource('src/shared/conversation-reconciliation.ts'), ts.ModuleKind.ESNext),
).toString('base64')}`)
const shareHelpers = await import(`data:text/javascript;base64,${Buffer.from(
  compile(readSource('src/shared/share-capture.ts'), ts.ModuleKind.ESNext),
).toString('base64')}`)
const observerJavaScript = compile(
  readSource('src/content/conversation-observer.ts'),
  ts.ModuleKind.CommonJS,
)

const messages = [
  { role: 'user', content: 'Test question', sourceTurnId: 'turn-1', sourceOrder: 0 },
  { role: 'assistant', content: 'Test answer', sourceTurnId: 'turn-2', sourceOrder: 1 },
]
const makeContainer = () => ({
  isConnected: true,
  addEventListener() {},
  removeEventListener() {},
})

function createHarness({ onShareStatus = () => undefined, extractionMissing = false, renderedMessages = messages, savedSourceMissing = false, onSavedRead = () => undefined } = {}) {
  let container = makeContainer()
  let conversationId = 'conversation-a'
  let resolveCollection
  const collection = new Promise((resolve) => { resolveCollection = resolve })
  let collectionCalls = 0
  const savedRequests = []
  const runtimeRequests = []
  const complete = {
    platform: 'chatgpt',
    conversationId,
    title: 'Test conversation',
    url: `https://chatgpt.com/c/${conversationId}`,
    accountIdentifier: null,
    accountLabel: 'Unknown',
    messages,
    captureComplete: true,
  }
  const saved = { ...complete, id: 'local-a', messageCount: messages.length, contentHash: 'verified-hash' }
  const adapter = {
    platform: 'chatgpt',
    getConversationId: () => conversationId,
    getConversationObservationContainer: () => container,
    isConversationPage: () => true,
    extractConversation: () => extractionMissing ? null : ({ ...complete, conversationId, captureComplete: undefined }),
    getMessages: () => renderedMessages,
    getTitle: () => complete.title,
    getAccountIdentifier: () => null,
    getAccountLabel: () => 'Unknown',
    collectConversation: () => { collectionCalls += 1; return collection },
  }
  const location = { href: complete.url }
  const timers = new Map()
  let timerId = 0
  const dependencies = {
    '../adapters/adapter-factory': { createAdapter: () => adapter },
    '../shared/conversation-reconciliation': reconciliation,
    '../shared/runtime-client': { sendRuntimeRequest: async (request) => {
      runtimeRequests.push(request)
      if (request.type === 'GET_SAVED_CONVERSATION') {
        onSavedRead(observer)
        if (savedSourceMissing && savedRequests.length === 0) return null
      }
      if (request.type !== 'SHARE_CAPTURE') return saved
      const status = { id: 'share-job', conversationId: 'conversation-a' }
      if (request.action === 'status') {
        onShareStatus(observer)
        return { status: { ...status, phase: 'ready' }, capture: { ...complete, conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', url: 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }
      }
      return { status: { ...status, phase: request.action === 'release' ? 'complete' : request.action === 'cancel' ? 'cancelled' : 'loading' } }
    } },
    '../shared/runtime-messages': { RUNTIME_MESSAGE_TYPE: { SHARE_CAPTURE: 'SHARE_CAPTURE', GET_SAVED_CONVERSATION: 'GET_SAVED_CONVERSATION' } },
    '../shared/build-id': { EXTENSION_BUILD_ID: 'test-build' },
    '../utils/hash': {},
    '../utils/logger': { Logger: { warn() {}, error() {} } },
    './attachment-capture': {},
    './auto-save-policy': {},
    '../shared/share-capture': shareHelpers,
  }
  const module = { exports: {} }
  runInNewContext(observerJavaScript, {
    exports: module.exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    location,
    AbortController,
    queueMicrotask,
    window: {
      addEventListener() {}, removeEventListener() {},
      setTimeout: (callback) => { timers.set(++timerId, callback); return timerId },
      clearTimeout: (id) => timers.delete(id),
      setInterval: (callback) => { timers.set(++timerId, callback); return timerId },
      clearInterval: (id) => timers.delete(id),
    },
    document: { addEventListener() {}, removeEventListener() {} },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  }, { filename: fileURLToPath(new URL('src/content/conversation-observer.ts', root)) })
  const observer = new module.exports.ConversationObserver()
  observer.currentUrl = location.href
  observer.observedContainer = container
  observer.ensureSidebarObservation = () => undefined
  observer.refreshPinnedState = () => undefined
  observer.refreshSavedConversationState = async () => undefined
  observer.hasCurrentPinnedEvidence = () => false
  observer.ensureCaptureRuntimeReady = async () => true
  // Isolate persistence while exercising the real manual-read and reconciliation path.
  observer.queueConversationSave = async (request) => {
    savedRequests.push(request)
    return saved
  }
  return {
    observer,
    complete,
    savedRequests,
    runtimeRequests,
    resolveCollection,
    get collectionCalls() { return collectionCalls },
    replaceContainer() {
      container.isConnected = false
      container = makeContainer()
      observer.checkNavigation()
      return container
    },
    navigate(id) {
      conversationId = id
      location.href = `https://chatgpt.com/c/${id}`
      observer.checkNavigation()
    },
  }
}

const remounted = createHarness()
const manualSave = remounted.observer.saveCurrentConversation('conversation-a')
// Let the runtime-readiness promise settle so collection is in progress.
await Promise.resolve()
const activeTask = remounted.observer.completeCaptureTask.promise
const generation = remounted.observer.generation
for (let index = 0; index < 2; index += 1) {
  const replacement = remounted.replaceContainer()
  assert.equal(remounted.observer.observedContainer, replacement)
  assert.equal(remounted.observer.generation, generation,
    'Remounting the same conversation must not invalidate its complete capture')
  assert.equal(remounted.observer.syncStatus, 'saving')
  assert.equal(remounted.observer.debounceTimer, null,
    'Rebinding observation must not enqueue a passive partial save during collection')
  remounted.observer.scheduleExtraction()
  assert.equal(remounted.observer.debounceTimer, null,
    'Title and sidebar changes must not enqueue partial saves during collection')
  assert.equal(remounted.observer.syncStatus, 'saving')
  assert.equal(remounted.observer.collectCompleteConversation('conversation-a'), activeTask,
    'Manual and pin callers must continue sharing the same collection after a remount')
}
assert.equal(remounted.collectionCalls, 1)
remounted.resolveCollection(remounted.complete)
const manualResult = await manualSave
assert.equal(manualResult.ok, true)
assert.equal(manualResult.verification, 'exact')
assert.equal(remounted.savedRequests.length, 1)
assert.equal(remounted.savedRequests[0].completeSnapshotVerified, true)
assert.equal(remounted.observer.completeCaptureInProgress, false)

const navigated = createHarness()
const staleSave = navigated.observer.saveCurrentConversation('conversation-a')
await Promise.resolve()
navigated.navigate('conversation-b')
navigated.resolveCollection(navigated.complete)
assert.equal((await staleSave).ok, false, 'A real navigation must cancel a manual save')
assert.equal(navigated.savedRequests.length, 0)

const returned = createHarness()
const oldCollection = returned.observer.collectCompleteConversation('conversation-a')
returned.navigate('conversation-b')
returned.navigate('conversation-a')
returned.resolveCollection(returned.complete)
assert.notEqual((await oldCollection).failure, null,
  'Navigating away and back must not resurrect a previous capture generation')
assert.equal(returned.savedRequests.length, 0)

for (const failure of ['gap', 'boundary']) {
  const partial = createHarness()
  const partialSave = partial.observer.saveCurrentConversation('conversation-a')
  await Promise.resolve()
  partial.replaceContainer()
  partial.resolveCollection({
    ...partial.complete, captureComplete: false, captureIncompleteReason: failure,
  })
  assert.equal((await partialSave).ok, false)
  assert.equal(partial.savedRequests.length, 0,
    'A remount must never bypass incomplete-history checks')
}

const passive = createHarness()
passive.replaceContainer()
assert.notEqual(passive.observer.debounceTimer, null,
  'Ordinary passive observation must resume on the replacement container')

const shareUrl = 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const share = createHarness()
assert.equal((await share.observer.saveWithShare('conversation-a', false, false, shareUrl)).ok, true)
assert.equal(share.savedRequests.length, 1)
assert.equal(share.savedRequests[0].extractedOverride.conversationId, 'conversation-a', 'The share UUID must never become the persisted source ID')
assert.equal(share.savedRequests[0].extractedOverride.url, 'https://chatgpt.com/c/conversation-a')
assert.equal(share.savedRequests[0].supplementOnly, true)
assert.equal(share.savedRequests[0].completeSnapshotVerified, true)
assert.equal(share.collectionCalls, 0, 'Share mode must not scroll the original page')
assert.equal(share.runtimeRequests.filter((request) => request.action === 'release').length, 1)
assert.equal(share.observer.completeCaptureInProgress, false)
assert.notEqual(share.observer.debounceTimer, null, 'Rendered edits made during share capture must resume passive updates afterward')

const abortedShare = createHarness({ onShareStatus: (observer) => observer.cancelShareCapture() })
assert.equal((await abortedShare.observer.saveWithShare('conversation-a', false, false, shareUrl)).ok, false)
assert.equal(abortedShare.savedRequests.length, 0)
assert.equal(abortedShare.runtimeRequests.filter((request) => request.action === 'cancel').length, 1)
assert.equal(abortedShare.observer.shareAbort, null)
assert.equal(abortedShare.observer.completeCaptureInProgress, false)

const badLink = createHarness()
assert.equal((await badLink.observer.saveWithShare('conversation-a', false, false, 'https://unrelated.example/share/x')).ok, false)
assert.equal(badLink.savedRequests.length, 0)
assert.equal(badLink.runtimeRequests.filter((request) => request.type === 'SHARE_CAPTURE').length, 0)

const cachedShare = createHarness({ extractionMissing: true, renderedMessages: [] })
assert.equal((await cachedShare.observer.saveWithShare('conversation-a', false, false, shareUrl)).ok, true,
  'An empty current DOM must not block share capture when the source has a saved copy')
assert.deepEqual(cachedShare.runtimeRequests.find((request) => request.action === 'start').sourceMessages, messages)
assert.equal(cachedShare.collectionCalls, 0)
assert.equal(cachedShare.savedRequests[0].extractedOverride.conversationId, 'conversation-a')

const textOnlyShare = createHarness({ extractionMissing: true, savedSourceMissing: true })
assert.equal((await textOnlyShare.observer.saveWithShare('conversation-a', false, false, shareUrl)).ok, true)
assert.deepEqual(textOnlyShare.runtimeRequests.find((request) => request.action === 'start').sourceMessages, messages,
  'Message-only DOM extraction is sufficient even if attachment extraction returned no snapshot')
assert.equal(textOnlyShare.savedRequests.length, 1)

const observedShare = createHarness({ extractionMissing: true, renderedMessages: [], savedSourceMissing: true })
observedShare.observer.accumulateExtractedConversation(observedShare.complete)
assert.equal((await observedShare.observer.saveWithShare('conversation-a', false, false, shareUrl)).ok, true)
assert.deepEqual(observedShare.runtimeRequests.find((request) => request.action === 'start').sourceMessages, messages,
  'A previously rendered page-local window remains valid source evidence')

const noSource = createHarness({ extractionMissing: true, renderedMessages: [], savedSourceMissing: true })
assert.match((await noSource.observer.saveWithShare('conversation-a', false, false, shareUrl)).message, /均无可核对消息/)
assert.equal(noSource.runtimeRequests.filter((request) => request.type === 'SHARE_CAPTURE').length, 0)
assert.equal(noSource.savedRequests.length, 0, 'A link alone must not authorize writing to an unverified original conversation')

const cancelledLocalRead = createHarness({ extractionMissing: true, renderedMessages: [], onSavedRead: (observer) => observer.cancelShareCapture() })
assert.equal((await cancelledLocalRead.observer.saveWithShare('conversation-a', false, false, shareUrl)).ok, false)
assert.equal(cancelledLocalRead.runtimeRequests.filter((request) => request.type === 'SHARE_CAPTURE').length, 0,
  'Cancelling during the saved-source read must prevent creating a capture tab')

console.log('complete capture lifecycle verification passed')
