import {
  MAX_ATTACHMENT_BINARY_BYTES,
  SAFE_RASTER_IMAGE_MIME_TYPES,
} from '../shared/attachments'
import {
  getOriginalRemoteImageUrl,
  isPermittedRemoteImageUrl,
} from '../shared/remote-images'

const REMOTE_IMAGE_TIMEOUT_MS = 12_000

export interface RemoteImageReadResult {
  dataUrl: string
  mimeType: string
  size: number
}

function normalizeMimeType(value: string | null): string {
  return value?.split(';')[0].trim().toLowerCase() ?? ''
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 32_768
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return null
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength <= maximumBytes ? bytes : null
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readPermittedRemoteImage(
  sourceUrl: string,
  requestedMaximumBytes: number,
): Promise<RemoteImageReadResult | null> {
  if (!isPermittedRemoteImageUrl(sourceUrl)) {
    return null
  }
  const maximumBytes = Math.min(
    MAX_ATTACHMENT_BINARY_BYTES,
    Math.max(1, Math.floor(requestedMaximumBytes)),
  )
  const originalUrl = getOriginalRemoteImageUrl(sourceUrl)
  const sourceUrls = originalUrl === null
    ? [sourceUrl]
    : [originalUrl, sourceUrl]

  for (const candidateUrl of sourceUrls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS)
    try {
      const response = await fetch(candidateUrl, {
        // Prefer the browser's existing response because Gemini image URLs can
        // become unavailable on the network while their preview is still open.
        cache: 'force-cache',
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!response.ok) {
        continue
      }
      const mimeType = normalizeMimeType(response.headers.get('content-type'))
      if (!SAFE_RASTER_IMAGE_MIME_TYPES.has(mimeType)) {
        continue
      }
      const bytes = await readBoundedBytes(response, maximumBytes)
      if (bytes === null || bytes.byteLength === 0) {
        continue
      }
      return {
        dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
        mimeType,
        size: bytes.byteLength,
      }
    } catch {
      // The original-size transform can be unavailable or exceed the bounded
      // read. Fall back to the exact rendered URL before giving up.
    } finally {
      clearTimeout(timeout)
    }
  }
  return null
}
