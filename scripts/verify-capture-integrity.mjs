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

const completeHistory = [
  { role: 'user', content: '请整理这份报告' },
  { role: 'assistant', content: '报告已经整理完成' },
]
const answerOnlySnapshot = [
  { role: 'assistant', content: '报告已经整理完成' },
]

assert.equal(
  reconciliation.startsWithAssistantMessage(answerOnlySnapshot),
  true,
  'An answer-only snapshot must be recognized as incomplete',
)
assert.equal(
  reconciliation.startsWithAssistantMessage(completeHistory),
  false,
  'A complete user-first history must remain valid',
)
assert.equal(
  reconciliation.isMessageSequenceSuffix(answerOnlySnapshot, completeHistory),
  true,
  'An answer-only snapshot may be retained only when it is an existing suffix',
)
assert.equal(
  reconciliation.isMessageSequenceSuffix(
    [{ role: 'assistant', content: '新的回答' }],
    completeHistory,
  ),
  false,
  'A new answer-only snapshot must not be treated as a saved suffix',
)

const deepSeekSource = readSource('src/adapters/deepseek/deepseek-adapter.ts')
assert.match(deepSeekSource, /readRoleEntries\(item, item\)/)
assert.match(deepSeekSource, /const itemEntries = items\.flatMap\(/)
assert.match(deepSeekSource, /const outsideEntries = this\.readRoleEntriesFromElements\(/)
assert.match(deepSeekSource, /sortEntriesInDocumentOrder\(\[\.\.\.itemEntries, \.\.\.outsideEntries\]\)/)
assert.match(deepSeekSource, /const seenRoots = new Set<Element>\(\)/)

const chatGptSource = readSource('src/adapters/chatgpt/chatgpt-adapter.ts')
assert.match(chatGptSource, /const attachmentRoot = roleElement\.closest\(/)
assert.match(chatGptSource, /root: attachmentRoot \?\? root/)
assert.match(chatGptSource, /attachmentRoot: turn/)

const serviceSource = readSource('src/services/conversation-service.ts')
assert.match(serviceSource, /startsWithAssistantMessage\(resolvedPayload\.messages\)/)
assert.match(serviceSource, /messageMerge\.status !== 'existing'/)
assert.match(serviceSource, /mergeRenderedConversationMessages\(/)
assert.match(
  serviceSource,
  /messageMerge\.status !== 'existing'\)[\s\S]*?return null\s*\}[\s\S]*?await ensureConversationAccount/,
  'Incomplete snapshots must be rejected before account or conversation writes',
)

const observerSource = readSource('src/content/conversation-observer.ts')
assert.match(observerSource, /private captureQueue: Promise<void> = Promise\.resolve\(\)/)
assert.match(observerSource, /private captureRevision = 0/)
assert.match(observerSource, /const scheduledCaptureRevision = \+\+this\.captureRevision/)
assert.match(observerSource, /scheduledCaptureRevision: number/)
assert.match(observerSource, /const requireRevisionMatch = trigger === 'passive'/)
assert.match(observerSource, /private isCaptureCurrent\(/)

const firstSaveIndex = observerSource.indexOf(
  'type: RUNTIME_MESSAGE_TYPE.SAVE_CONVERSATION',
)
const attachmentReadIndex = observerSource.indexOf(
  'const attachments = await captureAttachments',
)
const attachmentSaveIndex = observerSource.indexOf(
  'const savedWithAttachments = await sendRuntimeRequest',
)
assert.ok(firstSaveIndex >= 0)
assert.ok(attachmentReadIndex > firstSaveIndex)
assert.ok(attachmentSaveIndex > attachmentReadIndex)
assert.match(
  observerSource.slice(attachmentReadIndex, attachmentSaveIndex),
  /captureIsCurrent\(\)/,
  'The attachment save must retain the capture identity guard',
)

console.log('capture integrity verification passed')
