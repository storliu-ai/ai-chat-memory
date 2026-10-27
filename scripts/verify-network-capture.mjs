import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { parseHTML } from 'linkedom'
import ts from 'typescript'

function load(path, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
  const exports = {}
  runInNewContext(code, { exports, URL, TextEncoder, TextDecoder, atob, crypto: webcrypto, ...globals, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`)
    return dependencies[name]
  } }, { filename: path })
  return exports
}
const shared = load('src/shared/network-capture.ts')
const share = load('src/shared/share-capture.ts')
const parser = load('src/adapters/chatgpt/network-response.ts')
const evidence = load('src/adapters/chatgpt/network-evidence.ts')
const scroll = load('src/adapters/dom-scroll-collector.ts', {
  '../shared/conversation-reconciliation': load('src/shared/conversation-reconciliation.ts'),
  '../shared/capture-continuity': load('src/shared/capture-continuity.ts'),
})
const sourceUrl = 'https://chatgpt.com/c/synthetic-source'
const shareUrl = 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const target = { mode: 'conversation', id: 'synthetic-source' }
for (const path of ['conversation', 'conversations']) {
  assert.equal(parser.matchChatGPTCaptureEndpoint(`https://chatgpt.com/backend-api/${path}/synthetic-source`, target), 'initial')
  assert.equal(parser.matchChatGPTCaptureEndpoint(`https://chatgpt.com/backend-api/${path}/synthetic-source/messages?before=synthetic-cursor`, target), 'messages')
}
for (const url of [
  'https://chatgpt.com/backend-api/conversations', 'https://chatgpt.com/backend-api/me',
  'https://chatgpt.com/backend-api/conversations/another', 'https://chatgpt.com/backend-api/conversations/synthetic-source/files',
  'https://chatgpt.com.evil.test/backend-api/conversations/synthetic-source', 'http://chatgpt.com/backend-api/conversations/synthetic-source',
  'https://user:pass@chatgpt.com/backend-api/conversations/synthetic-source', 'https://chatgpt.com:444/backend-api/conversations/synthetic-source',
]) assert.equal(parser.matchChatGPTCaptureEndpoint(url, target), null)
assert.equal(parser.matchChatGPTCaptureEndpoint('https://chatgpt.com/backend-api/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { mode: 'share', id: shareUrl.split('/').at(-1) }), 'share')
assert.throws(() => parser.inspectChatGPTResponseShape('{"private-fragment"', 'initial'), (error) => !error.message.includes('private-fragment'))
assert.throws(() => parser.inspectChatGPTResponseShape('{"data":{"messages":[]}}', 'initial'), /响应结构/)
assert.equal(parser.inspectChatGPTResponseShape('{"messages":[],"page_info":{}}', 'initial').schema, 'messages')

// Exercise production DOM safety detection without relying on focus or animation.
function safety(html) {
  const { window } = parseHTML(`<html><body>${html}</body></html>`)
  window.Element.prototype.getClientRects = function () { return this.hasAttribute('data-zero-size') ? [] : [{}] }
  const adapter = load('src/adapters/chatgpt/capture-page-state.ts', {}, {
    document: window.document, Element: window.Element, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  })
  return { ...adapter, document: window.document }
}
const emptyComposer = '<form><div id="prompt-textarea" contenteditable="true"><p><br></p></div></form>'
assert.equal(safety(emptyComposer).getChatGPTCaptureBlockers().length, 0)
assert.equal(safety('<form><div role="textbox" contenteditable="true"><p><br></p></div></form>').getChatGPTCaptureBlockers().length, 0, 'Current native composer has no prompt-textarea ID')
assert.ok(safety('<form><div id="prompt-textarea" contenteditable="true">draft</div></form>').getChatGPTCaptureBlockers().includes('draft'))
assert.ok(safety('<form><textarea id="prompt-textarea">draft</textarea></form>').getChatGPTCaptureBlockers().includes('draft'))
assert.ok(safety(`${emptyComposer}<button data-testid="stop-button">stop</button>`).getChatGPTCaptureBlockers().includes('generating'))
assert.ok(safety(`${emptyComposer}<section data-testid="conversation-turn-2"><textarea>edit</textarea></section>`).getChatGPTCaptureBlockers().includes('editing'))
assert.ok(safety('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="attachment-card">image</div></form>').getChatGPTCaptureBlockers().includes('attachment'))
assert.ok(safety('<form><div id="prompt-textarea" contenteditable="true"></div><div role="progressbar"></div></form>').getChatGPTCaptureBlockers().includes('attachment'))
assert.ok(safety('<div id="prompt-textarea" contenteditable="true"></div>').getChatGPTCaptureBlockers().includes('unknown'))
assert.ok(safety('<main>Loading</main>').getChatGPTCaptureBlockers().includes('unknown'))
assert.ok(safety(emptyComposer).getChatGPTCaptureBlockers(true).includes('busy'))
assert.equal(safety(`${emptyComposer}<div hidden><div id="prompt-textarea">old draft</div></div>`).getChatGPTCaptureBlockers().length, 0)
const selected = safety('<form><div id="prompt-textarea" contenteditable="true"></div><input type="file"></form>')
Object.defineProperty(selected.document.querySelector('input'), 'files', { value: [{ name: 'synthetic.png' }] })
assert.ok(selected.getChatGPTCaptureBlockers().includes('attachment'))
assert.ok(selected.isChatGPTConversationSubmission(selected.document.querySelector('form')))
const unrelatedForm = safety('<form><input name="search"></form>')
assert.equal(unrelatedForm.isChatGPTConversationSubmission(unrelatedForm.document.querySelector('form')), false)

function bus() {
  const listeners = new Set()
  return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => { for (const listener of [...listeners]) listener(...args) }, get size() { return listeners.size } }
}
const tick = async () => { for (let count = 0; count < 60; count++) await Promise.resolve() }

// Exercise the actual isolated-world refresh callback. The last safety check
// and reload must happen in one synchronous handler, after the worker's checks.
function contentHarness({ driving = false, missingForever = false } = {}) {
  const messages = bus(), events = new Map(), sent = [], pauseChanges = []
  let blockers = [], reloads = 0
  let scans = 0, attachmentCandidates = []
  let complete
  const completed = new Promise(resolve => { complete = resolve })
  const nativeMessages = ['u1', 'a1', 'u2', 'a2'].map((id, index) => ({role:index % 2 ? 'assistant' : 'user',content:`Synthetic visible ${id}`,sourceMessageId:id,sourceTurnId:id}))
  const snapshot = (early = false) => ({platform:'chatgpt',conversationId:'synthetic-source',url:sourceUrl,title:'Synthetic',accountLabel:'Unknown',messages:early?nativeMessages:nativeMessages.slice(2),captureComplete:true,attachmentCandidates:[{name:early?'earlier.png':'later.png',kind:'image',sourceUrl:null,messageIndex:1,sourceTurnId:early?'a1':'a2'}]})
  const active = {id:'content-job',conversationId:'synthetic-source',originTabId:1,captureTabId:null,operation:'save',mode:'conversation',method:'network',phase:'reading'}
  const pageLocation = { hostname: 'chatgpt.com', pathname: '/c/synthetic-source', href: sourceUrl, reload: () => { reloads += 1 } }
  const api = load('src/content/network-capture.ts', {
    '../adapters/chatgpt/chatgpt-adapter': { ChatGPTAdapter: class {
      getConversationId() { return 'synthetic-source' }
      getMessages() { return nativeMessages.slice(2) }
      async collectConversation() { scans += 1; return snapshot(scans > 1) }
    } },
    '../adapters/dom-scroll-collector': scroll,
    '../adapters/chatgpt/chatgpt-share-adapter': { ChatGPTShareAdapter: class {} },
    './attachment-capture': { captureAttachments: async candidates => { assert.ok(driving); attachmentCandidates = candidates; return [] } },
    '../adapters/chatgpt/capture-page-state': { getChatGPTCaptureBlockers: () => blockers, isChatGPTBranchAction: (target) => target === 'branch', isChatGPTConversationSubmission: (target) => target === 'composer' },
    '../shared/build-id': { EXTENSION_BUILD_ID: 'test-build' }, '../shared/network-capture': shared,
    '../shared/runtime-messages': { RUNTIME_MESSAGE_TYPE: { NETWORK_CAPTURE: 'NETWORK_CAPTURE' } },
    '../shared/runtime-client': { sendRuntimeRequest: async (request) => {
      sent.push(request)
      if (driving) {
        if(request.action==='error') { complete();return{status:{...active,phase:'failed'},paused:false} }
        if(request.action==='commit')return {status:{...active,phase:'attachments'},paused:true,attachmentPlan:request.capture.messages.map((message,index)=>({localIndex:index,networkIndex:index,sourceMessageId:message.sourceMessageId,sourceTurnId:message.sourceTurnId})),attachmentPolicy:{saveImages:true,allowFiles:false,maximumBytes:1000,skippedFileStatus:'not-saved'}}
        if(request.action==='attachments') {complete();return{status:{...active,phase:'complete'},paused:false}}
        return {status:active,paused:true,drive:true,networkComplete:!missingForever&&scans>=2}
      }
      return { status: null, paused: false }
    } },
  }, {
    chrome: { runtime: { id: 'test', onMessage: messages } }, location: pageLocation,
    window: { setTimeout:(callback)=>queueMicrotask(callback), setInterval: () => 1, clearInterval() {}, addEventListener: (type, callback) => events.set(type, callback) },
    document: { hidden:false, addEventListener: (type, callback) => events.set(type, callback), removeEventListener: (type) => events.delete(type) },
  })
  const message = (request) => {
    let response
    messages.emit(request, { id: 'test' }, (value) => { response = value })
    return response
  }
  return { api, message, events, sent, pauseChanges, completed, get scans(){return scans},get attachmentCandidates(){return attachmentCandidates}, setBlockers: (value) => { blockers = value }, get reloads() { return reloads } }
}
const content = contentHarness()
const page = await content.api.initializeNetworkCapturePage()
page.bindObserver({ setNetworkCapturePaused: (value) => content.pauseChanges.push(value), hasActiveCompleteCapture: () => false })
const bound = content.message({ type: shared.NETWORK_PAGE_PROBE, jobId: 'content-job' })
const refreshRequest = { type: shared.NETWORK_PAGE_REFRESH, jobId: 'content-job', documentToken: bound.documentToken, conversationId: bound.conversationId, branchRevision: bound.branchRevision }
for (const blocker of ['draft', 'attachment', 'editing', 'generating', 'unknown', 'busy']) {
  content.setBlockers([blocker])
  assert.equal(content.message(refreshRequest).accepted, false, `The final synchronous callback must block ${blocker}`)
}
assert.equal(content.reloads, 0)
content.setBlockers([])
assert.equal(content.message({ ...refreshRequest, documentToken: 'stale' }).accepted, false)
assert.equal(content.message({ ...refreshRequest, conversationId: 'another' }).accepted, false)
content.events.get('submit')({ type: 'submit', isTrusted: false, target: 'composer' })
assert.equal(content.sent.filter((request) => request.action === 'invalidate').length, 0)
assert.equal(content.message(refreshRequest).accepted, true)
assert.equal(content.reloads, 1, 'The accepted refresh runs synchronously before the handler returns')
assert.equal(content.pauseChanges.at(-1), true, 'The observer is paused before the controlled reload')
content.events.get('submit')({ type: 'submit', isTrusted: true, target: 'composer' })
assert.equal(content.sent.at(-1).action, 'invalidate', 'A real submission revokes the task even if its URL stays unchanged')
assert.equal(content.message(refreshRequest).accepted, false, 'A branch revision invalidates the old refresh authorization')
content.events.get('pagehide')({ persisted: false })
assert.equal(content.events.has('submit'), false)

const delayedHistory = contentHarness({driving:true})
await delayedHistory.api.initializeNetworkCapturePage()
await delayedHistory.completed
assert.equal(delayedHistory.scans,2,'A settled DOM edge triggers another natural sweep when network pagination is incomplete')
assert.equal(delayedHistory.sent.filter(request=>request.action==='commit').length,1)
assert.equal(delayedHistory.sent.find(request=>request.action==='commit').capture.messages.length,4)
assert.deepEqual(Array.from(delayedHistory.attachmentCandidates,candidate=>candidate.name).sort(),['earlier.png','later.png'],'Retry sweeps retain attachment candidates from both windows')
const missingHistory = contentHarness({driving:true,missingForever:true})
await missingHistory.api.initializeNetworkCapturePage()
await missingHistory.completed
assert.equal(missingHistory.sent.filter(request=>request.action==='commit').length,0,'A DOM complete flag cannot bypass permanently missing network pages')
assert.equal(missingHistory.scans,4,'Retries stay bounded within the same task and never refresh or replay requests')

function debugHarness() {
  const event = bus(), detached = bus(), calls = [], bodies = new Map()
  let attachError = false, attachWait = null
  const chrome = { debugger: {
    onEvent: event, onDetach: detached,
    attach: async (...args) => { calls.push(['attach', ...args]); if (attachWait) await attachWait; if (attachError) throw new Error('occupied') },
    detach: async (...args) => { calls.push(['detach', ...args]) },
    sendCommand: async (tab, method, parameters) => {
      calls.push([method, tab, parameters])
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'initial-loader' } } }
      if (method === 'Network.getResponseBody') { const body = await bodies.get(parameters.requestId); if (body instanceof Error) throw body; return typeof body === 'object' ? body : { body } }
      return {}
    },
  } }
  const api = load('src/background/network-debug-session.ts', { '../adapters/chatgpt/network-response': parser, '../adapters/chatgpt/network-evidence': evidence }, { chrome })
  const emit = (method, data, tabId = 1) => event.emit({ tabId }, method, data)
  const navigate = (url = sourceUrl, tabId = 1, loaderId = 'loaded') => emit('Page.frameNavigated', { frame: { id: 'main', loaderId, url } }, tabId)
  const response = (id, { url = `https://chatgpt.com/backend-api/conversations/synthetic-source`, tabId = 1, frameId = 'main', loaderId = 'loaded', method = 'GET', status = 200, body = '{"messages":[{}],"page_info":{}}', encodedDataLength = 100 } = {}) => {
    bodies.set(id, body)
    const request = { url, method, get headers() { throw new Error('Headers must never be read') }, get postData() { throw new Error('Request bodies must never be read') } }
    emit('Network.requestWillBeSent', { requestId: id, frameId, loaderId, type: 'Fetch', request }, tabId)
    emit('Network.responseReceived', { requestId: id, frameId, loaderId, response: { url, status, mimeType: 'application/json' } }, tabId)
    emit('Network.loadingFinished', { requestId: id, encodedDataLength }, tabId)
  }
  return { api, chrome, calls, bodies, emit, navigate, response, event, detached, setAttachError: (value) => { attachError = value }, setAttachWait: (value) => { attachWait = value } }
}
let debug = debugHarness()
const reads = [], failures = []
let session = new debug.api.NetworkDebugSession(1, target, { response: (...args) => reads.push(args), failure: (message) => failures.push(message), navigation: () => true })
await session.connect()
assert.equal(debug.calls.find(([method]) => method === 'Network.enable')[2].maxResourceBufferSize, 128 * 1024 * 1024)
assert.equal(debug.calls.find(([method]) => method === 'Network.enable')[2].maxTotalBufferSize, 256 * 1024 * 1024)
debug.response('old-document-pending', { loaderId:'initial-loader' })
await tick()
assert.equal(session.pendingCount,0,'Pre-refresh requests never enter the capture generation')
assert.equal(reads.length,0)
debug.navigate()
debug.response('unrelated', { url: 'https://chatgpt.com/backend-api/me' })
debug.response('wrong-frame', { frameId: 'child' })
debug.response('wrong-loader', { loaderId: 'old' })
debug.response('wrong-tab', { tabId: 2 })
debug.response('wrong-method', { method: 'POST' })
assert.equal(debug.calls.filter(([method]) => method === 'Network.getResponseBody').length, 0)
const largeBody = JSON.stringify({ messages: [{ content: 'x'.repeat(18 * 1024 * 1024) }], page_info: {} })
debug.response('large', { body: largeBody })
debug.navigate() // Duplicate notification for the same document and loader.
await tick()
assert.equal(reads.length, 1)
assert.equal(failures.length,0,'A duplicate frame notification cannot cancel the authorized response read')
assert.ok(reads[0][2] > 17 * 1024 * 1024, 'A >17 MiB response is read through the real bounded implementation')
assert.equal(session.pendingCount, 0)
debug.response('cache-error', { body: new Error('No resource with given identifier found') })
await tick()
assert.match(failures.at(-1), /调试缓存/)
await session.disconnect()
assert.equal(debug.event.size, 0); assert.equal(debug.detached.size, 0)
debug.response('late')
await tick()
assert.equal(reads.length, 1, 'Late events after cleanup cannot enter a new task')
debug = debugHarness()
const throttledReads = [], throttledFailures = []
session = new debug.api.NetworkDebugSession(1, target, { response: (...args) => throttledReads.push(args), failure: (message) => throttledFailures.push(message), navigation: () => true })
await session.connect(); debug.navigate()
debug.response('rate-limited', { status: 429 })
await tick()
assert.match(throttledFailures[0], /限流.*HTTP 429/,'A real rate-limit response is identified instead of being reported as malformed JSON')
assert.equal(debug.calls.filter(([method]) => method === 'Network.getResponseBody').length, 0, 'Rate-limit responses cannot enter body parsing or persistence')
debug.response('late-after-rate-limit')
await tick()
assert.equal(throttledReads.length, 0, 'Later responses cannot revive a rate-limited task')
assert.equal(throttledFailures.length, 1)
await session.disconnect()
debug = debugHarness()
session = new debug.api.NetworkDebugSession(1, target, { response() {}, failure: (message) => failures.push(message), navigation: () => true })
await session.connect()
debug.detached.emit({ tabId: 1 }, 'target_closed')
assert.match(failures.at(-1), /页面已关闭/)
await session.disconnect()
assert.equal(debug.calls.filter(([method]) => method === 'detach').length, 0, 'A terminated session is not detached a second time')
debug = debugHarness(); debug.setAttachError(true)
session = new debug.api.NetworkDebugSession(1, target, { response() {}, failure() {}, navigation: () => true })
await assert.rejects(() => session.connect(), /调试工具/)
assert.equal(debug.calls.filter(([method]) => method === 'detach').length, 0, 'Attach failure cannot detach another debugger')
debug = debugHarness()
let releaseAttach
debug.setAttachWait(new Promise((resolve) => { releaseAttach = resolve }))
session = new debug.api.NetworkDebugSession(1, target, { response() {}, failure() {}, navigation: () => true })
const connecting = session.connect()
await session.disconnect()
releaseAttach()
await assert.rejects(() => connecting)
assert.equal(debug.calls.filter(([method]) => method === 'detach').length, 1, 'Cancellation during attach cleans the eventually acquired connection')

