import type { LocalAttachmentCopy } from './models'
import { parseAttachmentDataUrl } from './attachments'

export function matchesLocalAttachmentName(left: string, right: string): boolean {
  const normalize = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase()
  return normalize(left) === normalize(right)
}

export function isLocalAttachmentCopy(value: unknown): value is LocalAttachmentCopy {
  if (typeof value !== 'object' || value === null) return false
  const copy = value as Partial<LocalAttachmentCopy>
  if (typeof copy.name !== 'string' || copy.name.trim() === '' || copy.name.length > 255 ||
      typeof copy.mimeType !== 'string' || typeof copy.size !== 'number' || !Number.isSafeInteger(copy.size) || copy.size <= 0 ||
      typeof copy.dataUrl !== 'string') return false
  const parsed = parseAttachmentDataUrl(copy.dataUrl)
  return parsed !== null && parsed.mimeType === copy.mimeType && parsed.size === copy.size
}
