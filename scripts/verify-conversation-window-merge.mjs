import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(
  join(root, 'src/shared/conversation-reconciliation.ts'),
  'utf8',
)
const javaScript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText
const reconciliation = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
)
const continuitySource = readFileSync(
  join(root, 'src/shared/capture-continuity.ts'),
  'utf8',
)
const continuityJavaScript = ts.transpileModule(continuitySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText
const continuity = await import(
  `data:text/javascript;base64,${Buffer.from(continuityJavaScript).toString('base64')}`
)

const message = (role, content, extra = {}) => ({ role, content, ...extra })
const firstWindow = [
  message('user', '问题 1：制定计划'),
  message('assistant', '回答 1：计划内容'),
  message('user', '问题 2：补充限制'),
  message('assistant', '回答 2：补充内容', {
    sentAt: Date.UTC(2026, 7, 20, 10, 30),
    sentAtPrecision: 'minute',
  }),
]
const laterWindow = [
  message('user', '问题 2：补充限制'),
  message('assistant', '回答 2：补充内容'),
  message('user', '问题 3：给出结论'),
  message('assistant', '回答 3：最终结论'),
]

const appended = reconciliation.mergeRenderedConversationMessages(
  firstWindow,
  laterWindow,
)
assert.equal(appended.status, 'merged')
assert.equal(appended.existingStartIndex, 0)
assert.equal(appended.incomingStartIndex, 2)
assert.deepEqual(
  appended.messages.map(({ role, content }) => ({ role, content })),
  [...firstWindow, ...laterWindow.slice(2)].map(({ role, content }) => ({ role, content })),
  'A later virtual window must append only messages after its overlap',
)

assert.equal(
  continuity.haveContinuousRenderedWindows(
    laterWindow,
    firstWindow,
    -1,
    6,
  ),
  true,
  'Overlapping reverse windows must be accepted without reducing the fast step',
)
assert.equal(
  continuity.haveContinuousRenderedWindows(
    laterWindow,
    [
      message('user', '完全跳过中间窗口的问题'),
      message('assistant', '完全跳过中间窗口的回答'),
    ],
    -1,
    6,
  ),
  false,
  'Disjoint identity-less windows must trigger a smaller retry step',
)
const adjacentOrdered = [
  message('user', '顺序问题 8', { sourceTurnId: 'turn-8', sourceOrder: 8 }),
  message('assistant', '顺序回答 9', { sourceTurnId: 'turn-9', sourceOrder: 9 }),
]
const laterOrdered = [
  message('user', '顺序问题 10', { sourceTurnId: 'turn-10', sourceOrder: 10 }),
  message('assistant', '顺序回答 11', { sourceTurnId: 'turn-11', sourceOrder: 11 }),
]
assert.equal(
  continuity.haveContinuousRenderedWindows(laterOrdered, adjacentOrdered, -1, 4),
  true,
  'Adjacent stable source orders may join without textual overlap',
)
assert.equal(
  continuity.haveContinuousRenderedWindows(
    laterOrdered,
    [
      message('user', '顺序问题 4', { sourceTurnId: 'turn-4', sourceOrder: 4 }),
      message('assistant', '顺序回答 5', { sourceTurnId: 'turn-5', sourceOrder: 5 }),
    ],
    -1,
    4,
  ),
  false,
  'A stable source-order hole must trigger backfill instead of sparse success',
)
assert.equal(
  continuity.haveContinuousRenderedWindows(
    laterOrdered,
    [
      message('user', '顺序问题 4', { sourceTurnId: 'turn-4', sourceOrder: 4 }),
      message('assistant', '顺序回答 5', { sourceTurnId: 'turn-5', sourceOrder: 5 }),
      laterOrdered[1],
    ],
    -1,
    4,
  ),
  false,
  'A sticky overlapping turn must not hide a gap before newly discovered orders',
)
const directlyRenderedSparseWindow = [
  message('user', '稀疏问题 0', { sourceTurnId: 'sparse-0', sourceOrder: 0 }),
  message('assistant', '稀疏回答 1', { sourceTurnId: 'sparse-1', sourceOrder: 1 }),
  message('user', '稀疏问题 2', { sourceTurnId: 'sparse-2', sourceOrder: 2 }),
  message('assistant', '稀疏回答 6', { sourceTurnId: 'sparse-6', sourceOrder: 6 }),
  message('user', '稀疏问题 7', { sourceTurnId: 'sparse-7', sourceOrder: 7 }),
  message('assistant', '稀疏回答 8', { sourceTurnId: 'sparse-8', sourceOrder: 8 }),
]
const renderedSparseBridges = new Set(
  continuity.getRenderedSourceOrderGapBridges(directlyRenderedSparseWindow),
)
assert.deepEqual([...renderedSparseBridges], ['2:6'])
assert.equal(
  continuity.haveContinuousRenderedWindows(
    directlyRenderedSparseWindow.slice(3),
    directlyRenderedSparseWindow,
    -1,
    directlyRenderedSparseWindow.length,
  ),
  true,
  'A stable DOM window with a substantial neighborhood on both sides may prove a native sparse order',
)
assert.equal(
  continuity.hasKnownSourceOrderGap(
    directlyRenderedSparseWindow,
    renderedSparseBridges,
  ),
  false,
  'A directly rendered native order hole must not reject a boundary-complete capture',
)
assert.equal(
  continuity.hasKnownSourceOrderGap(directlyRenderedSparseWindow),
  true,
  'The same sparse order without direct rendered evidence must remain unsafe',
)
const oneSlotNativeWindow = [
  message('user', '仅用户消息 0', { sourceTurnId: 'single-0', sourceOrder: 0 }),
  message('user', '下一条用户消息 2', { sourceTurnId: 'single-2', sourceOrder: 2 }),
  message('assistant', '回答 3', { sourceTurnId: 'single-3', sourceOrder: 3 }),
  message('user', '问题 4', { sourceTurnId: 'single-4', sourceOrder: 4 }),
]
const oneSlotBridges = new Set(
  continuity.getRenderedSourceOrderGapBridges(oneSlotNativeWindow),
)
assert.deepEqual([...oneSlotBridges], ['0:2'])
assert.equal(
  continuity.hasKnownSourceOrderGap(oneSlotNativeWindow, oneSlotBridges),
  false,
  'A raw window may prove that one platform order belongs to no rendered message',
)
assert.equal(
  continuity.hasKnownSourceOrderGap([
    message('user', '问题 0', { sourceTurnId: 'turn-0', sourceOrder: 0 }),
    message('assistant', '回答 1', { sourceTurnId: 'turn-1', sourceOrder: 1 }),
    message('user', '问题 4', { sourceTurnId: 'turn-4', sourceOrder: 4 }),
  ]),
  true,
  'A final stable-order hole must fail complete capture',
)
assert.equal(
  continuity.hasKnownSourceOrderPrefixGap([
    message('user', '问题 120', { sourceTurnId: 'turn-120', sourceOrder: 120 }),
    message('assistant', '回答 121', { sourceTurnId: 'turn-121', sourceOrder: 121 }),
  ]),
  true,
  'A later 60-message batch must keep probing the top for older history',
)
assert.equal(
  appended.messages[3].sentAt,
  firstWindow[3].sentAt,
  'A source timestamp must survive overlap merging',
)

const correctedComplete = reconciliation.mergeCompleteConversationMessages(
  [
    message('user', '旧问题'),
    message('assistant', '错误的旧回答', {
      sourceTurnId: 'answer-turn',
      sourceOrder: 1,
      sentAt: Date.UTC(2026, 7, 20, 10, 30),
      sentAtPrecision: 'minute',
      attachmentNames: ['错误文件.pdf'],
    }),
    message('assistant', '不应继续保留的局部尾部'),
  ],
  [
    message('user', '新问题'),
    message('assistant', '完整扫描得到的正确回答', {
      sourceTurnId: 'answer-turn',
      sourceOrder: 1,
    }),
  ],
)
assert.deepEqual(
  correctedComplete.map(({ content }) => content),
  ['新问题', '完整扫描得到的正确回答'],
  'A complete snapshot must replace stale content and remove an obsolete local tail',
)
assert.equal(
  correctedComplete[1].sentAt,
  Date.UTC(2026, 7, 20, 10, 30),
  'A complete snapshot must preserve genuine source time by stable identity',
)
assert.equal(
  correctedComplete[1].attachmentNames,
  undefined,
  'A complete snapshot must remove stale attachment names',
)

const prepended = reconciliation.mergeRenderedConversationMessages(
  laterWindow,
  firstWindow,
)
assert.equal(prepended.status, 'merged')
assert.equal(prepended.existingStartIndex, 2)
assert.equal(prepended.incomingStartIndex, 0)
assert.deepEqual(
  prepended.messages.map(({ role, content }) => ({ role, content })),
  [...firstWindow, ...laterWindow.slice(2)].map(({ role, content }) => ({ role, content })),
  'Scrolling upward must prepend older rendered messages without losing the saved tail',
)

const middleWindow = laterWindow.slice(0, 2)
const retained = reconciliation.mergeRenderedConversationMessages(
  prepended.messages,
  middleWindow,
)
assert.equal(retained.status, 'existing')
assert.equal(retained.incomingStartIndex, 2)
assert.equal(retained.messages.length, 6)

const shiftedWithoutAnchor = reconciliation.mergeRenderedConversationMessages(
  firstWindow,
  [
    message('user', '完全不同的问题 A'),
    message('assistant', '完全不同的回答 A'),
    message('user', '完全不同的问题 B'),
    message('assistant', '完全不同的回答 B'),
  ],
)
assert.equal(shiftedWithoutAnchor.status, 'conflict')
assert.equal(shiftedWithoutAnchor.incomingStartIndex, null)
assert.deepEqual(
  shiftedWithoutAnchor.messages,
  firstWindow,
  'An equal-size unanchored virtual window must not overwrite saved history',
)

const edited = reconciliation.mergeRenderedConversationMessages(
  [
    message('user', '保留首条问题作为完整历史锚点'),
    message('assistant', '旧回答'),
  ],
  [
    message('user', '保留首条问题作为完整历史锚点'),
    message('assistant', '编辑后的回答'),
  ],
)
assert.equal(edited.status, 'incoming')
assert.equal(edited.messages[1].content, '编辑后的回答')

assert.deepEqual(
  reconciliation.reconcileRenderedConversationMessages(
    middleWindow,
    prepended.messages,
  ),
  {
    status: 'local-history-window',
    pageMessageCount: 2,
    localMessageCount: 6,
  },
  'Manual verification must accept a uniquely matched middle window',
)

const serviceSource = readFileSync(
  join(root, 'src/services/conversation-service.ts'),
  'utf8',
)
assert.match(serviceSource, /repositionAttachments/)
assert.match(serviceSource, /captureSnapshotComplete/)
assert.match(serviceSource, /mergeCompleteConversationMessages/)
assert.match(
  serviceSource,
  /messageIndex: attachment\.messageIndex \+ startIndex/,
  'Prepending older messages must move saved and incoming attachment positions',
)

console.log('conversation virtual-window merge verification passed')
