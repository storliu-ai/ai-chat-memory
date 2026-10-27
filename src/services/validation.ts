import {
  FILE_SAVE_POLICIES,
  SUPPORTED_PLATFORMS,
  type AccountSource,
  type ChatMessage,
  type ConversationAttachment,
  type ConversationQuery,
  type ConversationSavePayload,
  type Platform,
} from '../shared/models'
import {
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  isPersistedAttachmentValid,
} from '../shared/attachments'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && SUPPORTED_PLATFORMS.includes(value as Platform)
}

export function isAccountSource(value: unknown): value is AccountSource {
  return value === 'detected' || value === 'manual' || value === 'unknown'
}

export function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) {
    return false
  }
  if ((value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') {
    return false
  }
  if (value.contentSource !== undefined && value.contentSource !== 'network') return false
  if (value.networkWidgetSource !== undefined && (value.role !== 'assistant' || typeof value.networkWidgetSource !== 'string' || value.networkWidgetSource.length > 12_000_000)) return false
  if (
    (value.sourceTurnId !== undefined &&
      (typeof value.sourceTurnId !== 'string' ||
        value.sourceTurnId.length === 0 ||
        value.sourceTurnId.length > 256)) ||
    (value.sourceMessageId !== undefined &&
      (typeof value.sourceMessageId !== 'string' ||
        value.sourceMessageId.length === 0 ||
        value.sourceMessageId.length > 256)) ||
    (value.sourceOrder !== undefined &&
      (typeof value.sourceOrder !== 'number' ||
        !Number.isSafeInteger(value.sourceOrder) ||
        value.sourceOrder < 0))
  ) {
    return false
  }
  if (
    value.sentAt !== undefined &&
    (!isFiniteTimestamp(value.sentAt) || !Number.isSafeInteger(value.sentAt))
  ) {
    return false
  }
  if (
    value.sentAtPrecision !== undefined &&
    (
      value.sentAt === undefined ||
      (value.sentAtPrecision !== 'minute' && value.sentAtPrecision !== 'second')
    )
  ) {
    return false
  }
  if (value.attachmentNames === undefined) {
    return true
  }
  return (
    Array.isArray(value.attachmentNames) &&
    value.attachmentNames.every((name) => typeof name === 'string' && name.length <= 255)
  )
}

export function isConversationAttachment(
  value: unknown,
): value is ConversationAttachment {
  if (!isRecord(value)) {
    return false
  }
  const attachment = value as Partial<ConversationAttachment>
  return (
    typeof attachment.id === 'string' &&
    /^[a-f0-9]{64}$/i.test(attachment.id) &&
    typeof attachment.name === 'string' &&
    attachment.name.trim() !== '' &&
    attachment.name.length <= 255 &&
    attachment.kind !== undefined &&
    (attachment.kind === 'image' || attachment.kind === 'file') &&
    typeof attachment.mimeType === 'string' &&
    /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mimeType) &&
    (attachment.size === null ||
      (typeof attachment.size === 'number' &&
        Number.isSafeInteger(attachment.size) &&
        attachment.size >= 0)) &&
    (attachment.status === 'saved' ||
      attachment.status === 'confirmation-required' ||
      attachment.status === 'not-saved' ||
      attachment.status === 'too-large' ||
      attachment.status === 'unavailable') &&
    (attachment.messageIndex === undefined ||
      (Number.isSafeInteger(attachment.messageIndex) &&
        Number(attachment.messageIndex) >= 0)) &&
    (attachment.sourceTurnId === undefined ||
      (typeof attachment.sourceTurnId === 'string' &&
        attachment.sourceTurnId.length > 0 &&
        attachment.sourceTurnId.length <= 256)) &&
    isPersistedAttachmentValid(attachment as ConversationAttachment)
  )
}

export function hasValidConversationAttachments(value: unknown, maximumCount = 100): boolean {
  if (value === undefined) {
    return true
  }
  if (
    !Array.isArray(value) ||
    value.length > maximumCount ||
    !value.every(isConversationAttachment) ||
    new Set(value.map((attachment) => attachment.id)).size !== value.length
  ) {
    return false
  }
  return value.reduce(
    (total, attachment) =>
      total + (attachment.status === 'saved' ? attachment.size ?? 0 : 0),
    0,
  ) <= MAX_CONVERSATION_ATTACHMENT_BYTES
}

/** Each capture sends at most 100 candidates; saved history can accumulate
 * more across scans. Imports must retain those copies under the same byte cap. */
export function hasValidStoredConversationAttachments(value: unknown): boolean {
  return hasValidConversationAttachments(value, 10_000)
}

export function isFileSavePolicy(value: unknown): boolean {
  return typeof value === 'string' && FILE_SAVE_POLICIES.includes(
    value as (typeof FILE_SAVE_POLICIES)[number],
  )
}

export function isPendingCapture(value: unknown): value is import('../shared/models').PendingCapture {
  return isRecord(value) && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 300 && ['network', 'page'].includes(String(value.source))
}

export function isConversationSavePayload(value: unknown): value is ConversationSavePayload {
  if (!isRecord(value)) {
    return false
  }

  const messages = Array.isArray(value.messages) ? value.messages : []
  const attachments = Array.isArray(value.attachments) ? value.attachments : []
  return (
    isPlatform(value.platform) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    typeof value.accountLabel === 'string' &&
    isAccountSource(value.accountSource) &&
    typeof value.conversationId === 'string' &&
    value.conversationId.length > 0 &&
    typeof value.title === 'string' &&
    typeof value.url === 'string' &&
    messages.length > 0 &&
    messages.every(isChatMessage) &&
    hasValidConversationAttachments(value.attachments) &&
    attachments.every((attachment) =>
      !isRecord(attachment) ||
      attachment.messageIndex === undefined ||
      Number(attachment.messageIndex) < messages.length,
    ) &&
    (value.captureSnapshotComplete === undefined ||
      typeof value.captureSnapshotComplete === 'boolean') &&
    (value.supplementOnly === undefined || typeof value.supplementOnly === 'boolean') &&
    (value.supplementVerifiedMessageIds === undefined || Array.isArray(value.supplementVerifiedMessageIds) && value.supplementVerifiedMessageIds.length <= 10_000 && value.supplementVerifiedMessageIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)) &&
    (value.attachmentSnapshotComplete === undefined ||
      typeof value.attachmentSnapshotComplete === 'boolean') &&
    typeof value.contentHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.contentHash) &&
    typeof value.pinned === 'boolean'
  )
}

export function isConversationQuery(value: unknown): value is ConversationQuery {
  if (value === undefined) {
    return true
  }
  if (!isRecord(value)) {
    return false
  }

  return (
    (value.page === undefined || (Number.isInteger(value.page) && Number(value.page) > 0)) &&
    (value.pageSize === undefined ||
      (Number.isInteger(value.pageSize) && Number(value.pageSize) > 0)) &&
    (value.platform === undefined || isPlatform(value.platform)) &&
    (value.accountId === undefined || typeof value.accountId === 'string') &&
    (value.sourceEnvironmentId === undefined || typeof value.sourceEnvironmentId === 'string') &&
    (value.accountSourceEnvironmentId === undefined || typeof value.accountSourceEnvironmentId === 'string') &&
    (value.updatedAfter === undefined || isFiniteTimestamp(value.updatedAfter)) &&
    (value.updatedBefore === undefined || isFiniteTimestamp(value.updatedBefore)) &&
    (value.search === undefined || typeof value.search === 'string') &&
    (value.important === undefined || typeof value.important === 'boolean')
  )
}
