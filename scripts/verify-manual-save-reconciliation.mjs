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

const pageMessages = [
  {
    role: 'user',
    content: '请更新报告',
    attachmentNames: [' Report_V2.xlsx ', 'notes.md'],
  },
  {
    role: 'assistant',
    content: '报告已更新',
  },
]

assert.deepEqual(
  reconciliation.reconcileRenderedConversationMessages(pageMessages, [
    {
      ...pageMessages[0],
      attachmentNames: ['notes.md', 'report_v2.xlsx', 'REPORT_V2.xlsx'],
    },
    {
      ...pageMessages[1],
      sentAt: Date.UTC(2026, 7, 19, 9, 30),
      sentAtPrecision: 'minute',
    },
  ]),
  {
    status: 'exact',
    pageMessageCount: 2,
    localMessageCount: 2,
  },
  'Source timestamps and attachment-name formatting must not create a false mismatch',
)

assert.deepEqual(
  reconciliation.reconcileRenderedConversationMessages(pageMessages, [
    { role: 'user', content: '较早的消息' },
    ...pageMessages,
  ]),
  {
    status: 'local-history-suffix',
    pageMessageCount: 2,
    localMessageCount: 3,
  },
  'A virtualized page can safely verify against the complete local-history suffix',
)

assert.deepEqual(
  reconciliation.reconcileRenderedConversationMessages(pageMessages, [
    ...pageMessages,
    { role: 'assistant', content: '本地更新消息' },
  ]),
  {
    status: 'local-history-window',
    pageMessageCount: 2,
    localMessageCount: 3,
  },
  'A virtualized prefix can safely verify as one complete local-history window',
)

assert.deepEqual(
  reconciliation.reconcileRenderedConversationMessages(pageMessages, [
    pageMessages[0],
    { role: 'assistant', content: '旧的答复' },
  ]),
  {
    status: 'mismatch',
    pageMessageCount: 2,
    localMessageCount: 2,
  },
  'Changed latest page content must not be reported as saved',
)

assert.deepEqual(
  reconciliation.reconcileRenderedConversationMessages([], pageMessages),
  {
    status: 'mismatch',
    pageMessageCount: 0,
    localMessageCount: 2,
  },
)

const modelsModuleUrl = toDataModule(readSource('src/shared/models.ts'))
const panelMessagesJavaScript = ts.transpileModule(
  readSource('src/shared/panel-messages.ts'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText.replaceAll("'./models'", JSON.stringify(modelsModuleUrl))
const panelMessages = await import(
  `data:text/javascript;base64,${Buffer.from(panelMessagesJavaScript).toString('base64')}`,
)

const verifiedResultMessage = {
  source: panelMessages.PANEL_MESSAGE_SOURCE.HOST,
  type: panelMessages.PANEL_MESSAGE_TYPE.MANUAL_SAVE_RESULT,
  requestId: 'manual-save-1',
  result: {
    ok: true,
    conversationId: 'conversation-1',
    verification: 'exact',
  },
}
assert.equal(panelMessages.isManualSaveResultMessage(verifiedResultMessage), true)
assert.equal(panelMessages.isManualSaveResultMessage({
  ...verifiedResultMessage,
  result: {
    ok: true,
    conversationId: 'conversation-1',
  },
}), false, 'Manual save success must carry a verification result')

const observer = readSource('src/content/conversation-observer.ts')
assert.match(observer, /MANUAL_SAVE_RETRY_DELAYS_MS = \[0, 750, 2_000\]/)
assert.match(observer, /verifySavedConversation\(/)
assert.match(observer, /reconcileRenderedConversationMessages\(/)
assert.match(
  observer,
  /this\.clearDebounce\(\)\s*const scheduledCaptureRevision = \+\+this\.captureRevision/,
  'An explicit save must clear a pending passive debounce before it enters the capture queue',
)
assert.match(
  observer,
  /const requireRevisionMatch = trigger === 'passive'[\s\S]*?const captureIsCurrent = \(\): boolean => this\.isCaptureCurrent\([\s\S]*?requireRevisionMatch,[\s\S]*?\)/,
  'Manual capture must retain navigation checks without being cancelled by same-page DOM revisions',
)
assert.match(observer, /renderedMessages\[0\]\?\.role === 'assistant'/)
assert.doesNotMatch(observer, /请查看控制台错误/)

console.log('manual save reconciliation verification passed')
