import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parseHTML } from 'linkedom'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

const floatingPanel = readSource('src/content/floating-panel.ts')
assert.match(floatingPanel, /const HEADER_CLEARANCE = 58/)
assert.match(floatingPanel, /const DEFAULT_TOP = HEADER_CLEARANCE \+ 12/)
assert.match(
  floatingPanel,
  /const closePanel = \(\): void => \{[\s\S]*?button\.hidden = false[\s\S]*?aria-expanded', 'false'/,
  'Every panel close path must restore the launcher',
)
assert.match(
  floatingPanel,
  /const openPanel = \(\): void => \{[\s\S]*?shadow\.append\(panel\)[\s\S]*?button\.hidden = true[\s\S]*?aria-expanded', 'true'/,
  'Opening the overlay must hide the launcher immediately',
)

const readme = readSource('README.md')
assert.match(readme, /top: 70px; right: 10px/)
assert.match(readme, /打开侧边栏时入口隐藏，关闭后恢复/)

// Exercise the real controller while the iframe still has the host origin.
const { document, Event } = parseHTML('<html><body></body></html>')
const listeners = new Map()
const timers = new Map()
let timerId = 0
let shadow
const createElement = document.createElement.bind(document)
document.createElement = (tag) => {
  const element = createElement(tag)
  if (tag === 'div') {
    const attachShadow = element.attachShadow.bind(element)
    element.attachShadow = (options) => (shadow = attachShadow(options))
  }
  return element
}
const window = {
  innerWidth: 1200, innerHeight: 800,
  addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
  removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
  setInterval() { return ++timerId }, clearInterval() {},
  setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id },
  clearTimeout(id) { timers.delete(id) },
}
const extensionOrigin = 'chrome-extension://synthetic-extension'
class BrowserURL extends URL {
  get origin() { return this.protocol === 'chrome-extension:' ? `${this.protocol}//${this.host}` : super.origin }
}
function loadModule(source, dependencies = {}) {
  const exports = {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, {
    exports, document, window, URL: BrowserURL, URLSearchParams,
    location: { origin: 'https://chatgpt.com' }, performance: { now: () => 1000 },
    chrome: { runtime: { getURL: path => `${extensionOrigin}/${path}` } },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  return exports
}
const models = loadModule(readSource('src/shared/models.ts'))
const messages = loadModule(readSource('src/shared/panel-messages.ts'), { './models': models })
const api = loadModule(floatingPanel, {
  '../shared/models': models, '../shared/panel-messages': messages,
  '../shared/runtime-client': { sendRuntimeRequest: async () => ({ overlayPanelWidth: 360 }) },
  '../shared/runtime-messages': { RUNTIME_MESSAGE_TYPE: {} },
})
let context = { platform: 'chatgpt', conversationId: 'first' }
let completeSave
const controller = api.installFloatingPanel({
  getConversationContext: () => context,
  getConversationLiveState: () => ({ context }),
  onManualSave: () => new Promise(resolve => { completeSave = resolve }),
  onCancelShareCapture() {},
})
assert.ok(controller)
const button = shadow.querySelector('button')
const sent = []
function open() {
  button.dispatchEvent(new Event('click'))
  const frame = shadow.querySelector('iframe')
  assert.ok(frame)
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (message, origin) => sent.push({ frame, message, origin }) } })
  return frame
}
function emit(frame, type, origin = extensionOrigin, extra = {}) {
  for (const listener of listeners.get('message') ?? []) listener({ source: frame.contentWindow, origin, data: { source: messages.PANEL_MESSAGE_SOURCE.PANEL, type, ...extra } })
}
function flushTimers() { const queued = [...timers.values()]; timers.clear(); queued.forEach(fn => fn()) }
const first = open()
controller.ensureMounted()
controller.notifyConversationStateChanged()
first.dispatchEvent(new Event('load'))
flushTimers()
assert.equal(sent.length, 0, 'Mount/load/updates cannot post to the initial host-origin iframe')
emit(first, 'REQUEST_LIVE_STATE', 'https://chatgpt.com')
assert.equal(sent.length, 0, 'A request from the inherited host origin cannot authorize posting')
emit(first, 'REQUEST_LIVE_STATE')
assert.equal(sent.length, 2, 'The real panel request immediately receives context and live state')
assert.ok(sent.every(entry => entry.origin === extensionOrigin))
emit(first, 'MANUAL_SAVE', extensionOrigin, { requestId: 'save-1' })
assert.equal(typeof completeSave, 'function')
controller.notifyConversationStateChanged()
emit(first, 'CLOSE')
const second = open()
context = { ...context, conversationId: 'second' }
first.dispatchEvent(new Event('load'))
emit(first, 'REQUEST_LIVE_STATE')
controller.ensureMounted()
flushTimers()
completeSave({ ok: false, reason: 'failed', message: 'synthetic' })
await Promise.resolve()
assert.equal(sent.length, 2, 'Old loads, timers, requests and save results cannot post into a reopened frame')
emit(second, 'REQUEST_LIVE_STATE')
assert.equal(sent.length, 4)
assert.equal(sent[2].message.context.conversationId, 'second', 'Reopening sends the latest context after its own handshake')
controller.notifyConversationStateChanged()
controller.destroy()
flushTimers()
emit(second, 'REQUEST_LIVE_STATE')
assert.equal(sent.length, 4, 'Destroyed controllers cannot send queued updates')
console.log('floating panel interaction verification passed: iframe origin handshake, delayed load, rapid reopen and stale result/timer isolation')
