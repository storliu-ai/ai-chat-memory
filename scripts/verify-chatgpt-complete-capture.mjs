import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (path) => readFileSync(join(root, path), 'utf8')
const toDataModule = (source) => {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}

const reconciliation = await import(toDataModule(
  readSource('src/shared/conversation-reconciliation.ts'),
))
const continuity = await import(toDataModule(
  readSource('src/shared/capture-continuity.ts'),
))

assert.equal(
  continuity.hasCompleteScrollBoundaryEvidence(true, false, false, true, true),
  false,
  'A scrollable wrapper with an unchanged unknown window must not prove completeness',
)
assert.equal(
  continuity.hasCompleteScrollBoundaryEvidence(true, true, false, false, false),
  true,
  'A target that traversed rendered windows may prove the two boundaries',
)
assert.equal(
  continuity.hasCompleteUnscrollableHistoryEvidence(true, false, false),
  false,
  'A non-scrollable partial window must not be certified merely because it is continuous',
)

const message = (role, order, turnId, content) => ({
  role,
  content,
  sourceOrder: order,
  sourceTurnId: turnId,
})

const firstSparseWindow = [
  message('user', 1, 'turn-1', '问题 1'),
  message('assistant', 2, 'turn-2', '回答 1'),
  message('assistant', 36, 'turn-36', '回答 36'),
  message('user', 37, 'turn-37', '问题 37'),
]
const middleSparseWindow = [
  message('assistant', 28, 'turn-28', '回答 28'),
  message('assistant', 36, 'turn-36', '回答 36'),
  message('user', 37, 'turn-37', '问题 37'),
]
const merged = reconciliation.mergeRenderedConversationMessages(
  firstSparseWindow,
  middleSparseWindow,
)
assert.equal(merged.status, 'merged')
assert.deepEqual(
  merged.messages.map(({ sourceOrder }) => sourceOrder),
  [1, 2, 28, 36, 37],
  'Stable turn order must retain an assistant-first middle window',
)

const adapterSource = readSource('src/adapters/chatgpt/chatgpt-adapter.ts')
assert.match(adapterSource, /async collectConversation\(/)
assert.match(adapterSource, /collectConversationByScrolling/)
assert.match(adapterSource, /getContainer: \(\) => this\.getConversationContainer\(\)/)
assert.match(adapterSource, /CHATGPT_SELECTORS\.MESSAGE_TURN\.join\(','\)/)
const collectorSource = readSource('src/adapters/dom-scroll-collector.ts')
assert.match(collectorSource, /COMPLETE_CAPTURE_SETTLE_MS/)
assert.match(collectorSource, /scrollTop = top/)
assert.match(collectorSource, /scrollIntoView\(/)
assert.match(
  collectorSource,
  /const bottom = await walkRenderedEdge\([\s\S]*?\n\s*1,[\s\S]*?const top = await walkRenderedEdge\([\s\S]*?\n\s*-1,/,
  'The edge fallback must verify the newest boundary before ending at the oldest boundary',
)
assert.match(collectorSource, /haveContinuousRenderedWindows/)
assert.match(collectorSource, /hasKnownSourceOrderGap/)
assert.match(collectorSource, /getRenderedSourceOrderGapBridges/)
assert.match(collectorSource, /renderedSourceOrderGapBridges/)
assert.match(collectorSource, /hasKnownSourceOrderPrefixGap/)
assert.match(collectorSource, /nudgeScrollBoundary\(target, direction\)/)
assert.match(collectorSource, /captureIncompleteReason: sourceOrderGap \? 'gap'/)
assert.match(
  collectorSource,
  /COMPLETE_CAPTURE_BOUNDARY_SETTLE_MS = 1_000/,
  'A top boundary must wait for delayed history batches before completing',
)
assert.match(
  collectorSource,
  /const latestContainer = getContainer\(\)[\s\S]*?latestContainer !== activeContainer/,
  'A replaced ChatGPT scroll root must be rebound during the same capture',
)
assert.doesNotMatch(collectorSource, /ScrollPositionSnapshot|restoreScrollPosition/)
assert.match(
  collectorSource,
  /sweep\.reachedBoundary[\s\S]*?sweep\.observedWindowChange/,
  'Static scroll geometry must not bypass rendered-window activity checks',
)
assert.match(collectorSource, /renderedHistoryFitsWithoutScrolling/)
assert.match(collectorSource, /COMPLETE_CAPTURE_MIN_RETRY_STEP_PX = 12/)
assert.match(collectorSource, /COMPLETE_CAPTURE_CONTINUITY_RECOVERY_ROUNDS/)
assert.match(collectorSource, /COMPLETE_CAPTURE_MAX_STALLED_ROUNDS = 5/)
assert.match(collectorSource, /stalledStartRounds >= COMPLETE_CAPTURE_MAX_STALLED_ROUNDS/)
assert.match(collectorSource, /stalledBoundaryRounds >= COMPLETE_CAPTURE_MAX_STALLED_ROUNDS/)
assert.match(collectorSource, /isLikelyScrollController\(container\)/)
assert.match(collectorSource, /getComputedStyle\(target as Element\)\.overflowY/)
assert.doesNotMatch(collectorSource, /COMPLETE_CAPTURE_POST_WALK_MAX_DURATION_MS/)
assert.doesNotMatch(
  `${adapterSource}\n${collectorSource}`,
  /backend-api\/conversation|credentials|chrome\.cookies|localStorage|sessionStorage/,
  'The complete collector must remain DOM-only',
)

const modelSource = readSource('src/shared/models.ts')
assert.match(modelSource, /sourceTurnId\?: string/)
assert.match(modelSource, /sourceMessageId\?: string/)
assert.match(modelSource, /sourceOrder\?: number/)

const observerSource = readSource('src/content/conversation-observer.ts')
assert.match(observerSource, /private readonly accumulatedCaptures = new Map/)
assert.match(observerSource, /queueRenderedWindowCapture\(\)/)
assert.match(observerSource, /private collectCompleteConversation\(/)
assert.match(observerSource, /const complete = await adapter\.collectConversation\(/)
assert.match(observerSource, /completeCaptureInProgress/)
assert.match(
  observerSource,
  /complete === null \|\|[\s\S]*?failure: complete\.captureComplete === true[\s\S]*?complete\.captureIncompleteReason \?\? 'boundary'/,
  'A missing or unconfirmed complete scan must never fall through to a partial manual save',
)
assert.match(observerSource, /扫描结果仍存在消息序号缺口/)
assert.match(observerSource, /HAS_SAVED_CONVERSATION/)
assert.match(observerSource, /renderedMessages\.every\(hasStableMessageIdentity\)/)
assert.match(
  observerSource,
  /incoming\.captureComplete === true[\s\S]*?incoming\.attachmentCandidates \?\? \[\]/,
  'A verified complete snapshot must discard unmatched partial attachment candidates',
)

const serviceSource = readSource('src/services/conversation-service.ts')
assert.match(serviceSource, /hasStableMessageIdentity/)

console.log('ChatGPT complete DOM capture verification passed')
