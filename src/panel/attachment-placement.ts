import type {
  ChatMessage,
  ConversationAttachment,
} from '../shared/models'

export interface AttachmentPlacement {
  byMessage: ConversationAttachment[][]
  unplaced: ConversationAttachment[]
}

function normalizeAttachmentName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

export function placeConversationAttachments(
  messages: readonly ChatMessage[],
  attachments: readonly ConversationAttachment[],
): AttachmentPlacement {
  const byMessage = Array.from(
    { length: messages.length },
    () => [] as ConversationAttachment[],
  )
  const pending: ConversationAttachment[] = []

  for (const attachment of attachments) {
    if (
      attachment.messageIndex !== undefined &&
      attachment.messageIndex >= 0 &&
      attachment.messageIndex < messages.length
    ) {
      byMessage[attachment.messageIndex].push(attachment)
    } else {
      pending.push(attachment)
    }
  }

  const unplaced: ConversationAttachment[] = []
  for (const attachment of pending) {
    const normalizedName = normalizeAttachmentName(attachment.name)
    const messageIndex = messages.findIndex((message, index) =>
      message.attachmentNames?.some(
        (name) => normalizeAttachmentName(name) === normalizedName,
      ) === true &&
      !byMessage[index].some(
        (candidate) => normalizeAttachmentName(candidate.name) === normalizedName,
      ),
    )
    if (messageIndex < 0) {
      unplaced.push(attachment)
    } else {
      byMessage[messageIndex].push(attachment)
    }
  }

  return { byMessage, unplaced }
}
