import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  runInNewContext(code, { exports, ...globals, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`)
    return dependencies[name]
  } }, { filename: path })
  return exports
}

// Exercise the production preference store. Unsaved conversations have their
// own entries, independent of app defaults and saved conversation contents.
const records = new Map([['app', { key: 'app', chatgptCaptureMode: 'conversation', saveImages: false }]])
const db = { STORE_NAME: { SETTINGS: 'settings' },
  openDatabase: async () => ({ close() {}, transaction: (store) => {
    assert.equal(store, 'settings')
    return { objectStore: () => ({
      get: (key) => ({ result: structuredClone(records.get(key)) }),
      put: (record) => { records.set(record.key, structuredClone(record)); return { result: record.key } },
      delete: (key) => { records.delete(key); return {} },
    }) }
  } }),
  requestToPromise: async (request) => request.result, transactionToPromise: async () => undefined,
}
const shareHelpers = load('src/shared/share-capture.ts', {}, { URL })
const networkHelpers = load('src/shared/network-capture.ts')
const preferences = load('src/db/conversation-capture-modes.ts', { './database': db, '../shared/share-capture': shareHelpers })
assert.equal(await preferences.getConversationCaptureMode('a'), null)
await preferences.setConversationCaptureMode('a', 'share')
assert.equal(await preferences.getConversationCaptureMode('a'), 'share')
assert.equal(await preferences.getConversationCaptureMode('b'), null)
assert.equal(records.get('app').chatgptCaptureMode, 'conversation')
assert.equal(await preferences.getConversationSaveMethod('a'), null)
await preferences.setConversationSaveMethod('a', 'network')
assert.equal(await preferences.getConversationSaveMethod('a'), 'network')
assert.equal(await preferences.getConversationCaptureMode('a'), 'share', 'Method changes preserve the old mode')
await preferences.setConversationCaptureMode('a', 'conversation')
assert.equal(await preferences.getConversationSaveMethod('a'), 'network', 'Mode changes preserve the independent method')
await preferences.setConversationCaptureMode('a', 'share')
await preferences.setConversationSaveMethod('a', null)
await assert.rejects(() => preferences.setConversationSaveMethod('a', 'invalid'), /Invalid save method/)
records.get('app').chatgptCaptureMode = 'share'
await preferences.setConversationCaptureMode('b', 'conversation')
assert.equal(await preferences.getConversationCaptureMode('b'), 'conversation')
assert.equal(await preferences.getConversationCaptureMode('a'), 'share')
await preferences.setConversationCaptureMode('a', null)
assert.equal(await preferences.getConversationCaptureMode('a'), null)
await assert.rejects(() => preferences.setConversationCaptureMode('a', 'invalid'), /Invalid capture mode/)
await assert.rejects(() => preferences.getConversationCaptureMode(''), /Invalid conversation ID/)
records.set('capture-mode:chatgpt:bad', { mode: 'invalid' })
assert.equal(await preferences.getConversationCaptureMode('bad'), null)
records.clear()
assert.equal(await preferences.getConversationCaptureMode('b'), null, 'Clear data must remove overrides')

// Render the actual controller and invoke its controls with deterministic
// hook/host substitutes. This checks routing, persistence, navigation and stale
// async replies without opening a real account or requiring a DOM dependency.
let defaults = { chatgptCaptureMode: 'conversation', autoSave: false, autoSavePlatforms: [], saveImages: false, fileSavePolicy: 'never' }
let pendingWrite = null
let pendingRead = null
let restoredStatus = null
let networkStatus = null
let networkCanControl = true
let savedConversation = null
let liveState = null
const saves = []
const networkActions = []
const shareActions = []
const sampleLink = 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const jsx = (type, props) => ({ type, props })
const progressComponent = load('src/panel/components/ShareCaptureProgress.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx }, '../../shared/share-capture': shareHelpers,
})
const headerComponent = load('src/panel/components/Header.tsx', { 'react/jsx-runtime': { jsx, jsxs: jsx } })
function panel(initialContext = { platform: 'chatgpt', conversationId: 'a' }) {
  const slots = [], effects = [], cleanups = []
  let index = 0, dirty = true, tree, contextListener, runtimeListener
  const hooks = {
    useState(initial) {
      const at = index++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (next) => {
        const value = typeof next === 'function' ? next(slots[at]) : next
        if (!Object.is(value, slots[at])) { slots[at] = value; dirty = true }
      }]
    },
    useRef(initial) { const at = index++; return slots[at] ??= { current: initial } },
    useEffect(effect, deps) {
      const at = index++
      if (!slots[at] || deps.some((value, i) => !Object.is(value, slots[at][i]))) {
        slots[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() })
      }
    },
  }
  const events = { addEventListener() {}, removeEventListener() {}, setTimeout: (callback, ms) => {
    if (ms === 120) void Promise.resolve().then(callback)
    return 1
  }, clearTimeout() {} }
  const { CurrentConversationPanel } = load('src/panel/pages/CurrentConversationPanel.tsx', {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../shared/models': { PLATFORM_LABELS: { chatgpt: 'ChatGPT', gemini: 'Gemini' } },
    '../../shared/extension-events': { isConversationUpdatedExtensionEvent: () => true },
    '../components/Header': headerComponent,
    '../components/ShareCaptureProgress': progressComponent,
    '../components/CaptureNotice': { CaptureNotice: 'capture-notice' },
    '../../shared/network-capture': networkHelpers,
    '../../shared/share-capture': shareHelpers,
    '../services/panel-api': {
      getSavedConversation: async () => savedConversation, getSettings: async () => ({ ...defaults }),
      getConversationCaptureMode: async (id) => {
        const mode = await preferences.getConversationCaptureMode(id)
        if (pendingRead) await pendingRead
        return mode
      },
      getConversationShareLink: preferences.getConversationShareLink,
      getConversationSaveMethod: preferences.getConversationSaveMethod,
      setConversationSaveMethod: preferences.setConversationSaveMethod,
      networkCaptureAction: async (...args) => { networkActions.push(args); return { status: networkStatus, paused: networkHelpers.isNetworkCaptureActive(networkStatus), canControl: networkCanControl } },
      setConversationShareLink: preferences.setConversationShareLink,
      setConversationCaptureMode: async (id, mode) => {
        if (pendingWrite) await pendingWrite
        return preferences.setConversationCaptureMode(id, mode)
      },
      shareCaptureAction: async (...args) => { shareActions.push(args); return { status: restoredStatus } },
    },
    '../services/host-bridge': {
      getInitialHostConversationContext: () => initialContext,
      subscribeHostConversationContext: (callback) => { contextListener = callback; return () => {} },
      subscribeHostConversationLiveState: (callback) => { if(liveState) callback(liveState); return () => {} }, requestHostConversationLiveState() {},
      saveCurrentHostConversation: async (...args) => { saves.push(args); return { ok: false, message: 'Synthetic save completed' } },
    },
  }, { window: events, document: { ...events, hidden: false }, chrome: { runtime: { onMessage: {
    addListener: (callback) => { runtimeListener = callback }, removeListener() {},
  } } } })
  function render() { index = 0; dirty = false; tree = CurrentConversationPanel(); for (const effect of effects.splice(0)) effect() }
  async function flush() { for (let i = 0; i < 30; i++) { if (dirty) render(); await Promise.resolve() } }
  function nodes(node) {
    if (arguments.length === 0) node = tree
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap((item) => nodes(item))
    if (typeof node.type === 'function') return nodes(node.type(node.props))
    return [node, ...(node.props?.children === undefined ? [] : nodes(node.props.children))]
  }
  return {
    flush, nodes,
    select: () => {
      const chosen = nodes().find((n) => n.props?.role === 'tab' && n.props['aria-selected'])
      return chosen ? { props: { value: chosen.props['data-capture-mode'], disabled: chosen.props.disabled } } : undefined
    },
    shareInput: () => nodes().find((n) => n.props?.id === 'share-capture-url'),
    change: (value) => {
      const method = nodes().find((n) => n.props?.role === 'tab' && n.props['aria-selected']).props['data-save-method']
      nodes().find((n) => n.props?.['data-capture-mode'] === value && n.props['data-save-method'] === method).props.onClick()
    },
    method: () => nodes().find((n) => n.props?.role === 'tab' && n.props['aria-selected'])?.props['data-save-method'],
    changeMethod: (value) => {
      const mode = nodes().find((n) => n.props?.role === 'tab' && n.props['aria-selected']).props['data-capture-mode']
      nodes().find((n) => n.props?.['data-save-method'] === value && n.props['data-capture-mode'] === mode).props.onClick()
    },
    navigate: (platform, conversationId) => contextListener({ platform, conversationId }),
    save: () => nodes().find((n) => n.type === 'button' && n.props.className === 'controller-primary-button').props.onClick(),
    refresh: () => runtimeListener({}),
    dispose: () => cleanups.forEach((cleanup) => cleanup?.()),
  }
}
let current = panel()
await current.flush()
assert.equal(current.select().props.value, 'conversation', 'An unset preference selects the actual default mode')
assert.deepEqual([...new Set(current.nodes().filter((n) => n.props?.role === 'tab').map((n) => n.props['data-capture-mode']))], ['conversation', 'share'], 'The tabs retain the two real capture modes')
assert.equal(current.nodes().filter((n) => n.props?.role === 'tablist').length, 1, 'One tab strip presents both capture preferences')
assert.equal(current.nodes().filter((n) => n.props?.role === 'tab').length, 4)
assert.equal(current.nodes().filter((n) => n.props?.role === 'tab' && n.props['aria-selected']).length, 1)
assert.equal(current.nodes().filter((n) => n.type === 'button' && n.props.children === '滑动采集').length, 1, 'There is one capture action')
assert.equal(current.shareInput(), undefined)
current.change('share')
await current.flush()
assert.equal(current.select().props.value, 'share')
assert.ok(current.shareInput())
assert.equal(defaults.chatgptCaptureMode, 'conversation')
assert.equal(saves.length, 0, 'Changing a mode must never start capture')
assert.equal(current.nodes().some((n) => n.type === 'select'), false, 'Capture modes use exclusive buttons instead of a dropdown')
current.shareInput().props.onChange({ target: { value: sampleLink } })
await current.flush()
assert.equal(await preferences.getConversationShareLink('a'), sampleLink)
current.navigate('chatgpt', 'a')
await current.flush()
assert.equal(current.shareInput().props.value, sampleLink, 'Repeated same-conversation context notifications cannot clear the input')
current.shareInput().props.onChange({ target: { value: sampleLink.slice(0, -3) } })
await current.flush()
current.refresh()
await current.flush()
assert.equal(current.shareInput().props.value, sampleLink.slice(0, -3), 'A background refresh cannot replace an unfinished edit with an older saved link')
current.shareInput().props.onChange({ target: { value: sampleLink } })
await current.flush()
current.save()
await current.flush()
assert.equal(saves.at(-1)[4], 'share', 'Manual save must use this conversation override')
current.dispose()
current = panel()
await current.flush()
assert.equal(current.select().props.value, 'share', 'Reopening the panel restores the choice')
assert.equal(current.shareInput().props.value, sampleLink, 'Reopening restores the original conversation link')
current.navigate('chatgpt', 'b')
await current.flush()
assert.equal(current.select().props.value, 'conversation')
assert.equal(current.shareInput(), undefined, 'Another conversation must not inherit the first override')
assert.equal(await preferences.getConversationShareLink('b'), null)
current.navigate('chatgpt', 'a')
await current.flush()
assert.equal(current.shareInput().props.value, sampleLink, 'Returning to the original conversation restores its own link')
defaults.chatgptCaptureMode = 'share'
current.dispose()
current = panel({ platform: 'chatgpt', conversationId: 'b' })
await current.flush()
assert.ok(current.shareInput(), 'An unset conversation follows the tool default')
assert.equal(current.select().props.value, 'share', 'The effective default highlights its matching mode button')
defaults.chatgptCaptureMode = 'conversation'
current.refresh()
await current.flush()
assert.equal(current.select().props.value, 'conversation', 'An unset preference follows later default changes without a third button')
defaults.chatgptCaptureMode = 'share'
current.refresh()
await current.flush()
current.change('conversation')
await current.flush()
assert.equal(current.shareInput(), undefined)
current.save()
await current.flush()
assert.equal(saves.at(-1)[4], 'conversation')
assert.equal(saves.at(-1)[3], undefined, 'Original capture must not forward a stale share link')
let releaseWrite, releaseRead
pendingWrite = new Promise((resolve) => { releaseWrite = resolve })
pendingRead = new Promise((resolve) => { releaseRead = resolve })
current.change('share')
await current.flush()
current.refresh()
await current.flush()
releaseWrite()
pendingWrite = null
await current.flush()
assert.equal(current.select().props.value, 'share')
releaseRead()
pendingRead = null
await current.flush()
assert.equal(current.select().props.value, 'share', 'An old read started during a preference write must not undo the new choice')
defaults.chatgptCaptureMode = 'conversation'
current.refresh()
await current.flush()
assert.equal(current.select().props.value, 'share', 'An explicit choice remains selected after the tool default changes')
assert.ok(current.shareInput())
let release
pendingWrite = new Promise((resolve) => { release = resolve })
current.change('conversation')
await current.flush()
assert.equal(current.select().props.disabled, true)
current.navigate('chatgpt', 'a')
await current.flush()
release()
await current.flush()
pendingWrite = null
assert.equal(current.select().props.value, 'share', 'A late preference write must not change the newly opened conversation')
current.navigate('gemini', 'gemini-a')
await current.flush()
assert.equal(current.select(), undefined, 'Unsupported share modes must not be offered')
current.dispose()
restoredStatus = { id: 'synthetic-job', conversationId: 'b', phase: 'scanning', messageCount: 12, progress: 48, message: 'Synthetic active task' }
current = panel({ platform: 'chatgpt', conversationId: 'b' })
await current.flush()
assert.equal(current.select().props.disabled, true, 'A restored share job locks mode changes')
current.change('share')
await current.flush()
assert.equal(await preferences.getConversationCaptureMode('b'), 'conversation')
assert.ok(current.nodes().some((n) => n.props.role === 'progressbar' && n.props['aria-label'] === '采集阶段进度' && n.props['aria-valuenow'] === 48), 'The scanner exposes its capture-stage estimate instead of a looping indeterminate progress element')
assert.ok(current.nodes().some((n) => n.props.className === 'capture-progress-fill' && n.props.style.width === '48%'), 'Reopening the panel must restore the collected stage progress')
assert.ok(current.nodes().some((n) => n.type === 'strong' && n.props.children.includes(12)), 'The progress display includes collected message count')
current.dispose()
restoredStatus = { ...restoredStatus, phase: 'needs-foreground', message: '请打开分享采集页并保持该页可见，完成后返回原对话' }
current = panel({ platform: 'chatgpt', conversationId: 'b' })
await current.flush()
assert.ok(current.nodes().some(node => node.type === 'strong' && node.props.children === '需要打开分享采集页继续'), 'A reopened paused job must explicitly state that the capture page needs attention')
const continueButton = current.nodes().find(node => node.type === 'button' && node.props.children === '打开分享页 ↗')
assert.ok(continueButton)
continueButton.props.onClick()
await current.flush()
assert.deepEqual(shareActions.at(-1), ['b', 'open', restoredStatus.id], 'The visible continuation action must activate the existing capture job')
assert.equal(current.select().props.disabled, true, 'A rendering pause must remain an active job rather than permit another capture')
current.dispose()
for (const phase of ['complete', 'failed', 'cancelled']) {
  restoredStatus = { ...restoredStatus, phase, message: `Synthetic ${phase} result` }
  current = panel({ platform: 'chatgpt', conversationId: 'b' })
  await current.flush()
  assert.ok(current.nodes().some((n) => n.type === 'p' && n.props.children === restoredStatus.message), 'Reopened panels must retain terminal task results')
  assert.equal(current.select().props.disabled, false, 'Finished tasks allow retry and mode changes')
  assert.equal(current.nodes().find((n) => n.props.role === 'progressbar')?.props['aria-valuenow'], phase === 'complete' ? 100 : undefined, 'Only confirmed saves display a full progress bar; failed and cancelled tasks retain their result without a loading bar')
  current.dispose()
}
restoredStatus = null
current = panel({ platform: 'chatgpt', conversationId: 'method-test' })
await current.flush()
assert.equal(current.method(), 'dom', 'Upgrades retain DOM as the independent default')
current.change('share')
await current.flush()
current.changeMethod('network')
await current.flush()
assert.equal(current.method(), 'network')
assert.equal(current.select().props.value, 'share', 'Switching method cannot reset mode')
const beforeNetworkSaves = saves.length
const beforeNetworkStarts = networkActions.filter((action) => action[1] === 'start').length
assert.equal(current.nodes().find((node) => node.props?.className === 'controller-primary-button').props.disabled, false, 'Network saving uses the same available capture button')
current.save()
await current.flush()
assert.equal(saves.length, beforeNetworkSaves, 'The network prototype must never enter the DOM save bridge')
assert.equal(networkActions.filter((action) => action[1] === 'start').length, beforeNetworkStarts + 1)
assert.equal(networkActions.at(-1)[3].operation, 'save', 'The regular interface action starts saving, never a no-save probe')
assert.equal(networkActions.at(-1)[3].mode, 'share')
current.change('conversation')
await current.flush()
assert.equal(current.method(), 'network', 'Switching mode cannot reset method')
current.save()
await current.flush()
assert.equal(networkActions.filter((action) => action[1] === 'start').length, beforeNetworkStarts + 2)
assert.equal(networkActions.at(-1)[3].mode, 'conversation')
current.dispose()
current = panel({ platform: 'chatgpt', conversationId: 'method-test' })
await current.flush()
assert.equal(current.method(), 'network', 'Independent method survives reopening')
current.dispose()
networkStatus = { id: 'network-job', conversationId: 'method-test', mode: 'share', method: 'network', phase: 'reading', message: '本次不保存对话', responseCount: 1, responseBytes: 100, largestResponseBytes: 100 }
current = panel({ platform: 'chatgpt', conversationId: 'method-test' })
await current.flush()
assert.equal(current.method(), 'network')
assert.equal(current.select().props.value, 'share', 'Restored tasks show their fixed mode, independent of later defaults')
assert.equal(current.select().props.disabled, true)
current.changeMethod('dom')
await current.flush()
assert.equal(await preferences.getConversationSaveMethod('method-test'), 'network', 'Active tasks lock both dimensions')
assert.ok(current.nodes().some((node) => node.props?.title === '接口连接验证 · 本次不保存'))
current.dispose()
networkCanControl = false
current = panel({ platform: 'chatgpt', conversationId: 'method-test' })
await current.flush()
assert.ok(current.nodes().some((node) => node.type === 'p' && typeof node.props.children === 'string' && node.props.children.includes('其他标签页采集')))
assert.equal(current.nodes().some((node) => node.props?.className === 'capture-task-actions'), false, 'Other tabs show the lock without owner controls')
current.dispose()
networkCanControl = true
for (const failedAttachmentCount of [0, 2]) {
  networkStatus = { ...networkStatus, id: `finished-${failedAttachmentCount}`, operation: 'save', phase: 'complete', bodySaved: true, failedAttachmentCount, message: 'Synthetic body saved with confirmed attachment outcomes' }
  current = panel({ platform: 'chatgpt', conversationId: 'method-test' })
  await current.flush()
  const notice=current.nodes().find(node=>node.type==='capture-notice')
  assert.equal(notice.props.tone,failedAttachmentCount ? 'warning' : 'success','Uncopied attachments cannot be displayed as an all-success network capture')
  if(failedAttachmentCount) {
    assert.match(notice.props.title,/正文已保存.*部分附件未复制/)
    assert.match(current.nodes().filter(node=>node.type==='summary').map(node=>node.props.children.flat().join('')).join(''),/部分附件未复制/,'Collapsed task history retains the partial-attachment outcome')
  }
  current.dispose()
}
await preferences.setConversationShareLink('a', null)
assert.equal(await preferences.getConversationShareLink('a'), null)
await assert.rejects(() => preferences.setConversationShareLink('a', 'https://example.test/share'), /链接格式/)
networkStatus = null
liveState = { context: { platform: 'chatgpt', conversationId: 'layout' }, pageTitle: 'Synthetic conversation title', pageMessageCount: 4,
  recentMessages: [{ role: 'user', content: 'Recent question' }, { role: 'assistant', content: 'Recent answer' }], syncStatus: 'observing', pinnedEvidence: false, lastSyncedAt: null }
current = panel(liveState.context)
await current.flush()
assert.ok(current.nodes().some(node => node.type === 'h1' && node.props.children === liveState.pageTitle), 'The top heading is the actual conversation title')
const identity = current.nodes().find(node => node.props?.['aria-label'] === '当前对话信息')
assert.ok(current.nodes(identity).some(node => node.type === 'h1' && node.props.children === liveState.pageTitle), 'The title shares one information block with platform and local status')
const scrollArea = current.nodes().find(node => node.type === 'main')
const footer = current.nodes().find(node => node.type === 'footer')
assert.ok(footer)
assert.equal(current.nodes(scrollArea).some(node => node.type === 'button' && node.props.children === '滑动采集'), false, 'The capture button lives outside the scrolling content')
assert.ok(current.nodes(footer).some(node => node.type === 'button' && node.props.children === '滑动采集'))
const scrollNodes = current.nodes(scrollArea)
assert.ok(scrollNodes.findIndex(node => node.props?.['aria-label'] === '采集设置') < scrollNodes.findIndex(node => node.props?.['aria-label'] === '网页最近内容'), 'Capture settings precede the bounded recent-message area')
assert.equal(current.nodes().filter(node => node.type === 'button' && node.props.children === 'Manager ↗').length, 1)
current.dispose()
liveState = null
networkStatus = { id: 'review-job', conversationId: 'method-test', mode: 'conversation', method: 'network', operation: 'save', phase: 'awaiting-confirmation',
  candidateCount: 17, candidateSource: 'network', issue: 'Synthetic mismatch', message: 'Waiting for your decision', responseCount: 1, responseBytes: 100, largestResponseBytes: 100 }
current = panel({ platform: 'chatgpt', conversationId: 'method-test' })
await current.flush()
const reviewFooter = current.nodes().find(node => node.type === 'footer')
const confirm = current.nodes(reviewFooter).find(node => node.type === 'button' && node.props.children === '确认保存为待补全')
assert.ok(confirm); assert.equal(confirm.props.disabled, false)
assert.ok(current.nodes(reviewFooter).some(node => node.type === 'button' && node.props.children === '取消'))
assert.ok(current.nodes().some(node => node.props?.tone === 'warning' && node.props.title === '采集异常 · 等待确认'))
assert.equal(current.nodes().some(node => node.type === 'button' && node.props.children === '打开分享页 ↗'), false)
confirm.props.onClick(); await current.flush()
assert.deepEqual(networkActions.at(-1).slice(0, 3), ['method-test', 'confirm', networkStatus.id])
current.dispose()
networkCanControl = false
current = panel({ platform: 'chatgpt', conversationId: 'method-test' }); await current.flush()
assert.equal(current.nodes().some(node => node.type === 'button' && node.props.children === '确认保存为待补全'), false, 'Other tabs cannot confirm the candidate')
current.dispose()
networkStatus = null; networkCanControl = true
savedConversation = { id: 'saved', title: 'Saved title', messageCount: 2, updatedAt: Date.now(), important: false,
  imageAttachmentPermission: false, fileAttachmentPermission: true, pendingCapture: { reason: 'Synthetic pending reason', source: 'page' } }
current = panel({ platform: 'chatgpt', conversationId: 'method-test' }); await current.flush()
assert.ok(current.nodes().some(node => node.type === 'span' && node.props.children === '待补全'))
assert.ok(current.nodes().some(node => node.type === 'button' && node.props.children === '滑动采集并补全'))
assert.ok(current.nodes().some(node => node.type === 'strong' && node.props.children === '这条对话待补全'))
current.dispose(); savedConversation = null
console.log('conversation capture mode verification passed: combined tabs, one capture action, independent defaults/preferences, DOM/network save routing and navigation')
