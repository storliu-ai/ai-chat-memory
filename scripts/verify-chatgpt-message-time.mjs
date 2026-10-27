import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

const parserJavaScript = ts.transpileModule(
  readSource('src/adapters/chatgpt/message-time.ts'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText
const parser = await import(
  `data:text/javascript;base64,${Buffer.from(parserJavaScript).toString('base64')}`
)

const now = new Date(2026, 7, 14, 16, 30, 45, 123)
assert.deepEqual(
  parser.parseChatGPTMessageMenuTime('今天，16:21', now.getTime()),
  {
    sentAt: new Date(2026, 7, 14, 16, 21, 0, 0).getTime(),
    precision: 'minute',
  },
)
assert.deepEqual(
  parser.parseChatGPTMessageMenuTime('昨天，08：05', now.getTime()),
  {
    sentAt: new Date(2026, 7, 13, 8, 5, 0, 0).getTime(),
    precision: 'minute',
  },
)
assert.deepEqual(
  parser.parseChatGPTMessageMenuTime('2025年12月31日，23:59', now.getTime()),
  {
    sentAt: new Date(2025, 11, 31, 23, 59, 0, 0).getTime(),
    precision: 'minute',
  },
)
assert.equal(
  parser.parseChatGPTMessageMenuTime('今天，16:21:37', now.getTime()),
  null,
  'The parser must not pretend a minute-only UI label supplied seconds',
)
assert.equal(parser.parseChatGPTMessageMenuTime('查看来源', now.getTime()), null)

const adapter = readSource('src/adapters/chatgpt/chatgpt-adapter.ts')
assert.match(adapter, /observeMessageTimes\(onCaptured/)
assert.match(adapter, /aria-labelledby/)
assert.match(adapter, /data-turn'\) !== 'assistant'/)
assert.match(adapter, /MESSAGE_TIME_MENU_WAIT_MS = 5_000/)
assert.match(adapter, /sentAtPrecision: captured\.precision/)
assert.doesNotMatch(
  adapter,
  /\.click\(\)/,
  'Message-time capture must not automate ChatGPT menu clicks',
)

const selectors = readSource('src/adapters/chatgpt/selectors.ts')
assert.match(selectors, /MESSAGE_TIME_MENU_TRIGGER/)
assert.match(selectors, /MESSAGE_TIME_MENU:/)
assert.match(selectors, /role=\"menuitem\".*__menu-label/)

const detail = readSource('src/panel/pages/ConversationDetailPage.tsx')
assert.match(detail, /sentAtPrecision === 'minute'/)
assert.match(detail, /精确到分钟/)

const validation = readSource('src/services/validation.ts')
assert.match(validation, /value\.sentAtPrecision !== 'minute'/)
assert.match(validation, /value\.sentAt === undefined/)

console.log('ChatGPT answer message-time verification passed')
