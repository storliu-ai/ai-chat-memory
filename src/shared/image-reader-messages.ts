export const IMAGE_READER_MESSAGE_SOURCE = 'ai-chat-memory-image-reader'
export const IMAGE_READER_MESSAGE_TYPE = 'READ_IMAGE'

export interface ImageReaderRequest {
  source: typeof IMAGE_READER_MESSAGE_SOURCE
  type: typeof IMAGE_READER_MESSAGE_TYPE
  sourceUrl: string
  maximumBytes: number
}

export type ImageReaderResponse =
  | { ok: false }
  | {
      ok: true
      dataUrl: string
      mimeType: string
      size: number
    }

export function isImageReaderRequest(value: unknown): value is ImageReaderRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const request = value as Partial<ImageReaderRequest>
  return (
    request.source === IMAGE_READER_MESSAGE_SOURCE &&
    request.type === IMAGE_READER_MESSAGE_TYPE &&
    typeof request.sourceUrl === 'string' &&
    typeof request.maximumBytes === 'number' &&
    Number.isSafeInteger(request.maximumBytes) &&
    request.maximumBytes > 0
  )
}

export function isImageReaderResponse(value: unknown): value is ImageReaderResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const response = value as Partial<ImageReaderResponse>
  if (response.ok === false) {
    return true
  }
  return (
    response.ok === true &&
    typeof response.dataUrl === 'string' &&
    typeof response.mimeType === 'string' &&
    typeof response.size === 'number'
  )
}
