import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const selectorSource = readFileSync(
  join(root, 'src/adapters/gemini/selectors.ts'),
  'utf8',
)
const selectorJavaScript = ts.transpileModule(selectorSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText
const selectorModule = await import(
  `data:text/javascript;base64,${Buffer.from(selectorJavaScript).toString('base64')}`
)

const selectors = selectorModule.GEMINI_SELECTORS
const {
  getConversationTitleSelectors,
  isBetterGeminiConversationRoot,
  isUsefulGeminiConversationTitle,
  parseGeminiRenderedMessageOrder,
} = selectorModule
assert.equal(
  selectors.CHAT_CONTAINER.includes(
    'div#chat-history.chat-history-scroll-container',
  ),
  true,
  'The current Gemini outer history scroller must be recognized',
)
assert.equal(
  selectors.CHAT_CONTAINER.some((selector) =>
    selector.includes('conversation-container'),
  ),
  false,
  'A single Gemini turn must never be the chat extraction root',
)
assert.equal(
  selectors.CHAT_CONTAINER.includes(
    'infinite-scroller[data-test-id="chat-history-container"]',
  ),
  true,
)
assert.equal(
  selectors.CHAT_CONTAINER.includes(
    'chat-window-content > div.chat-history-scroll-container',
  ),
  true,
)
assert.equal(selectors.CHAT_CONTAINER.includes('main .chat-history'), true)
assert.equal(selectors.CHAT_CONTAINER.includes('main infinite-scroller'), true)
assert.equal(
  selectors.CHAT_CONTAINER.indexOf('main .chat-history') <
    selectors.CHAT_CONTAINER.indexOf('main'),
  true,
)
assert.equal(selectors.CONVERSATION_TURN.includes('.conversation-container'), true)
assert.equal(selectors.MESSAGE.includes('user-query'), true)
assert.equal(selectors.MESSAGE.includes('user-query-content'), true)
assert.equal(selectors.MESSAGE.includes('model-response'), true)
assert.equal(selectors.MESSAGE.includes('response-container'), true)
assert.equal(
  selectors.MESSAGE_ORDER.includes(
    'user-query-content[id^="user-query-content-"]',
  ),
  true,
  'Rendered user-query-content ids must remain available as message-order evidence',
)
assert.equal(parseGeminiRenderedMessageOrder('user-query-content-19'), 19)
assert.equal(parseGeminiRenderedMessageOrder('user-query-content-nope'), null)
assert.equal(selectors.SIDEBAR_SHELL.includes('bard-sidenav'), true)

globalThis.CSS = { escape: (value) => value }
const titleSelectors = getConversationTitleSelectors('title-test-id')
const conversationLinkSelectors = selectorModule.getConversationLinkSelectors(
  'title-test-id',
)
assert.equal(
  conversationLinkSelectors.some((selector) => /^a\[href/.test(selector)),
  false,
  'Gemini URL matching must never search unscoped account/navigation anchors',
)
assert.equal(
  conversationLinkSelectors.includes(
    'conversations-list gem-nav-list-item > a[href$="/app/title-test-id"]',
  ),
  true,
  'Current conversation anchors must be scoped to the rendered conversations list',
)
assert.equal(
  titleSelectors.some((selector) =>
    selector.endsWith('> a > span > span > span > span'),
  ),
  true,
  'The current four-span Gemini title structure must be supported',
)
assert.equal(
  titleSelectors.some((selector) => selector.endsWith(' .gds-label-l')),
  true,
  'Gemini label-only pinned rows must expose their rendered title',
)
assert.equal(
  titleSelectors.includes(
    'gem-nav-list-item[data-test-id="conversation"][jslog*="c_title-test-id"]',
  ),
  true,
  'A conversation-ID-bound row must remain the final title fallback',
)
for (const genericTitle of [
  'Gemini',
  'New chat',
  '新对话',
  '与 Gemini 对话',
  '與 Gemini 對話',
  'Chat with Gemini',
  'Google 账号： Example User (reader@example.com)',
  'Google Account: Example User (reader@example.com)',
]) {
  assert.equal(
    isUsefulGeminiConversationTitle(genericTitle),
    false,
    `Generic Gemini page title was accepted: ${genericTitle}`,
  )
}
assert.equal(
  isUsefulGeminiConversationTitle('SLG 游戏设计：借鉴竞技游戏'),
  true,
)

const diagnosticRootMetrics = [
  { turnCount: 0, messageCount: 0 },
  { turnCount: 10, messageCount: 40 },
]
const selectedRootMetrics = diagnosticRootMetrics.reduce(
  (current, candidate) =>
    isBetterGeminiConversationRoot(candidate, current) ? candidate : current,
  null,
)
assert.deepEqual(
  selectedRootMetrics,
  diagnosticRootMetrics[1],
  'The populated Gemini history must win when an earlier matching history is empty',
)
assert.equal(
  isBetterGeminiConversationRoot(
    { turnCount: 10, messageCount: 41 },
    { turnCount: 10, messageCount: 40 },
  ),
  true,
  'Message count must break ties between roots with the same turn count',
)

const adapterSource = readFileSync(
  join(root, 'src/adapters/gemini/gemini-adapter.ts'),
  'utf8',
)
// Public viewers put the prompt and answer in share-turn-viewer rather than
// conversation-container. Both roles must derive order from that same prompt;
// otherwise static shared histories cannot prove their first-message boundary.
const adapterExports = {}
const adapterCode = ts.transpileModule(adapterSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText
runInNewContext(adapterCode, { exports: adapterExports, require(name) {
  if (name === '../base-adapter') return { BaseAdapter: class {} }
  if (name === './selectors') return selectorModule
  if (name === '../attachment-candidates' || name === '../dom-scroll-collector') return {}
  throw new Error(`Unexpected adapter dependency ${name}`)
} })
const publicAdapter = new adapterExports.GeminiAdapter()
for (const turnIndex of [0, 3, 17]) {
  const turn = { getAttribute: () => null }
  const prompt = { getAttribute: (name) => name === 'id' ? `user-query-content-${turnIndex}` : null }
  const node = (role) => ({
    getAttribute: () => null,
    closest: (selector) => selector.split(',').map((value) => value.trim()).includes('share-turn-viewer') ? turn : null,
    role,
  })
  publicAdapter.queryFirst = (_selectors, root) => root === turn || root.role === 'user' ? prompt : null
  assert.equal(publicAdapter.readSourceMetadata(node('user'), 'user').sourceOrder, turnIndex * 2)
  assert.equal(publicAdapter.readSourceMetadata(node('assistant'), 'assistant').sourceOrder, turnIndex * 2 + 1)
}
assert.match(adapterSource, /GEMINI_SELECTORS\.CONVERSATION_TURN/)
assert.match(adapterSource, /turns\.flatMap\(\(turn\) =>/)
assert.match(adapterSource, /return this\.readMessageEntriesFromRoot\(container\)/)
assert.match(
  adapterSource,
  /messageEntries\.map\(\(\{ root(?:, message)? \}, messageIndex\)/,
  'Gemini attachment candidates must retain the rendered message identity when available',
)
assert.match(adapterSource, /candidate\.contains\(element\)/)
assert.match(adapterSource, /for \(const selector of GEMINI_SELECTORS\.CHAT_CONTAINER\)/)
assert.match(adapterSource, /for \(const candidate of this\.queryAll\(\[selector\]\)\)/)
assert.match(adapterSource, /isBetterGeminiConversationRoot\(metrics, bestMetrics\)/)
assert.match(adapterSource, /bestMetrics\.turnCount === 0/)
assert.match(adapterSource, /bestMetrics\.messageCount === 0/)
assert.match(adapterSource, /return this\.queryFirst\(\[/)
assert.match(adapterSource, /getConversationObservationContainer\(\)/)
assert.match(adapterSource, /getContainer: \(\) => this\.getConversationContainer\(\)/)
assert.match(adapterSource, /conversationContainer\.closest\('main'\)/)
assert.match(adapterSource, /readSidebarConversationTitle\(conversationId\)/)
assert.match(adapterSource, /GEMINI_SELECTORS\.SIDEBAR_SHELL\.join\(','\)/)
assert.match(
  adapterSource,
  /GENERIC_MESSAGE_METADATA/,
  'Generic data-testid values must not become the identity of every Gemini turn',
)
assert.match(adapterSource, /data-turn-index/)
assert.match(adapterSource, /data-message-index/)
assert.match(
  adapterSource,
  /meaningfulMetadata\(turn\?\.getAttribute\('id'\)/,
  'Gemini conversation-container ids must anchor virtualized windows',
)
assert.match(
  adapterSource,
  /parseGeminiRenderedMessageOrder\(/,
  'Gemini prompt ids must contribute a deterministic rendered order',
)
assert.match(adapterSource, /roleOffset = role === 'assistant' \? 1 : 0/)

const collectorSource = readFileSync(
  join(root, 'src/adapters/dom-scroll-collector.ts'),
  'utf8',
)
assert.match(collectorSource, /collectConversationByScrolling/)
assert.match(collectorSource, /mergeUnanchoredWindow/)
assert.match(
  collectorSource,
  /if \(!identityOverlap && overlap === 0\) \{\s*return null/,
  'A disjoint Gemini window must trigger backfill instead of false concatenation',
)
assert.match(
  collectorSource,
  /if \(direction === 1\)[\s\S]*?else \{[\s\S]*?incomingMessages\.slice\(0, incomingMessages\.length - overlap\)/,
  'An anchored reverse Gemini window must prepend only its older portion',
)
assert.match(collectorSource, /querySelectorAll\('\*'\)/)
assert.match(
  collectorSource,
  /targets\.includes\(container\)[\s\S]*?return container/,
  'The selected Gemini history scroller must win over an inner content layer',
)
assert.match(
  collectorSource,
  /captureComplete: finalCaptureComplete/,
  'Complete collection must expose whether both scroll boundaries were reached',
)
assert.doesNotMatch(
  collectorSource,
  /COMPLETE_CAPTURE_MAX_DURATION_MS/,
  'The main virtual-list traversal must not stop at a fixed duration',
)
assert.doesNotMatch(
  collectorSource,
  /COMPLETE_CAPTURE_MAX_STEPS/,
  'Complete traversal must not stop at a fixed number of viewport steps',
)
assert.match(
  collectorSource,
  /getRenderedTurnCoverage\(container, turnSelector\)/,
  'Complete traversal must adapt its step to the mounted message coverage',
)
assert.match(
  collectorSource,
  /renderedCoverage \* COMPLETE_CAPTURE_RENDERED_COVERAGE_RATIO/,
  'Adaptive steps must retain overlap between adjacent rendered windows',
)
assert.match(
  collectorSource,
  /retryDistance \/ 2/,
  'A discontinuous adaptive step must be bisected until its gap is filled',
)
assert.match(
  collectorSource,
  /metrics\.viewport \* COMPLETE_CAPTURE_MAX_STEP_RATIO/,
  'Adaptive steps must remain capped for unusually large rendered roots',
)
assert.match(
  collectorSource,
  /stableBoundaryRounds >= COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS/,
  'A virtual-list boundary must remain stable before capture is complete',
)
assert.match(
  collectorSource,
  /stableStartRounds < COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS/,
  'The starting bottom boundary must stabilize before the upward pass',
)
assert.match(
  collectorSource,
  /target === window \|\| \(target as Element\)\.isConnected/,
  'A replaced host scroll root must not be mistaken for a completed boundary',
)
assert.match(
  collectorSource,
  /getContainer\(\) === activeContainer/,
  'A sweep must stop and rebind when the adapter selects a replacement history root',
)
assert.match(
  collectorSource,
  /count === previousCount && maximumStable/,
  'Boundary stability must include both message count and scroll range',
)
assert.match(
  collectorSource,
  /orderedTargets = \[[\s\S]*?targets\.filter\(\(target\) => target !== primary\)/,
  'A stalled host wrapper must fall back to the remaining scroll roots',
)
assert.match(
  collectorSource,
  /const sweep = await sweepScrollTarget\([\s\S]*?sweep\.reachedBoundary[\s\S]*?sweep\.observedWindowChange/,
  'A stable top may complete capture only after the target changes rendered windows',
)
assert.match(
  collectorSource,
  /const sourceOrderGap = hasKnownSourceOrderGap\([\s\S]*?collected\.messages,[\s\S]*?renderedSourceOrderGapBridges[\s\S]*?!sourceOrderGap/,
  'An unbridged stable source-order hole must fail the final complete-capture gate',
)
assert.doesNotMatch(
  collectorSource,
  /captureComplete = reachedBottom && reachedTop && reachedBottomAgain/,
  'Complete capture must not require a redundant third boundary pass',
)
assert.match(
  collectorSource,
  /renderedWindowSignature\([\s\S]*?sourceMessageId \?\? message\.sourceTurnId/,
  'Virtual-list window signatures must include stable rendered message identity',
)
assert.match(collectorSource, /edgeTurn\.scrollIntoView\(/)
assert.match(collectorSource, /block: direction === 1 \? 'start' : 'end'/)
assert.match(
  collectorSource,
  /const bottom = await walkRenderedEdge\([\s\S]*?\n\s*1,[\s\S]*?const top = await walkRenderedEdge\([\s\S]*?\n\s*-1,/,
  'The fallback must collect a suffix below the starting window before walking to the top',
)
assert.doesNotMatch(collectorSource, /restoreScrollPosition/)
assert.doesNotMatch(
  collectorSource,
  /backend-api\/conversation|localStorage|sessionStorage|chrome\.cookies/,
  'Gemini complete capture must remain DOM-only',
)

const conversationServiceSource = readFileSync(
  join(root, 'src/services/conversation-service.ts'),
  'utf8',
)
assert.match(conversationServiceSource, /existingWithMetadata/)
assert.match(
  conversationServiceSource,
  /createContentHash\(title, existing\.messages, existing\.attachments\)/,
)
assert.match(
  conversationServiceSource,
  /mergeRenderedConversationMessages\(/,
  'Gemini virtual-history windows must use conservative overlap merging',
)

const observerSource = readFileSync(
  join(root, 'src/content/conversation-observer.ts'),
  'utf8',
)
assert.match(
  adapterSource,
  /!isOpaqueResourceName\(name\)/,
  'Opaque rendered resource ids must not survive as Gemini attachment names',
)
assert.match(observerSource, /adapter\.getConversationObservationContainer\(\)/)
assert.match(
  observerSource,
  /const next = merged \?\? \([\s\S]*?previous \?\? \{/,
  'An unanchored post-sweep window must keep the accumulated copy',
)
assert.match(
  observerSource,
  /failure: complete\.captureComplete === true[\s\S]*?complete\.captureIncompleteReason \?\? 'boundary'/,
  'Every complete-save trigger must fail closed unless the sweep verifies its boundaries',
)
assert.match(
  observerSource,
  /incoming\.captureComplete === true[\s\S]*?mergeCompleteConversationMessages/,
  'A confirmed complete sweep must authoritatively replace a stale partial window',
)
assert.match(
  observerSource,
  /this\.clearDebounce\(\)\s*this\.captureRevision \+= 1/,
  'An explicit sweep must invalidate queued passive captures before scrolling',
)

console.log('Gemini multi-turn capture verification passed')
