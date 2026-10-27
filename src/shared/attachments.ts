import {
  MAX_ATTACHMENT_MAX_SIZE_MB,
  type Conversation,
  type ConversationAttachment,
} from './models'

export const BYTES_PER_MEBIBYTE = 1_024 * 1_024
export const MAX_ATTACHMENT_BINARY_BYTES =
  MAX_ATTACHMENT_MAX_SIZE_MB * BYTES_PER_MEBIBYTE
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 30 * BYTES_PER_MEBIBYTE
export const SAFE_RASTER_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export interface ParsedAttachmentDataUrl {
  mimeType: string
  encoded: string
  size: number
}

export function mergeConversationAttachments(
  existing: readonly ConversationAttachment[] | undefined,
  incoming: readonly ConversationAttachment[] | undefined,
  retainUnmatchedExisting = true,
): ConversationAttachment[] {
  if (incoming === undefined) {
    return existing ? [...existing] : []
  }
  const remaining = new Map(
    (existing ?? []).map((attachment) => [attachment.id, attachment]),
  )
  const descriptorKey = (attachment: ConversationAttachment): string =>
    `${attachment.kind}\0${attachment.name.normalize('NFKC').toLocaleLowerCase()}`
  const existingByDescriptor = new Map<string, ConversationAttachment[]>()
  for (const attachment of existing ?? []) {
    const key = descriptorKey(attachment)
    const matches = existingByDescriptor.get(key)
    if (matches === undefined) {
      existingByDescriptor.set(key, [attachment])
    } else {
      matches.push(attachment)
    }
  }
  const merged = incoming.map((attachment) => {
    const exact = remaining.get(attachment.id)
    const compatible = exact ?? existingByDescriptor
      .get(descriptorKey(attachment))
      ?.find((candidate) =>
        remaining.has(candidate.id) &&
        (
          candidate.messageIndex === undefined ||
          attachment.messageIndex === undefined ||
          candidate.messageIndex === attachment.messageIndex
        ) &&
        (
          candidate.sourceTurnId === undefined ||
          attachment.sourceTurnId === undefined ||
          candidate.sourceTurnId === attachment.sourceTurnId
        ),
      )
    if (compatible === undefined) {
      return attachment
    }
    remaining.delete(compatible.id)
    if (compatible.status === 'saved' && attachment.status !== 'saved') {
      return attachment.messageIndex === undefined
        ? attachment.sourceTurnId === undefined
          ? compatible
          : { ...compatible, sourceTurnId: attachment.sourceTurnId }
        : {
            ...compatible,
            messageIndex: attachment.messageIndex,
            ...(attachment.sourceTurnId === undefined
              ? {}
              : { sourceTurnId: attachment.sourceTurnId }),
          }
    }
    return compatible.id === attachment.id
      ? attachment
      : { ...attachment, id: compatible.id }
  })
  return retainUnmatchedExisting ? [...merged, ...remaining.values()] : merged
}

export function parseAttachmentDataUrl(value: string): ParsedAttachmentDataUrl | null {
  if (!value.startsWith('data:') || value.length > 14_000_000) {
    return null
  }
  const separator = value.indexOf(',')
  if (separator < 6) {
    return null
  }
  const metadata = value.slice(5, separator)
  const metadataParts = metadata.split(';')
  const mimeType = metadataParts[0].trim().toLowerCase()
  if (
    metadataParts.at(-1)?.toLowerCase() !== 'base64' ||
    !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)
  ) {
    return null
  }
  const encoded = value.slice(separator + 1)
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    return null
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const size = encoded.length / 4 * 3 - padding
  return size <= MAX_ATTACHMENT_BINARY_BYTES
    ? { mimeType, encoded, size }
    : null
}

export function isPersistedAttachmentValid(
  attachment: ConversationAttachment,
): boolean {
  if (attachment.status !== 'saved') {
    return attachment.dataUrl === undefined
  }
  if (attachment.dataUrl === undefined) {
    return false
  }
  const parsed = parseAttachmentDataUrl(attachment.dataUrl)
  return (
    parsed !== null &&
    parsed.mimeType === attachment.mimeType.toLowerCase() &&
    parsed.size === attachment.size &&
    (attachment.kind !== 'image' ||
      SAFE_RASTER_IMAGE_MIME_TYPES.has(parsed.mimeType))
  )
}

export function stripConversationAttachmentData(
  conversation: Conversation,
): Conversation {
  if (!conversation.attachments?.some((attachment) => attachment.dataUrl !== undefined)) {
    return conversation
  }
  return {
    ...conversation,
    attachments: conversation.attachments.map((attachment) => {
      const metadata = { ...attachment }
      delete metadata.dataUrl
      return metadata
    }),
  }
}
