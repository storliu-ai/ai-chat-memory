import type { LocalAttachmentCopy } from '../shared/models'
import { MAX_ATTACHMENT_BINARY_BYTES } from '../shared/attachments'
import { matchesLocalAttachmentName } from '../shared/local-attachments'

export async function readLocalAttachmentFile(file: File, expectedName: string, maximumBytes: number): Promise<LocalAttachmentCopy> {
  if (!matchesLocalAttachmentName(file.name, expectedName)) throw new Error(`请选择与附件同名的原始文件：${expectedName}`)
  if (file.size === 0) throw new Error('选择的文件为空，请选择原始附件')
  if (file.size > Math.min(maximumBytes, MAX_ATTACHMENT_BINARY_BYTES)) throw new Error('文件超过当前附件保存上限')
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type)
    ? file.type.toLowerCase() : 'application/octet-stream'
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('文件读取失败，请重新选择'))
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择'))
    reader.onabort = () => reject(new Error('文件读取已取消'))
    reader.readAsDataURL(new Blob([file], { type: mimeType }))
  })
  return { name: file.name, mimeType, size: file.size, dataUrl }
}
