import { getConversation, putConversation } from '../db/conversations'
import { getSettings } from '../db/settings'
import type { Conversation, LocalAttachmentCopy } from '../shared/models'
import { BYTES_PER_MEBIBYTE, MAX_ATTACHMENT_BINARY_BYTES, MAX_CONVERSATION_ATTACHMENT_BYTES } from '../shared/attachments'
import { isLocalAttachmentCopy, matchesLocalAttachmentName } from '../shared/local-attachments'
import { createContentHash } from '../utils/hash'
import { ImportValidationError, NotFoundError } from './errors'

/** Called only from the Manager through the serialized runtime data queue. */
export async function supplementLocalAttachment(id: string, attachmentId: string, copy: LocalAttachmentCopy): Promise<Conversation> {
  if (!isLocalAttachmentCopy(copy)) throw new ImportValidationError('文件内容或大小无效，请重新选择原始文件')
  const settings = await getSettings()
  if (settings.fileSavePolicy !== 'per-conversation') throw new ImportValidationError('请先在设置中开启普通文件保存')
  const conversation = await getConversation(id)
  if (!conversation) throw new NotFoundError('对话已删除，请刷新列表')
  if (!conversation.fileAttachmentPermission) throw new ImportValidationError('请先开启这条对话的普通文件保存权限')
  const target = conversation.attachments?.find((attachment) => attachment.id === attachmentId)
  if (!target || target.kind !== 'file') throw new NotFoundError('未找到需要补齐的普通文件附件，请刷新对话')
  if (target.status === 'saved') throw new ImportValidationError('这个附件已有本地副本，请刷新对话')
  if (!matchesLocalAttachmentName(target.name, copy.name)) throw new ImportValidationError(`请选择与附件同名的原始文件：${target.name}`)
  const maximumBytes = Math.min(MAX_ATTACHMENT_BINARY_BYTES, settings.attachmentMaxSizeMb * BYTES_PER_MEBIBYTE)
  if (copy.size > maximumBytes) throw new ImportValidationError(`文件超过当前 ${settings.attachmentMaxSizeMb} MB 保存上限`)
  const attachments = conversation.attachments!.map((attachment) => attachment.id === attachmentId
    ? { ...attachment, status: 'saved' as const, mimeType: copy.mimeType, size: copy.size, dataUrl: copy.dataUrl }
    : attachment)
  const totalBytes = attachments.reduce((total, attachment) => total + (attachment.status === 'saved' ? attachment.size ?? 0 : 0), 0)
  if (totalBytes > MAX_CONVERSATION_ATTACHMENT_BYTES) throw new ImportValidationError('补齐后附件总大小超过这条对话的 30 MB 上限')
  return putConversation({
    ...conversation, attachments,
    contentHash: await createContentHash(conversation.title, conversation.messages, attachments),
    updatedAt: Date.now(),
  })
}
