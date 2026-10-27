import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const descriptorSource = readFileSync(
  join(root, 'src/adapters/pin-descriptors.ts'),
  'utf8',
)
const descriptorJavaScript = ts.transpileModule(descriptorSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText
const descriptorModule = await import(
  `data:text/javascript;base64,${Buffer.from(descriptorJavaScript).toString('base64')}`
)

const pinActions = [
  'Pin',
  'Pin chat',
  'Pin this conversation',
  'pin-chat',
  'push_pin\nPin',
  '置顶',
  '置頂對話',
  '固定',
  '固定聊天',
]
const unpinActions = [
  'Unpin',
  'unpin-chat',
  'Remove pin',
  'keep_off',
  '取消置顶',
  '取消置頂',
  '解除置顶',
  '取消固定',
  '已置顶',
]

for (const descriptor of pinActions) {
  assert.equal(
    descriptorModule.isPinActionDescriptor(descriptor),
    true,
    `Expected a pin action: ${descriptor}`,
  )
  assert.equal(
    descriptorModule.isUnpinActionDescriptor(descriptor),
    false,
    `Pin action was classified as unpin: ${descriptor}`,
  )
}
for (const descriptor of unpinActions) {
  assert.equal(
    descriptorModule.isPinActionDescriptor(descriptor),
    false,
    `Unpin action was classified as pin: ${descriptor}`,
  )
  assert.equal(
    descriptorModule.isUnpinActionDescriptor(descriptor),
    true,
    `Expected an unpin action: ${descriptor}`,
  )
}

for (const descriptor of [
  'pinned',
  'conversation-pinned',
  'unpin',
  'keep_off',
  '已置顶',
  '取消固定',
]) {
  assert.equal(
    descriptorModule.isPinnedDescriptor(descriptor),
    true,
    `Expected pinned-state evidence: ${descriptor}`,
  )
}
for (const descriptor of ['unpinned', 'not-pinned', '未置顶', '未固定']) {
  assert.equal(
    descriptorModule.isPinnedDescriptor(descriptor),
    false,
    `Unpinned state was classified as pinned: ${descriptor}`,
  )
}

const observerSource = readFileSync(
  join(root, 'src/content/conversation-observer.ts'),
  'utf8',
)
assert.match(observerSource, /event\.composedPath\(\)/)
assert.match(observerSource, /new Map<string, number>\(\)/)
assert.match(observerSource, /getConversationIdFromTarget/)
assert.match(observerSource, /PIN_RETRY_DELAYS_MS/)
assert.match(observerSource, /isUnpinActionTarget/)
assert.match(observerSource, /UPDATE_CONVERSATION_PINNED/)
assert.match(observerSource, /type ConversationCaptureTrigger = 'passive' \| 'manual' \| 'pin'/)
assert.match(observerSource, /private collectCompleteConversation\(/)
assert.match(
  observerSource,
  /saveCurrentConversation\([\s\S]*?this\.collectCompleteConversation\(/,
  'Manual update must use the shared complete collector',
)
assert.match(
  observerSource,
  /capturePinnedConversationCompletely\([\s\S]*?this\.collectCompleteConversation\(/,
  'A native-pin first save must use the same complete collector as manual update',
)
assert.equal(
  observerSource.match(/adapter\.collectConversation\(/g)?.length,
  1,
  'Host complete collection must have exactly one orchestration call site',
)
for (const trigger of ['passive', 'manual', 'pin']) {
  assert.match(
    observerSource,
    new RegExp(`trigger: '${trigger}'`),
    `Expected ${trigger} capture to enter the shared persistence queue`,
  )
}
assert.match(
  observerSource,
  /trigger === 'passive'[\s\S]*?pinnedCompleteCaptureRequired[\s\S]*?HAS_SAVED_CONVERSATION[\s\S]*?schedulePinExtractionRetries/,
  'A pin-owned first save must block racing passive snapshots',
)
assert.match(
  observerSource,
  /pinnedCompleteCaptureForced\.add\(pinnedConversationId\)[\s\S]*?const forceComplete = this\.pinnedCompleteCaptureForced\.has\([\s\S]*?if \(forceComplete \|\| !alreadySaved\)/,
  'A passive write landing after the pin click must not cancel the required full scan',
)
assert.match(
  observerSource,
  /completeSnapshotVerified && extracted\.captureComplete !== true[\s\S]*?return null/,
  'A full-save request must not fall through to partial persistence',
)
assert.match(
  observerSource,
  /const attachmentSnapshotComplete = completeSnapshotVerified &&[\s\S]*?captureSnapshotComplete: true/,
  'The verified native-pin snapshot must carry authoritative history/attachment markers',
)
const persistenceStart = observerSource.indexOf('private async performConversationSave(')
const persistenceEnd = observerSource.indexOf(
  'private accumulateExtractedConversation(',
  persistenceStart,
)
assert.ok(persistenceStart >= 0 && persistenceEnd > persistenceStart)
assert.equal(
  observerSource.match(/type: RUNTIME_MESSAGE_TYPE\.SAVE_CONVERSATION/g)?.length,
  2,
  'Page capture must expose no SAVE_CONVERSATION bypass outside text/attachment writes',
)
assert.equal(
  observerSource
    .slice(persistenceStart, persistenceEnd)
    .match(/type: RUNTIME_MESSAGE_TYPE\.SAVE_CONVERSATION/g)?.length,
  2,
  'Both current-page persistence writes must stay in the shared save function',
)
assert.doesNotMatch(
  observerSource,
  /settings\.autoSavePinnedOnly\s*&&\s*this\.adapter\.supportsPinnedConversations\(\)/,
)

const autoSavePolicySource = readFileSync(
  join(root, 'src/content/auto-save-policy.ts'),
  'utf8',
)
const autoSavePolicyJavaScript = ts.transpileModule(autoSavePolicySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText
const autoSavePolicy = await import(
  `data:text/javascript;base64,${Buffer.from(autoSavePolicyJavaScript).toString('base64')}`
)
assert.equal(
  autoSavePolicy.canAutomaticallyCaptureConversation(true, false, false),
  false,
  'Reloading on a new unpinned conversation must not insert it',
)
assert.equal(
  autoSavePolicy.canAutomaticallyCaptureConversation(true, false, true),
  true,
  'A manually saved unpinned conversation must still receive updates',
)
assert.equal(
  autoSavePolicy.canAutomaticallyCaptureConversation(true, true, false),
  true,
  'Explicit pinned evidence must allow first-time insertion',
)

for (const adapterPath of [
  'src/adapters/chatgpt/chatgpt-adapter.ts',
  'src/adapters/gemini/gemini-adapter.ts',
]) {
  const adapterSource = readFileSync(join(root, adapterPath), 'utf8')
  assert.match(adapterSource, /getConversationIdFromTarget/)
  assert.match(
    adapterSource,
    /supportsPinnedConversations\(\): boolean \{\s*return true\s*\}/,
  )
  assert.match(adapterSource, /hasRenderedPinnedConversation/)
}

const geminiSelectors = readFileSync(
  join(root, 'src/adapters/gemini/selectors.ts'),
  'utf8',
)
assert.match(geminiSelectors, /gem-nav-list-item/)
assert.match(geminiSelectors, /chats-expandable-section/)
assert.match(geminiSelectors, /INLINE_PIN_INDICATOR/)
assert.match(geminiSelectors, /trailing-icon-container/)
assert.match(geminiSelectors, /data-mat-icon-name=\"push_pin\"/)
const baseAdapterSource = readFileSync(
  join(root, 'src/adapters/base-adapter.ts'),
  'utf8',
)
assert.match(baseAdapterSource, /\.\.\.PIN_ICON_CANDIDATES, \.\.\.inlinePinSelectors/)
assert.doesNotMatch(
  baseAdapterSource,
  /inlinePinSelectors\.length > 0\s*&&\s*this\.queryFirst\(inlinePinSelectors, current\) !== null/,
  'An arbitrary element at the Gemini pin-icon position is not pinned evidence',
)
assert.match(baseAdapterSource, /isExplicitPinnedSection/)
assert.match(baseAdapterSource, /CONVERSATION_COLLECTION_BOUNDARY_SELECTOR/)
assert.match(baseAdapterSource, /current !== link/)
assert.match(
  baseAdapterSource,
  /this\.queryAll\(collectionConversationSelectors, current\)\.length > 1/,
)
assert.doesNotMatch(
  baseAdapterSource,
  /this\.queryAll\(conversationSelectors, current\)\.length > 1/,
  'Current-ID selectors cannot detect a sibling conversation row',
)
const settingsSource = readFileSync(join(root, 'src/db/settings.ts'), 'utf8')
assert.match(settingsSource, /autoSavePinnedOnly: true/)
assert.match(settingsSource, /autoSavePolicyVersion: 1/)
assert.match(settingsSource, /autoSavePolicyVersion === 0\s*\? true/)
const geminiSelectorJavaScript = ts.transpileModule(geminiSelectors, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText
const geminiSelectorModule = await import(
  `data:text/javascript;base64,${Buffer.from(geminiSelectorJavaScript).toString('base64')}`
)
assert.equal(
  geminiSelectorModule.parseGeminiConversationIdFromJslog(
    '123;["c_abc-DEF_123","conversation"]',
  ),
  'abc-DEF_123',
)
assert.equal(geminiSelectorModule.parseGeminiConversationIdFromJslog('no conversation'), null)
globalThis.CSS = { escape: (value) => value }
assert.equal(
  geminiSelectorModule
    .getConversationLinkSelectors('abc-DEF_123')
    .some((selector) => selector.includes('gem-nav-list-item')),
  true,
)
assert.equal(
  geminiSelectorModule
    .getConversationLinkSelectors('5d6e3cce9faba43a')
    .includes(
      'conversations-list gem-nav-list-item > a[href*="/app/5d6e3cce9faba43a?"]',
    ),
  true,
  'The current /u/<account>/app/<id>?pageId=none Gemini row must be scoped and matched',
)
const deepSeekAdapter = readFileSync(
  join(root, 'src/adapters/deepseek/deepseek-adapter.ts'),
  'utf8',
)
assert.match(
  deepSeekAdapter,
  /supportsPinnedConversations\(\): boolean \{\s*return false\s*\}/,
)

const serviceWorkerSource = readFileSync(
  join(root, 'src/background/service-worker.ts'),
  'utf8',
)
assert.match(
  serviceWorkerSource,
  /updateConversationPinnedBySource\([\s\S]*?for \(const conversation of conversations\) \{\s*notifyConversationUpdated\(conversation\.id\)/,
  'A metadata-only pin update must notify open extension views too',
)

console.log('pinned capture verification passed')