debug = debugHarness()
const boundedReads = [], boundedFailures = []
session = new debug.api.NetworkDebugSession(1, target, { response: (...args) => boundedReads.push(args), failure: (message) => boundedFailures.push(message), navigation: () => true })
await session.connect()
debug.navigate()
let releaseBodies
const pendingBody = new Promise((resolve) => { releaseBodies = resolve })
for (let index = 0; index < 5; index++) debug.response(`concurrent-${index}`, { body: pendingBody })
assert.equal(debug.calls.filter(([method]) => method === 'Network.getResponseBody').length, 4, 'Body reads have an independent concurrency bound')
assert.match(boundedFailures[0], /同时读取/)
debug.response('after-failure')
releaseBodies('{"messages":[],"page_info":{}}')
await tick()
assert.equal(boundedReads.length, 0, 'An overflow invalidates already pending bodies and all later events')
assert.equal(boundedFailures.length, 1, 'A failed session reports one terminal failure')
await session.disconnect()

debug = debugHarness()
const decodedReads = []
session = new debug.api.NetworkDebugSession(1, target, { response: (...args) => decodedReads.push(args), failure: assert.fail, navigation: () => true })
await session.connect()
debug.navigate()
const unicodeBody = '{"messages":[{"content":"合成响应"}],"page_info":{}}'
debug.response('base64', { body: { body: Buffer.from(unicodeBody).toString('base64'), base64Encoded: true } })
await tick()
assert.equal(decodedReads[0][0], unicodeBody)
assert.equal(decodedReads[0][2], Buffer.byteLength(unicodeBody), 'Decoded limits count UTF-8 bytes, not string length')
await session.disconnect()

