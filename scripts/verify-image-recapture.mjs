import assert from 'node:assert/strict'
import { verificationModule } from './load-verification-module.mjs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, dependencies = {}, globals = {}, append = '') {
  const exports = {}
  const code = ts.transpileModule(source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  runInNewContext(code + append, {
    exports, URL, AbortController, Blob, Response, ...globals,
    require(name) {
      if (name.includes('/gemini/')) return verificationModule(`src/adapters/gemini/${name.split('/').at(-1)}.ts`, globals)
      assert.ok(name in dependencies, `Unexpected dependency ${name}`)
      return dependencies[name]
    },
  }, { filename: path })
  return exports
}

const models = load('src/shared/models.ts')
const attachments = load('src/shared/attachments.ts', { './models': models })
const remoteImages = load('src/shared/remote-images.ts')
const reconciliation = load('src/shared/conversation-reconciliation.ts')
const continuity = load('src/shared/capture-continuity.ts')
const image = 'data:image/png;base64,AQID'
const messages = [
  { role: 'user', content: 'Inspect the attached image.', sourceTurnId: 'question-1' },
  { role: 'assistant', content: 'The image contains a synthetic diagram.', sourceTurnId: 'answer-1' },
]
const candidate = {
  name: 'diagram.png', kind: 'image', mimeType: 'image/png', size: null,
  sourceUrl: 'https://files.oaiusercontent.com/diagram.png?sig=old',
  messageIndex: 0, sourceTurnId: 'question-1',
}
const snapshot = (candidates) => ({
  platform: 'chatgpt', conversationId: 'conversation-fixture',
  title: 'Image recapture fixture', url: 'https://chatgpt.com/c/conversation-fixture',
  accountIdentifier: null, accountLabel: 'Unknown', messages,
  attachmentCandidates: candidates,
})
const window = { setTimeout, clearTimeout }
const requestedUrls = []
let responseMode = 'html'
const fetch = async (url) => {
  requestedUrls.push(url)
  if (responseMode === 'throw') throw new Error('Synthetic expired image URL')
  if (responseMode === 'fresh' && url.endsWith('sig=new')) {
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  }
  return new Response('Synthetic non-image response', { headers: { 'content-type': 'text/html' } })
}
class FileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
      this.onload()
    }).catch(() => this.onerror())
  }
}
const hash = {
  sha256Hex: async (value) => createHash('sha256').update(value).digest('hex'),
  createAccountId: async () => 'unknown',
  createContentHash: async (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex'),
}
const policy = { saveImages: true, allowFiles: false, skippedFileStatus: 'not-saved', maximumBytes: 1024 }
const capture = load('src/content/attachment-capture.ts', {
  '../shared/attachments': attachments,
  '../shared/runtime-client': { sendRuntimeRequest: async () => null },
  '../shared/runtime-messages': { RUNTIME_MESSAGE_TYPE: { READ_REMOTE_IMAGE: 'READ_REMOTE_IMAGE' } },
  '../shared/remote-images': { isPermittedRemoteImageUrl: () => false },
  '../utils/hash': hash,
  './embedded-image-reader': { readEmbeddedRemoteImage: async () => null },
}, { window, fetch, FileReader })

// The same candidate is first deliberately skipped, then explicitly authorized.
const cache = new Map()
const skipped = await capture.captureAttachments([{ ...candidate, renderedDataUrl: image }], { ...policy, saveImages: false }, cache)
assert.equal(skipped[0].status, 'not-saved')
assert.equal(requestedUrls.length, 0, 'Disabled image capture must not read image bytes')
const enabled = await capture.captureAttachments([{ ...candidate, renderedDataUrl: image }], policy, cache)
assert.equal(enabled[0].status, 'saved', 'An authorized update must retain the rendered image when its URL returns HTML')
assert.equal(enabled[0].dataUrl, image)
assert.equal(enabled[0].id, skipped[0].id, 'Enabling images upgrades the original attachment slot')
assert.equal(attachments.mergeConversationAttachments(skipped, enabled, false)[0].dataUrl, image)

responseMode = 'throw'
const duplicate = await capture.captureAttachments([candidate, { ...candidate, renderedDataUrl: image }], policy, new Map())
assert.equal(duplicate.length, 1)
assert.equal(duplicate[0].dataUrl, image, 'A later loaded image must upgrade an earlier metadata-only candidate')
const retained = await capture.captureAttachments([{ ...candidate, renderedDataUrl: image }, candidate], policy, new Map())
assert.equal(retained[0].dataUrl, image, 'A repeated unloaded window must retain already collected image bytes')

const refreshedCandidate = { ...candidate, sourceUrl: 'https://files.oaiusercontent.com/diagram.png?sig=new' }
requestedUrls.length = 0
responseMode = 'fresh'
const refreshed = await capture.captureAttachments([candidate, refreshedCandidate], policy, new Map())
assert.equal(requestedUrls.at(-1), refreshedCandidate.sourceUrl, 'Recapture must use the latest rendered URL rather than an expired earlier URL')
assert.equal(refreshed[0].status, 'saved', 'A renewed rendered URL must work without a canvas copy')
assert.equal(refreshed[0].dataUrl, image)
assert.equal(refreshed[0].id, skipped[0].id)
assert.equal(attachments.mergeConversationAttachments(skipped, refreshed, false).length, 1)

const fullWindow = Array.from({ length: 100 }, (_, index) => ({ ...candidate, renderedDataUrl: image, name: `diagram-${index}.png` }))
const bounded = await capture.captureAttachments([...fullWindow, { ...fullWindow[0], sourceUrl: refreshedCandidate.sourceUrl }], policy, new Map())
assert.equal(bounded.length, 100, 'All accumulated candidates, including those beyond the old 50-image cap, must be copied')
assert.equal(bounded[50].status, 'saved')
assert.equal(bounded[99].status, 'saved')
await assert.rejects(capture.captureAttachments([...fullWindow, { ...candidate, name: 'outside-limit.png' }], policy, new Map()), /100/, 'Overflow must be explicit instead of silently omitting images')
assert.equal(bounded[0].status, 'saved', 'A refreshed candidate must still upgrade an existing slot after the window reaches its limit')
const oversized = await capture.captureAttachments([{ ...candidate, renderedDataUrl: image }], { ...policy, maximumBytes: 2 }, new Map())
assert.notEqual(oversized[0].status, 'saved', 'Rendered fallback must respect image size limits')
assert.equal(oversized[0].dataUrl, undefined)

// Browser images can display while page canvas/fetch are blocked by CORS.
// Exercise the actual remote reader and the capture routing without pixels.
const imageResource = 'https://images.openai.com/static-rsc-4/synthetic-resource?purpose=fullsize'
const privilegedReads = []
const reader = load('src/background/remote-image-reader.ts', {
  '../shared/attachments': attachments, '../shared/remote-images': remoteImages,
}, {
  setTimeout, clearTimeout, btoa,
  fetch: async (url) => {
    privilegedReads.push(url)
    assert.equal(url, imageResource, 'The reader uses only the supplied rendered image URL')
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  },
})
const remoteCapture = load('src/content/attachment-capture.ts', {
  '../shared/attachments': attachments,
  '../shared/runtime-client': { sendRuntimeRequest: async (request) => reader.readPermittedRemoteImage(request.sourceUrl, request.maximumBytes) },
  '../shared/runtime-messages': { RUNTIME_MESSAGE_TYPE: { READ_REMOTE_IMAGE: 'READ_REMOTE_IMAGE' } },
  '../shared/remote-images': remoteImages,
  '../utils/hash': hash,
  './embedded-image-reader': { readEmbeddedRemoteImage: async () => null },
}, { window, FileReader, fetch: async () => { throw new Error('Page CORS blocks image fetch') } })
const remoteCandidate = { ...candidate, sourceUrl: imageResource, mimeType: null }
const disabledRemote = await remoteCapture.captureAttachments([remoteCandidate], { ...policy, saveImages: false }, new Map())
assert.equal(disabledRemote[0].status, 'not-saved')
assert.equal(privilegedReads.length, 0)
const copiedRemote = await remoteCapture.captureAttachments([remoteCandidate], policy, new Map())
assert.equal(copiedRemote[0].status, 'saved', 'Rendered images.openai.com resources must be copied through the extension reader')
assert.equal(copiedRemote[0].dataUrl, image)
assert.equal(privilegedReads.length, 1)
assert.equal(await reader.readPermittedRemoteImage('https://images.openai.com.example.com/synthetic-resource', 1024), null)
assert.equal(privilegedReads.length, 1, 'Lookalike hosts must not start a request')

const collector = load('src/adapters/dom-scroll-collector.ts', {
  '../shared/conversation-reconciliation': reconciliation,
  '../shared/capture-continuity': continuity,
}, {}, '\nexports.testMerge = mergeExtractedConversations;')
const mergedWindow = collector.testMerge(snapshot([{ ...candidate, renderedDataUrl: image }]), snapshot([candidate]))
assert.equal(mergedWindow.attachmentCandidates[0].renderedDataUrl, image, 'Scrolling must preserve the readable image from an earlier window')

let record = null
const types = Object.fromEntries(['GET_SETTINGS', 'SAVE_CONVERSATION', 'UPDATE_CONVERSATION_IMAGE_PERMISSION'].map(type => [type, type]))
const sendRuntimeRequest = async (request) => {
  if (request.type === 'GET_SETTINGS') return { saveImages: true, fileSavePolicy: 'never', attachmentMaxSizeMb: 1 }
  if (request.type === 'UPDATE_CONVERSATION_IMAGE_PERMISSION') {
    record = { ...record, imageAttachmentPermission: request.allowed }
    return record
  }
  assert.equal(request.type, 'SAVE_CONVERSATION')
  record = {
    ...record, ...request.conversation, id: 'local-fixture',
    imageAttachmentPermission: record?.imageAttachmentPermission ?? null,
    fileAttachmentPermission: false,
    attachments: attachments.mergeConversationAttachments(record?.attachments, request.conversation.attachments, request.conversation.attachmentSnapshotComplete !== true),
  }
  return record
}
const observerModule = load('src/content/conversation-observer.ts', {
  '../adapters/adapter-factory': { createAdapter: () => null },
  '../shared/conversation-reconciliation': reconciliation,
  '../shared/runtime-client': { sendRuntimeRequest },
  '../shared/runtime-messages': { RUNTIME_MESSAGE_TYPE: types },
  '../shared/build-id': { EXTENSION_BUILD_ID: 'fixture-build' },
  '../utils/hash': hash,
  '../utils/logger': { Logger: { warn() {}, error() {} } },
  './attachment-capture': capture,
  './auto-save-policy': {},
  '../shared/share-capture': {},
}, {
  window, location: { href: snapshot([]).url },
  document: {},
}, '\nexports.testMerge = mergeAccumulatedCapture;')
const observed = observerModule.testMerge(snapshot([{ ...candidate, renderedDataUrl: image }]), snapshot([candidate]))
assert.equal(observed.attachmentCandidates[0].renderedDataUrl, image, 'A passive window after collection must retain the captured image')
const complete = observerModule.testMerge(snapshot([{ ...candidate, renderedDataUrl: image }]), { ...snapshot([candidate]), captureComplete: true })
assert.equal(complete.attachmentCandidates[0].renderedDataUrl, image)
const removed = observerModule.testMerge(snapshot([{ ...candidate, renderedDataUrl: image }]), { ...snapshot([]), captureComplete: true })
assert.equal(removed.attachmentCandidates, undefined, 'An authoritative empty attachment list must still remove stale candidates')

const observer = new observerModule.ConversationObserver()
observer.adapter = { platform: 'chatgpt', getConversationId: () => 'conversation-fixture', getAccountIdentifier: () => null }
observer.isCaptureCurrent = () => true
observer.ensureCaptureRuntimeReady = async () => true
observer.hasCurrentPinnedEvidence = () => false
observer.setSyncStatus = () => undefined
const saveRequest = {
  trigger: 'manual', expectedConversationId: 'conversation-fixture', scheduledGeneration: 0, scheduledCaptureRevision: 1,
  completeSnapshotVerified: true,
  extractedOverride: { ...snapshot([{ ...candidate, renderedDataUrl: image }]), captureComplete: true },
}
responseMode = 'html'
await observer.performConversationSave({ ...saveRequest, manuallySaveImages: false })
assert.equal(record.imageAttachmentPermission, false)
assert.equal(record.attachments[0].status, 'not-saved')
await sendRuntimeRequest({ type: types.UPDATE_CONVERSATION_IMAGE_PERMISSION, allowed: true })
await observer.performConversationSave(saveRequest)
assert.equal(record.imageAttachmentPermission, true)
assert.equal(record.attachments.length, 1)
assert.equal(record.attachments[0].status, 'saved', 'The real save queue must supplement an image after its permission is enabled')
assert.equal(record.attachments[0].dataUrl, image)
assert.equal(record.attachments[0].messageIndex, 0)

console.log('image recapture verification passed: permission upgrade, fresh URLs, rendered fallback and scrolling retention')
