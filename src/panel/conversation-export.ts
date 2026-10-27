import {
  PLATFORM_LABELS,
  type ChatMessage,
  type Conversation,
  type ConversationAttachment,
  type ConversationExportEnvironment,
} from '../shared/models'

export type MessageExportRange =
  | { mode: 'all' }
  | { mode: 'earliest' | 'latest'; count: number }

export interface ConversationMarkdownOptions {
  conversation: Conversation
  accountLabel: string
  environmentLabel: string
  range: MessageExportRange
  exportedAt?: number
}

export interface TextArchiveEntry {
  path: string
  content: string
}

interface SelectedMessage {
  message: ChatMessage
  originalIndex: number
}

const textEncoder = new TextEncoder()

function selectMessages(
  messages: ChatMessage[],
  range: MessageExportRange,
): SelectedMessage[] {
  if (range.mode === 'all') {
    return messages.map((message, originalIndex) => ({ message, originalIndex }))
  }
  const count = Math.min(
    messages.length,
    Math.max(1, Math.floor(range.count)),
  )
  const start = range.mode === 'latest' ? messages.length - count : 0
  return messages
    .slice(start, start + count)
    .map((message, index) => ({ message, originalIndex: start + index }))
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatBytes(size: number | null): string {
  if (size === null) {
    return '大小未知'
  }
  if (size < 1_024) {
    return `${size} B`
  }
  const units = ['KB', 'MB']
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1_024)) - 1, 1)
  const value = size / 1_024 ** (unit + 1)
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatAttachment(attachment: ConversationAttachment): string {
  const status: Record<ConversationAttachment['status'], string> = {
    saved: '插件本地已保存',
    'confirmation-required': '需要授权',
    'not-saved': '未保存',
    'too-large': '超过上限',
    unavailable: '不可用',
  }
  return `- ${oneLine(attachment.name)}（${attachment.kind === 'image' ? '图片' : '文件'}，${formatBytes(attachment.size)}，${status[attachment.status]}）`
}

function getRangeLabel(
  range: MessageExportRange,
  selectedCount: number,
  totalCount: number,
): string {
  if (range.mode === 'all') {
    return `全部 ${totalCount} 条消息`
  }
  return `${range.mode === 'latest' ? '最近' : '最早'} ${selectedCount} 条消息（共 ${totalCount} 条）`
}