// Production coordinator + production debugger with fake browser transport.
// Probe jobs must never invoke a save service. Save jobs exercise the actual
// parser/coordinator/debug transport with an authorized database boundary.
function coordinatorHarness({ stored = [], ownership = true, saving = false } = {}) {
  const debug = debugHarness()
  const statuses = new Map(stored.map((status) => [status.originTabId, structuredClone(status)]))
  const timers = new Map(), tabCalls = [], probeOptions = [], tabs = new Map([[1, { id: 1, url: sourceUrl }], [2, { id: 2, url: sourceUrl }]])
  let sequence = 10, timerId = 0, reloads = 0, claims = [], blockers = [], probeHook = null
  const states = new Map([1, 2].map((id) => [id, { url: sourceUrl, conversationId: 'synthetic-source', documentToken: `document-${id}`, contentScriptBuildId: 'test-build', blockers: [], branchRevision: 0 }]))
  let coordinator
  let savedRecord = null
  const writes = []
  const rendered = [{ role: 'user', content: 'Synthetic user question with a unique native anchor', sourceMessageId: 'u' }, { role: 'assistant', content: 'Synthetic assistant answer with a unique native anchor', sourceMessageId: 'a' }]
  const capture = { platform: 'chatgpt', conversationId: 'synthetic-source', title: 'Synthetic title', url: sourceUrl, messages: rendered, accountIdentifier: null, accountLabel: 'Unknown' }
  debug.chrome.runtime = { getURL: (path) => `chrome-extension://test/${path}`, sendMessage: async () => undefined }
  debug.chrome.tabs = {
    query: async () => [...tabs.values()],
    create: async (options) => { tabCalls.push(['create', options]); const tab = { id: ++sequence, url: options.url }; tabs.set(tab.id, tab); return tab },
    update: async (id, options) => {
      tabCalls.push(['update', id, options]); Object.assign(tabs.get(id), options)
      if (options.url) {
        debug.navigate(options.url, id)
        const claim = coordinator.handleNetworkCapture({ type: 'NETWORK_CAPTURE', action: 'claim', contentScriptBuildId: 'test-build', documentToken: 'share-document' }, { tab: { id }, frameId: 0, documentId: 'native-share-document', url: options.url })
        claims.push(claim); await claim
      }
    },
    remove: async (id) => { tabCalls.push(['remove', id]); tabs.delete(id) },
    sendMessage: async (id, message, options) => {
      if (message.type === shared.NETWORK_PAGE_CONTEXT) return structuredClone(capture)
      if (message.type === shared.NETWORK_PAGE_PROBE) {
        probeOptions.push(options)
        const state = { ...states.get(id), blockers: [...blockers] }
        probeHook?.(state, message)
        return state
      }
      if (message.type === shared.NETWORK_VERIFY_TASK) return ownership ? { jobId: message.jobId } : null
      if (message.type === shared.NETWORK_PAGE_REFRESH) {
        if (blockers.length) return { accepted: false }
        reloads += 1
        const state = states.get(id)
        debug.navigate(sourceUrl, id)
        state.documentToken = `reloaded-${reloads}`
        const claim = coordinator.handleNetworkCapture({ type: 'NETWORK_CAPTURE', action: 'claim', contentScriptBuildId: 'test-build', conversationId: 'synthetic-source', documentToken: state.documentToken }, { tab: { id }, frameId: 0, documentId: `native-${reloads}`, url: sourceUrl })
        claims.push(claim); await claim
        return { accepted: true }
      }
      return undefined
    },
  }
  coordinator = load('src/background/network-capture-coordinator.ts', {
    '../adapters/chatgpt/network-response': parser,
    '../adapters/chatgpt/network-evidence': evidence,
    '../db/settings': { getSettings: async () => ({ saveImages: false, fileSavePolicy: 'never', attachmentMaxSizeMb: 10 }) },
    '../services/conversation-service': {
      getSavedConversationBySource: async () => savedRecord,
      saveVerifiedNetworkConversation: async (payload, authorize) => {
        assert.equal(saving, true, 'Probe jobs must not write conversation content')
        assert.equal(await authorize(), true)
        writes.push({ type: 'body', payload: structuredClone(payload) })
        savedRecord = { ...payload, id: 'synthetic-local-record', imageAttachmentPermission: false, fileAttachmentPermission: false, important: true, attachments: [] }
        return { conversation: savedRecord, changed: true }
      },
      savePendingNetworkConversation: async (payload, issue, authorize) => {
        assert.equal(saving, true)
        assert.equal(await authorize(), true)
        writes.push({ type: 'pending', payload: structuredClone(payload), issue })
        savedRecord = { ...payload, id: 'synthetic-local-record', pendingCapture: issue }
        return { conversation: savedRecord, changed: true }
      },
      supplementVerifiedNetworkAttachments: async (id, attachments, authorize) => {
        assert.equal(saving, true); assert.equal(await authorize(), true); assert.equal(id, savedRecord.id)
        writes.push({ type: 'attachments', attachments: structuredClone(attachments) })
        savedRecord = { ...savedRecord, attachments }
        return savedRecord
      },
      updateConversationFileAttachmentPermission: async () => savedRecord, updateConversationImageAttachmentPermission: async () => savedRecord,
    },
    '../services/validation': { isChatMessage: () => true, hasValidConversationAttachments: () => true },
    '../utils/hash': { createContentHash: async () => 'a'.repeat(64) },
    './runtime-readiness': { getCaptureReadiness: async () => ({ ready: true }) },
    '../db/network-capture-jobs': { readNetworkCaptureJobs: async () => [...statuses.values()], putNetworkCaptureJob: async (status) => { statuses.set(status.originTabId, structuredClone(status)) }, deleteNetworkCaptureJob: async (id) => { statuses.delete(id) } },
    '../shared/build-id': { EXTENSION_BUILD_ID: 'test-build' }, '../shared/network-capture': shared, '../shared/share-capture': share,
    './network-debug-session': debug.api, './share-capture-coordinator': { hasActiveShareCapture: () => false },
  }, { chrome: debug.chrome, setTimeout: (callback) => { timers.set(++timerId, callback); return timerId }, clearTimeout: (id) => timers.delete(id) })
  const sender = (id = 1) => ({ tab: { id }, frameId: 8, url: 'chrome-extension://test/panel.html' })
  const action = (action, more = {}, id = 1) => coordinator.handleNetworkCapture({ type: 'NETWORK_CAPTURE', contentScriptBuildId: 'test-build', action, conversationId: 'synthetic-source', ...more }, sender(id))
  const start = (mode = 'conversation', operation = 'probe') => action('start', { mode, operation, method: 'network', shareUrl })
  const sourceAction = (action, more = {}) => coordinator.handleNetworkCapture({ type: 'NETWORK_CAPTURE', contentScriptBuildId: 'test-build', conversationId: 'synthetic-source', documentToken: states.get(1).documentToken, action, ...more }, { tab: { id: 1 }, frameId: 0, documentId: `native-${reloads}`, url: sourceUrl })
  const captureAction = (action, more = {}) => coordinator.handleNetworkCapture({ type: 'NETWORK_CAPTURE', contentScriptBuildId: 'test-build', action, documentToken: 'share-document', ...more }, { tab: { id: 11 }, frameId: 0, documentId: 'native-share-document', url: shareUrl })
  return { ...debug, coordinator, statuses, writes, capture, sourceAction, captureAction, tabCalls, probeOptions, timers, states, action, start, get reloads() { return reloads }, setBlockers: (value) => { blockers = value }, setProbeHook: (value) => { probeHook = value } }
}
let harness = coordinatorHarness()
for (const blocker of ['draft', 'attachment', 'editing', 'generating', 'unknown', 'busy']) {
  harness.setBlockers([blocker])
  const response = await harness.start()
  assert.equal(response.blockers[0], blocker)
  assert.equal(response.status, null)
}
assert.equal(harness.calls.length, 0); assert.equal(harness.reloads, 0)
harness.setBlockers([])
let started = await harness.start()
await tick()
assert.equal(harness.reloads, 1)
assert.ok(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'))
assert.equal(harness.coordinator.isNetworkSavePaused('gemini', 'synthetic-source'), false)
assert.equal((await harness.action('start', { mode: 'share', method: 'network', shareUrl }, 2)).blockers[0], 'busy', 'Another tab of the same conversation cannot start a second job')
const otherTabStatus = await harness.action('status', {}, 2)
assert.equal(otherTabStatus.status.id, started.status.id)
assert.equal(otherTabStatus.canControl, false)
assert.equal(otherTabStatus.paused, true)
await assert.rejects(() => harness.action('cancel', { jobId: started.status.id }, 2), /发起接口验证/)
assert.ok(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), 'Other-tab polling and control attempts must not release the owner lock')
harness.response('page-one')
await tick()
const reading = await harness.action('status')
assert.equal(reading.status.responseCount, 1)
assert.equal(reading.status.phase, 'reading')
assert.ok(harness.probeOptions.some((options) => options.documentId === 'native-1'), 'After reload, verification targets the rebound native document')
const verified = await harness.action('finish', { jobId: started.status.id })
assert.equal(verified.status.phase, 'verified')
assert.match(verified.status.message, /本次未保存对话/)
assert.equal(verified.paused, false)
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)
assert.equal(harness.tabCalls.some(([method]) => method === 'remove'), false, 'Never close the original tab')
assert.equal(harness.event.size, 0)
assert.doesNotMatch(JSON.stringify([...harness.statuses.values()]), /https:|synthetic-cursor|messages|content"|documentToken/)
const secondTabJob = await harness.action('start', { mode: 'conversation', method: 'network' }, 2)
await tick()
const oldOwnerStatus = await harness.action('status')
assert.equal(oldOwnerStatus.status.id, secondTabJob.status.id, 'An old terminal result cannot hide another tab\'s active lock')
assert.equal(oldOwnerStatus.canControl, false)
assert.equal(oldOwnerStatus.paused, true)
await harness.action('cancel', { jobId: secondTabJob.status.id }, 2)

harness = coordinatorHarness()
let probeCount = 0
harness.setProbeHook((state) => { if (++probeCount > 1) state.blockers = ['draft'] })
started = await harness.start()
await tick()
assert.equal(harness.reloads, 0, 'A new draft after attach prevents refresh')
assert.equal((await harness.action('status')).status.phase, 'failed')
assert.equal(harness.event.size, 0)
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)

