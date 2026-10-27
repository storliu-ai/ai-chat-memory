import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

const exportJavaScript = ts.transpileModule(
  readSource('src/panel/conversation-export.ts'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText.replace(
  /(['"])\.\.\/shared\/models\1/,
  `'data:text/javascript,export const PLATFORM_LABELS={chatgpt:"ChatGPT",gemini:"Gemini",deepseek:"DeepSeek"}'`,
)
const exportsModule = await import(
  `data:text/javascript;base64,${Buffer.from(exportJavaScript).toString('base64')}`
)

const conversation = {
  id: 'a'.repeat(64),
  platform: 'gemini',
  accountId: 'account-1',
  conversationId: 'remote-1',
  title: '测试：完整 / 对话',
  url: 'https://gemini.google.com/app/remote-1',
  messages: [
    { role: 'user', content: '第一条问题' },
    {
      role: 'assistant',
      content: '第二条回答',
      sentAt: Date.UTC(2026, 7, 14, 8, 21),
      sentAtPrecision: 'minute',
    },
    { role: 'user', content: '第三条问题', attachmentNames: ['说明.txt'] },
  ],
  attachments: [
    {
      id: 'attachment-1',
      name: '说明.txt',
      kind: 'file',
      mimeType: 'text/plain',
      size: 12,
      status: 'saved',
      messageIndex: 2,
      dataUrl: 'data:text/plain;base64,SGVsbG8=',
    },
    {
      id: 'attachment-2',
      name: '旧图片.png',
      kind: 'image',
      mimeType: 'image/png',
      size: null,
      status: 'unavailable',
    },
  ],
  createdAt: Date.UTC(2026, 7, 14, 8),
  updatedAt: Date.UTC(2026, 7, 14, 9),
  messageCount: 3,
  contentHash: 'hash',
  pinned: true,
  important: false,
  imageAttachmentPermission: false,
  fileAttachmentPermission: true,
}

const baseOptions = {
  conversation,
  accountLabel: '工作账户',
  environmentLabel: '东京环境',
  exportedAt: Date.UTC(2026, 7, 14, 10),
}

const allMarkdown = exportsModule.formatConversationMarkdown({
  ...baseOptions,
  range: { mode: 'all' },
})
assert.match(allMarkdown, /^# 测试：完整 \/ 对话/m)
assert.match(allMarkdown, /- 账户：工作账户/)
assert.match(allMarkdown, /- 环境：东京环境/)
assert.match(allMarkdown, /摘要：未生成/)
assert.match(allMarkdown, /第一条问题/)
assert.match(allMarkdown, /第二条回答/)
assert.match(allMarkdown, /第三条问题/)
assert.match(allMarkdown, /精确到分钟/)
assert.match(allMarkdown, /说明\.txt（文件，12 B，插件本地已保存）/)
assert.match(allMarkdown, /未定位到具体消息的附件/)
const pendingMarkdown = exportsModule.formatConversationMarkdown({ ...baseOptions, conversation: { ...conversation, pendingCapture: { source: 'network', reason: '接口显示不一致\n仍需核对' } }, range: { mode: 'all' } })
assert.match(pendingMarkdown, /保存状态：待补全/)
assert.match(pendingMarkdown, /待补全原因：接口显示不一致 仍需核对/)
assert.doesNotMatch(
  allMarkdown,
  /SGVsbG8=/,
  'Markdown must not embed saved attachment binary data',
)

const latestMarkdown = exportsModule.formatConversationMarkdown({
  ...baseOptions,
  range: { mode: 'latest', count: 2 },
})
assert.doesNotMatch(latestMarkdown, /第一条问题/)
assert.match(latestMarkdown, /## 消息 2 · 助手/)
assert.match(latestMarkdown, /## 消息 3 · 用户/)
assert.match(latestMarkdown, /最近 2 条消息（共 3 条）/)

const earliestMarkdown = exportsModule.formatConversationMarkdown({
  ...baseOptions,
  range: { mode: 'earliest', count: 1 },
})
assert.match(earliestMarkdown, /第一条问题/)
assert.doesNotMatch(earliestMarkdown, /第二条回答/)

assert.equal(
  exportsModule.sanitizeExportPathSegment(' A/B:*? "C". '),
  'A-B--- -C-',
)

const environments = [{
  environment: {
    id: '12345678-1234-4234-9234-123456789abc',
    label: '东京/环境',
    createdAt: 1,
    updatedAt: 2,
    conversationCount: 1,
  },
  accounts: [{
    id: 'account-1',
    platform: 'gemini',
    label: '工作账户',
    source: 'detected',
    createdAt: 1,
    updatedAt: 2,
  }],
  conversations: [conversation],
  sourceIsLocal: true,
}]
const entries = exportsModule.createEnvironmentMarkdownEntries(
  environments,
  Date.UTC(2026, 7, 14, 10),
)
assert.equal(entries.length, 1)
assert.match(entries[0].path, /^东京-环境-12345678-1234-4234-9234-123456789abc\//)
assert.match(entries[0].path, /\.md$/)

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ai-chat-memory-export-'))
try {
  const archivePath = join(temporaryDirectory, 'conversation-export.zip')
  const archive = exportsModule.createStoredZip(
    entries,
    Date.UTC(2026, 7, 14, 10),
  )
  writeFileSync(archivePath, archive)
  const testResult = spawnSync('unzip', ['-tq', archivePath], { encoding: 'utf8' })
  assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout)

  const archiveView = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  )
  let centralOffset = -1
  for (let offset = 0; offset <= archive.byteLength - 4; offset += 1) {
    if (archiveView.getUint32(offset, true) === 0x02014b50) {
      centralOffset = offset
      break
    }
  }
  assert.notEqual(centralOffset, -1, 'ZIP central directory must be present')
  assert.equal(
    archiveView.getUint16(centralOffset + 8, true),
    0x0800,
    'ZIP paths must carry the UTF-8 flag',
  )
  const nameLength = archiveView.getUint16(centralOffset + 28, true)
  assert.equal(
    new TextDecoder().decode(
      archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength),
    ),
    entries[0].path,
    'Chinese environment and conversation names must survive ZIP encoding',
  )
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

const singleDialog = readSource('src/panel/components/ConversationExportDialog.tsx')
assert.match(singleDialog, /value="all"/)
assert.match(singleDialog, /value="latest"/)
assert.match(singleDialog, /value="earliest"/)
assert.match(singleDialog, /不生成摘要/)

const bulkDialog = readSource('src/panel/components/EnvironmentExportDialog.tsx')
assert.match(bulkDialog, /scope === 'all' \? 'all' : \[scope\]/)
assert.match(bulkDialog, /每条对话完整导出为独立 Markdown/)

const sharedDirectoryService = readSource('src/services/shared-directory-service.ts')
assert.match(sharedDirectoryService, /readExportEnvironments/)
assert.match(sharedDirectoryService, /map\(stripConversationAttachmentData\)/)

console.log('conversation Markdown and ZIP export verification passed')