export function formatConversationMarkdown({
  conversation,
  accountLabel,
  environmentLabel,
  range,
  exportedAt = Date.now(),
}: ConversationMarkdownOptions): string {
  const selected = selectMessages(conversation.messages, range)
  const selectedIndexes = new Set(selected.map(({ originalIndex }) => originalIndex))
  const unplacedAttachments = (conversation.attachments ?? []).filter(
    (attachment) => attachment.messageIndex === undefined,
  )
  const lines = [
    `# ${conversation.title}`,
    '',
    `- 平台：${PLATFORM_LABELS[conversation.platform]}`,
    `- 账户：${oneLine(accountLabel) || 'Unknown'}`,
    `- 环境：${oneLine(environmentLabel)}`,
    `- 原对话：${conversation.url}`,
    `- 对话更新时间：${new Date(conversation.updatedAt).toISOString()}`,
    `- 导出时间：${new Date(exportedAt).toISOString()}`,
    `- 导出范围：${getRangeLabel(range, selected.length, conversation.messages.length)}`,
    ...(conversation.pendingCapture ? [
      '- 保存状态：待补全（异常后经用户确认保存，完整性尚未核对通过）',
      `- 待补全原因：${oneLine(conversation.pendingCapture.reason)}`,
    ] : []),
    '- 摘要：未生成；以下内容按插件保存顺序原样导出',
    '',
    '---',
    '',
  ]

  for (const { message, originalIndex } of selected) {
    lines.push(
      `## 消息 ${originalIndex + 1} · ${message.role === 'user' ? '用户' : '助手'}`,
      '',
    )
    if (message.sentAt !== undefined) {
      lines.push(
        `时间：${new Date(message.sentAt).toISOString()}${message.sentAtPrecision === 'minute' ? '（精确到分钟）' : ''}`,
        '',
      )
    }
    lines.push(message.content.replace(/\r\n?/g, '\n').trimEnd(), '')

    const positionedAttachments = (conversation.attachments ?? []).filter(
      (attachment) => attachment.messageIndex === originalIndex,
    )
    const knownNames = new Set(
      positionedAttachments.map((attachment) =>
        attachment.name.normalize('NFKC').trim().toLocaleLowerCase(),
      ),
    )
    const metadataOnlyNames = (message.attachmentNames ?? []).filter(
      (name) => !knownNames.has(
        name.normalize('NFKC').trim().toLocaleLowerCase(),
      ),
    )
    if (positionedAttachments.length > 0 || metadataOnlyNames.length > 0) {
      lines.push('### 附件', '')
      lines.push(...positionedAttachments.map(formatAttachment))
      lines.push(...metadataOnlyNames.map((name) => `- ${oneLine(name)}（仅名称）`))
      lines.push('')
    }
  }

  if (
    range.mode === 'all' &&
    unplacedAttachments.length > 0 &&
    selectedIndexes.size === conversation.messages.length
  ) {
    lines.push('## 未定位到具体消息的附件', '')
    lines.push(...unplacedAttachments.map(formatAttachment), '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export function sanitizeExportPathSegment(value: string): string {
  const withoutControlCharacters = Array.from(
    value.normalize('NFKC'),
    (character) => character.charCodeAt(0) <= 0x1f ? '-' : character,
  ).join('')
  const normalized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  const safe = normalized || '未命名对话'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)
    ? `_${safe}`
    : safe
}

function getDosDateTime(timestamp: number): { date: number; time: number } {
  const value = new Date(timestamp)
  const year = Math.min(2107, Math.max(1980, value.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) |
      Math.floor(value.getSeconds() / 2),
  }
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1
  }
  crcTable[index] = value >>> 0
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of data) {
    crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
}

export function createStoredZip(
  entries: TextArchiveEntry[],
  timestamp = Date.now(),
): Uint8Array {
  if (entries.length === 0 || entries.length > 65_535) {
    throw new Error('ZIP 必须包含 1 至 65535 个文件')
  }
  const seenPaths = new Set<string>()
  const prepared = entries.map((entry) => {
    const path = entry.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (path === '' || seenPaths.has(path)) {
      throw new Error('ZIP 中存在空文件名或重复文件名')
    }
    seenPaths.add(path)
    const name = textEncoder.encode(path)
    const data = textEncoder.encode(entry.content)
    if (name.length > 65_535 || data.length > 0xffffffff) {
      throw new Error('ZIP 文件名或单个文件过大')
    }
    return { name, data, crc: crc32(data), localOffset: 0 }
  })
  const localSize = prepared.reduce(
    (total, entry) => total + 30 + entry.name.length + entry.data.length,
    0,
  )
  const centralSize = prepared.reduce(
    (total, entry) => total + 46 + entry.name.length,
    0,
  )
  const totalSize = localSize + centralSize + 22
  if (totalSize > 0xffffffff) {
    throw new Error('ZIP 总大小超过 4 GB')
  }

  const output = new Uint8Array(totalSize)
  const view = new DataView(output.buffer)
  const dos = getDosDateTime(timestamp)
  let offset = 0

  for (const entry of prepared) {
    entry.localOffset = offset
    writeUint32(view, offset, 0x04034b50)
    writeUint16(view, offset + 4, 20)
    writeUint16(view, offset + 6, 0x0800)
    writeUint16(view, offset + 8, 0)
    writeUint16(view, offset + 10, dos.time)
    writeUint16(view, offset + 12, dos.date)
    writeUint32(view, offset + 14, entry.crc)
    writeUint32(view, offset + 18, entry.data.length)
    writeUint32(view, offset + 22, entry.data.length)
    writeUint16(view, offset + 26, entry.name.length)
    writeUint16(view, offset + 28, 0)
    output.set(entry.name, offset + 30)
    output.set(entry.data, offset + 30 + entry.name.length)
    offset += 30 + entry.name.length + entry.data.length
  }

  const centralOffset = offset
  for (const entry of prepared) {
    writeUint32(view, offset, 0x02014b50)
    writeUint16(view, offset + 4, 20)
    writeUint16(view, offset + 6, 20)
    writeUint16(view, offset + 8, 0x0800)
    writeUint16(view, offset + 10, 0)
    writeUint16(view, offset + 12, dos.time)
    writeUint16(view, offset + 14, dos.date)
    writeUint32(view, offset + 16, entry.crc)
    writeUint32(view, offset + 20, entry.data.length)
    writeUint32(view, offset + 24, entry.data.length)
    writeUint16(view, offset + 28, entry.name.length)
    writeUint16(view, offset + 30, 0)
    writeUint16(view, offset + 32, 0)
    writeUint16(view, offset + 34, 0)
    writeUint16(view, offset + 36, 0)
    writeUint32(view, offset + 38, 0)
    writeUint32(view, offset + 42, entry.localOffset)
    output.set(entry.name, offset + 46)
    offset += 46 + entry.name.length
  }

  writeUint32(view, offset, 0x06054b50)
  writeUint16(view, offset + 4, 0)
  writeUint16(view, offset + 6, 0)
  writeUint16(view, offset + 8, prepared.length)
  writeUint16(view, offset + 10, prepared.length)
  writeUint32(view, offset + 12, centralSize)
  writeUint32(view, offset + 16, centralOffset)
  writeUint16(view, offset + 20, 0)
  return output
}

function getDateStamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function createEnvironmentMarkdownEntries(
  environments: ConversationExportEnvironment[],
  exportedAt = Date.now(),
): TextArchiveEntry[] {
  return environments.flatMap(({ environment, accounts, conversations }) => {
    const folder = `${sanitizeExportPathSegment(environment.label)}-${environment.id}`
    const accountLabels = new Map(accounts.map((account) => [account.id, account.label]))
    return conversations.map((conversation, index) => ({
      path: `${folder}/${String(index + 1).padStart(4, '0')}-${sanitizeExportPathSegment(conversation.title)}-${conversation.id.slice(0, 8)}.md`,
      content: formatConversationMarkdown({
        conversation,
        accountLabel: accountLabels.get(conversation.accountId) ?? 'Unknown',
        environmentLabel: environment.label,
        range: { mode: 'all' },
        exportedAt,
      }),
    }))
  })
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function downloadConversationMarkdown(
  options: ConversationMarkdownOptions,
): string {
  const exportedAt = options.exportedAt ?? Date.now()
  const filename = `${sanitizeExportPathSegment(options.conversation.title)}-${getDateStamp(exportedAt)}.md`
  downloadBlob(
    filename,
    new Blob([
      formatConversationMarkdown({ ...options, exportedAt }),
    ], { type: 'text/markdown;charset=utf-8' }),
  )
  return filename
}

export function downloadEnvironmentMarkdownArchive(
  environments: ConversationExportEnvironment[],
  exportedAt = Date.now(),
): { filename: string; conversationCount: number } {
  const entries = createEnvironmentMarkdownEntries(environments, exportedAt)
  if (entries.length === 0) {
    throw new Error('所选环境没有可导出的对话')
  }
  const scope = environments.length === 1
    ? sanitizeExportPathSegment(environments[0].environment.label)
    : '全部环境'
  const filename = `ai-chat-memory-${scope}-${getDateStamp(exportedAt)}.zip`
  const archive = createStoredZip(entries, exportedAt)
  downloadBlob(
    filename,
    new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' }),
  )
  return { filename, conversationCount: entries.length }
}