harness = coordinatorHarness()
started = await harness.start()
await tick()
await harness.coordinator.cancelNetworkCaptureJobs('synthetic-source')
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false, 'Deletion revokes task authorization and the cross-tab lock')
assert.equal(harness.event.size, 0)
assert.equal(harness.statuses.size, 0)

harness = coordinatorHarness()
started = await harness.start()
await tick()
await harness.coordinator.handleNetworkTabRemoved(1)
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)
assert.equal((await harness.action('status')).status.phase, 'cancelled', 'Source closure leaves a terminal unsaved result')

harness = coordinatorHarness()
started = await harness.start()
await tick()
harness.navigate(sourceUrl, 1, 'second-loader') // A real reload has a new document loader.
await tick()
assert.equal((await harness.action('status')).status.phase, 'failed')
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)

harness = coordinatorHarness()
started = await harness.start()
await tick()
harness.states.get(1).branchRevision += 1
assert.equal((await harness.action('status')).status.phase, 'cancelled', 'Same-URL branch changes revoke the task')
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)

harness = coordinatorHarness()
harness.setBlockers(['draft']) // Sharing never refreshes the original draft.
started = await harness.start('share')
await tick()
assert.equal(harness.reloads, 0)
const ownedId = [...harness.tabCalls].find(([method]) => method === 'update')[1]
assert.ok(ownedId !== 1)
assert.ok(harness.calls.findIndex(([method]) => method === 'Network.enable') >= 0)
assert.equal(harness.tabCalls[0][1].url, 'about:blank')
harness.response('share-body', { tabId: ownedId, url: 'https://chatgpt.com/backend-api/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: '{"mapping":{"root":{}},"current_node":"root"}' })
await tick()
assert.equal((await harness.action('status')).status.responseCount, 1)
await harness.action('cancel', { jobId: started.status.id })
assert.ok(harness.tabCalls.some(([method, id]) => method === 'remove' && id === ownedId))
assert.equal(harness.tabCalls.some(([method, id]) => method === 'remove' && id === 1), false)

for (const ownership of [true, false]) {
  const unfinished = { ...started.status, phase: 'reading', captureTabId: 11 }
  harness = coordinatorHarness({ stored: [unfinished], ownership })
  await harness.coordinator.initializeNetworkCaptureJobs()
  assert.equal(harness.statuses.get(1).phase, 'failed')
  assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)
  assert.equal(harness.calls.filter(([method]) => method === 'detach').length, ownership ? 1 : 0)
  assert.equal(harness.tabCalls.filter(([method]) => method === 'remove').length, ownership ? 1 : 0, 'Restart cannot close a tab without its task ownership handshake')
}

const nativeMessages = [
  { id: 'u', author: { role: 'user' }, content: { content_type: 'text', parts: ['Synthetic user question with a unique native anchor'] }, status: 'finished_successfully', metadata: {}, recipient: 'all', channel: null },
  { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Synthetic assistant answer with a unique native anchor'] }, status: 'finished_successfully', metadata: {}, recipient: 'all', channel: 'final', end_turn: false },
]
const completeBody = JSON.stringify({ conversation_id: 'synthetic-source', messages: nativeMessages, current_node: 'a', page_info: { start_cursor: 'u', end_cursor: 'a', has_previous_page: false, has_next_page: false } })
harness = coordinatorHarness({ saving: true })
started = await harness.start('conversation', 'save')
await tick()
await assert.rejects(() => harness.sourceAction('commit', { jobId: started.status.id, capture: { ...harness.capture, captureComplete: true } }), /独立核对/, 'A content-script DOM completeness claim cannot authorize a network save')
assert.equal(harness.writes.length, 0)
harness.response('complete-body', { body: completeBody })
await tick()
assert.equal((await harness.action('status')).networkComplete, true)
await assert.rejects(() => harness.action('commit', { jobId: started.status.id, capture: harness.capture }), /采集文档/)
let committed = await harness.sourceAction('commit', { jobId: started.status.id, capture: harness.capture })
assert.equal(committed.status.phase, 'attachments')
assert.equal(committed.status.bodySaved, true)
assert.equal(harness.writes.filter(write => write.type === 'body').length, 1)
assert.equal(harness.writes[0].payload.captureSnapshotComplete, undefined, 'Network authority does not borrow a DOM completeness flag')
assert.equal(harness.writes[0].payload.messages[0].sourceOrder, undefined)
await assert.rejects(() => harness.sourceAction('commit', { jobId: started.status.id, capture: harness.capture }), /不能重复/)
let completed = await harness.sourceAction('attachments', { jobId: started.status.id, attachments: [] })
assert.equal(completed.status.phase, 'complete')
assert.equal(completed.paused, false)
assert.equal(harness.writes.filter(write => write.type === 'body').length, 1)
assert.equal(harness.writes.filter(write => write.type === 'attachments').length, 1)

harness = coordinatorHarness({ saving: true })
harness.capture.messages[1].attachmentNames = ['image-1.png']
started = await harness.start('conversation', 'save'); await tick()
harness.response('complete-body', { body: completeBody }); await tick()
await harness.sourceAction('commit', { jobId: started.status.id, capture: harness.capture })
const positionedImage = { id: 'b'.repeat(64), name: 'image-1.png', kind: 'image', mimeType: 'image/png', size: null, status: 'not-saved', messageIndex: 1 }
await assert.rejects(() => harness.sourceAction('attachments', { jobId: started.status.id, attachments: [{ ...positionedImage, name: 'image-2.png' }] }), /不属于本轮/, 'Attachment names cannot bypass their exact rendered-message evidence')
completed = await harness.sourceAction('attachments', { jobId: started.status.id, attachments: [positionedImage] })
assert.equal(completed.status.phase, 'complete')
assert.equal(harness.writes.find(write => write.type === 'attachments').attachments[0].messageIndex, 1)

harness = coordinatorHarness({ saving: true })
started = await harness.start('conversation', 'save'); await tick()
harness.response('complete-body', { body: completeBody }); await tick()
committed = await harness.sourceAction('commit', { jobId: started.status.id, capture: harness.capture })
await harness.coordinator.cancelNetworkCaptureJobs('synthetic-source')
await harness.sourceAction('attachments', { jobId: started.status.id, attachments: [] })
assert.equal(harness.writes.filter(write => write.type === 'attachments').length, 0, 'Deletion revokes attachment writes without resurrecting the record')

harness = coordinatorHarness({ saving: true })
started = await harness.start('share', 'save'); await tick()
const mapping = { root: { id: 'root', children: ['u'] }, u: { id: 'u', parent: 'root', children: ['a'], message: nativeMessages[0] }, a: { id: 'a', parent: 'u', children: [], message: nativeMessages[1] } }
harness.response('share-complete', { tabId: 11, url: 'https://chatgpt.com/backend-api/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: JSON.stringify({ mapping, current_node: 'a' }) }); await tick()
const publicCapture = { ...harness.capture, conversationId: shareUrl.split('/').at(-1), url: shareUrl }
committed = await harness.captureAction('commit', { jobId: started.status.id, capture: publicCapture })
assert.equal(committed.status.bodySaved, true)
assert.equal(harness.writes[0].payload.conversationId, 'synthetic-source', 'Sharing supplements the source rather than saving a public-share record')
assert.equal(harness.writes[0].payload.supplementOnly, true)
completed = await harness.captureAction('attachments', { jobId: started.status.id, attachments: [] })
assert.equal(completed.status.phase, 'complete')
assert.ok(harness.tabCalls.some(([operation, id]) => operation === 'remove' && id === 11))

harness = coordinatorHarness({saving:true})
const laterQuestion={role:'user',sourceMessageId:'u2',content:'Synthetic later question with a stable identity'}
const newerAnswer={role:'assistant',sourceMessageId:'a2',content:'A newer local answer that must not prevent supplementing older history'}
harness.capture.messages.push(laterQuestion,newerAnswer)
started=await harness.start('share','save');await tick()
const olderNative=[...nativeMessages,{...nativeMessages[0],id:'u2',content:{content_type:'text',parts:[laterQuestion.content]}},{...nativeMessages[1],id:'a2',content:{content_type:'text',parts:['Older public answer text']}}]
const olderMapping={root:{id:'root',children:['u']}}
olderNative.forEach((message,index)=>{olderMapping[message.id]={id:message.id,parent:index?olderNative[index-1].id:'root',children:index+1<olderNative.length?[olderNative[index+1].id]:[],message}})
harness.response('older-share',{tabId:11,url:'https://chatgpt.com/backend-api/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',body:JSON.stringify({mapping:olderMapping,current_node:'a2'})});await tick()
const olderPublic={...harness.capture,conversationId:shareUrl.split('/').at(-1),url:shareUrl,messages:olderNative.map(message=>({role:message.author.role,sourceMessageId:message.id,content:message.content.parts[0]}))}
committed=await harness.captureAction('commit',{jobId:started.status.id,capture:olderPublic})
assert.equal(committed.status.bodySaved,true,'One unchanged native question/answer pair binds an older snapshot despite newer local text elsewhere')
await harness.captureAction('attachments',{jobId:started.status.id,attachments:[]})
assert.equal(harness.tabCalls.some(([operation, id]) => operation === 'remove' && id === 1), false)

// Failed display verification is a decision, never an automatic save.
harness = coordinatorHarness({ saving: true })
started = await harness.start('conversation', 'save'); await tick()
harness.response('complete-body', { body: completeBody }); await tick()
const mismatched = { ...harness.capture, messages: harness.capture.messages.map((entry, index) => index ? { ...entry, content: 'Different rendered answer' } : entry) }
await assert.rejects(() => harness.sourceAction('commit', { jobId: started.status.id, capture: mismatched }), /不一致/)
await assert.rejects(() => harness.action('error', { jobId: started.status.id, capture: mismatched }), /采集文档提交/, 'The panel cannot inject a provisional candidate')
const review = await harness.sourceAction('error', { jobId: started.status.id, capture: mismatched, error: 'Synthetic display mismatch' })
assert.equal(review.status.phase, 'awaiting-confirmation')
assert.equal(review.status.candidateCount, 2)
assert.equal(review.status.candidateSource, 'network')
assert.equal(review.paused, true, 'The decision keeps the cross-tab save lock')
assert.equal(review.drive, undefined, 'The collector cannot resume while awaiting a decision')
assert.equal(harness.event.size, 0, 'The debugger disconnects before asking the user')
assert.equal(harness.writes.length, 0)
assert.doesNotMatch(JSON.stringify([...harness.statuses.values()]), /Synthetic user|Synthetic assistant|Different rendered|https:/, 'Status persistence contains neither candidates nor page URLs')
await assert.rejects(() => harness.sourceAction('confirm', { jobId: started.status.id }), /面板确认/)
await assert.rejects(() => harness.action('confirm', { jobId: started.status.id }, 2), /发起接口验证/)
completed = await harness.action('confirm', { jobId: started.status.id, capture: { messages: ['cannot replace the worker candidate'] } })
assert.equal(completed.status.phase, 'partial')
assert.equal(completed.paused, false)
assert.equal(harness.writes[0].type, 'pending')
assert.equal(harness.writes[0].payload.messages[1].content, nativeMessages[1].content.parts[0], 'Confirmation uses the worker candidate, never panel-supplied text')
assert.equal(harness.writes[0].payload.messages[1].contentSource, undefined)
assert.equal(harness.writes.length, 1, 'Exceptional saving does not copy attachments')
await assert.rejects(() => harness.action('confirm', { jobId: started.status.id }), /已失效/)

for (const revoke of ['cancel', 'branch', 'delete', 'restart']) {
  harness = coordinatorHarness({ saving: true })
  started = await harness.start('conversation', 'save'); await tick()
  const response = await harness.sourceAction('error', { jobId: started.status.id, capture: harness.capture, error: 'Synthetic missing pagination' })
  assert.equal(response.status.candidateSource, 'page', 'A missing chain can retain only rendered page text')
  if (revoke === 'cancel') await harness.action('cancel', { jobId: started.status.id })
  if (revoke === 'branch') harness.states.get(1).branchRevision += 1
  if (revoke === 'delete') await harness.coordinator.cancelNetworkCaptureJobs('synthetic-source')
  if (revoke === 'restart') {
    harness = coordinatorHarness({ stored: [...harness.statuses.values()], saving: true })
    await harness.coordinator.initializeNetworkCaptureJobs()
  }
  try { await harness.action('confirm', { jobId: started.status.id }) } catch { /* Revoked candidates must not be saved. */ }
  assert.equal(harness.writes.length, 0, `${revoke} discards the candidate without a write`)
  assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)
}

harness = coordinatorHarness({ saving: true })
started = await harness.start('share', 'save'); await tick()
const wrongShare = { ...publicCapture, messages: [{role:'user',content:'Unrelated private question',sourceMessageId:'wrong-u'},{role:'assistant',content:'Unrelated answer',sourceMessageId:'wrong-a'}] }
const rejectedShare = await harness.captureAction('error', { jobId: started.status.id, capture: wrongShare, error: 'Synthetic share mismatch' })
assert.equal(rejectedShare.status.phase, 'failed', 'Missing source identity cannot become confirmable')
assert.equal(harness.writes.length, 0)
assert.equal(harness.coordinator.isNetworkSavePaused('chatgpt', 'synthetic-source'), false)

console.log('network capture verification passed: safety, exact targets, large bodies, document/loader binding, probe isolation, independent network authorization, one body commit, separate attachments, sharing, deletion, cancellation and restart cleanup')
