import type { ConversationAttachment } from '../shared/models'
import { parseAttachmentDataUrl } from '../shared/attachments'

export type TextAttachmentFormat = 'text' | 'markdown'
export type TextAttachmentEncoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be'
export const MAX_TEXT_PREVIEW_CHARACTERS = 200_000

export function getTextAttachmentFormat(attachment: ConversationAttachment): TextAttachmentFormat | null {
  if (attachment.kind !== 'file') return null
  if (/\.txt$/i.test(attachment.name)) return 'text'
  return /\.(?:md|markdown)$/i.test(attachment.name) ? 'markdown' : null
}

export function canPreviewTextAttachment(attachment: ConversationAttachment): boolean {
  return getTextAttachmentFormat(attachment) !== null && attachment.status === 'saved' && typeof attachment.dataUrl === 'string'
}

/** Decode only the persisted copy; never request a host or external URL. */
export function readTextAttachmentBytes(attachment: ConversationAttachment): Uint8Array {
  if (!canPreviewTextAttachment(attachment)) throw new Error('文件内容尚未保存，请先补齐附件')
  const parsed = parseAttachmentDataUrl(attachment.dataUrl!)
  if (!parsed || parsed.size !== attachment.size || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
    throw new Error('本地附件内容无效，无法预览')
  }
  const binary = atob(parsed.encoded)
  if (binary.length !== parsed.size) throw new Error('本地附件内容不完整，无法预览')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function decodeTextAttachment(bytes: Uint8Array, encoding: TextAttachmentEncoding): string {
  const detected = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding === 'auto' ? detected : encoding).decode(bytes)
}

export function truncateTextPreview(text: string): { text: string; truncated: boolean } {
  let end = MAX_TEXT_PREVIEW_CHARACTERS
  if (text.length <= end) return { text, truncated: false }
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}
