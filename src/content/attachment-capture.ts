import {
  BYTES_PER_MEBIBYTE,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  SAFE_RASTER_IMAGE_MIME_TYPES,
  parseAttachmentDataUrl,
} from '../shared/attachments'
import type {
  AttachmentSaveStatus,
  ConversationAttachment,
  ExtractedAttachmentCandidate,
} from '../shared/models'
import { sendRuntimeRequest } from '../shared/runtime-client'
import { RUNTIME_MESSAGE_TYPE } from '../shared/runtime-messages'
import { isPermittedRemoteImageUrl } from '../shared/remote-images'
import { sha256Hex } from '../utils/hash'
import { readEmbeddedRemoteImage } from './embedded-image-reader'

const ATTACHMENT_FETCH_TIMEOUT_MS = 8_000
const ATTACHMENT_FETCH_CONCURRENCY = 4
const MAX_CAPTURE_CANDIDATES = 100
const MAX_ATTACHMENT_CACHE_ENTRIES = 100

export interface AttachmentCapturePolicy {
  saveImages: boolean
  allowFiles: boolean
  skippedFileStatus: Extract<
    AttachmentSaveStatus,
    'confirmation-required' | 'not-saved'
  >
  maximumBytes: number
}

function normalizeSourceIdentity(value: string | null): string {
  if (value === null) {
    return ''
  }
  try {
    if (value.startsWith('data:')) {
      return `${value.slice(0, 128)}:${value.length}:${value.slice(-128)}`
    }
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`
    }
  } catch {
    // Use the opaque source below.
  }
  return value
}

async function createAttachmentId(
  candidate: ExtractedAttachmentCandidate,
): Promise<string> {
  return sha256Hex([
    candidate.kind,
    candidate.name.normalize('NFKC').toLocaleLowerCase(),
    normalizeSourceIdentity(candidate.sourceUrl),
    candidate.sourceTurnId ?? '',
    String(candidate.messageIndex ?? -1),
  ].join('\0'))
}

function createMetadataAttachment(
  id: string,
  candidate: ExtractedAttachmentCandidate,
  status: AttachmentSaveStatus,
): ConversationAttachment {
  return {
    id,
    name: candidate.name,
    kind: candidate.kind,
    mimeType: candidate.mimeType ?? 'application/octet-stream',
    size: candidate.size,
    status,
    ...(candidate.messageIndex !== undefined
      ? { messageIndex: candidate.messageIndex }
      : {}),
    ...(candidate.sourceTurnId !== undefined
      ? { sourceTurnId: candidate.sourceTurnId }
      : {}),
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Attachment conversion returned no data'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Attachment conversion failed'))
    reader.readAsDataURL(blob)
  })
}

function normalizeMimeType(value: string | null): string {
  const mimeType = value?.split(';')[0].trim().toLowerCase() ?? ''
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)
    ? mimeType
    : 'application/octet-stream'
}

function readRenderedImageAttachment(
  candidate: ExtractedAttachmentCandidate,
  id: string,
  maximumBytes: number,
): ConversationAttachment | null {
  if (candidate.kind !== 'image' || candidate.renderedDataUrl === undefined) {
    return null
  }
  const parsed = parseAttachmentDataUrl(candidate.renderedDataUrl)
  if (
    parsed === null ||
    parsed.size > maximumBytes ||
    !SAFE_RASTER_IMAGE_MIME_TYPES.has(parsed.mimeType)
  ) {
    return null
  }
  return {
    id,
    name: candidate.name,
    kind: 'image',
    mimeType: parsed.mimeType,
    size: parsed.size,
    status: 'saved',
    ...(candidate.messageIndex !== undefined
      ? { messageIndex: candidate.messageIndex }
      : {}),
    ...(candidate.sourceTurnId !== undefined
      ? { sourceTurnId: candidate.sourceTurnId }
      : {}),
    dataUrl: candidate.renderedDataUrl,
  }
}

async function readRemoteImageAttachment(
  candidate: ExtractedAttachmentCandidate,
  id: string,
  maximumBytes: number,
): Promise<ConversationAttachment | null> {
  if (
    candidate.kind !== 'image' ||
    candidate.sourceUrl === null ||
    !isPermittedRemoteImageUrl(candidate.sourceUrl)
  ) {
    return null
  }
  try {
    const embeddedResult = await readEmbeddedRemoteImage(
      candidate.sourceUrl,
      maximumBytes,
    )
    const result = embeddedResult?.ok === true
      ? {
          dataUrl: embeddedResult.dataUrl,
          mimeType: embeddedResult.mimeType,
          size: embeddedResult.size,
        }
      : await sendRuntimeRequest({
          type: RUNTIME_MESSAGE_TYPE.READ_REMOTE_IMAGE,
          sourceUrl: candidate.sourceUrl,
          maximumBytes,
        })
    if (result === null) {
      return null
    }
    const parsed = parseAttachmentDataUrl(result.dataUrl)
    if (
      parsed === null ||
      parsed.size !== result.size ||
      parsed.mimeType !== result.mimeType ||
      !SAFE_RASTER_IMAGE_MIME_TYPES.has(result.mimeType)
    ) {
      return null
    }
    return {
      id,
      name: candidate.name,
      kind: 'image',
      mimeType: result.mimeType,
      size: result.size,
      status: 'saved',
      ...(candidate.messageIndex !== undefined
        ? { messageIndex: candidate.messageIndex }
        : {}),
      ...(candidate.sourceTurnId !== undefined
        ? { sourceTurnId: candidate.sourceTurnId }
        : {}),
      dataUrl: result.dataUrl,
    }
  } catch {
    return null
  }
}

async function readResponseBlob(
  response: Response,
  maximumBytes: number,
): Promise<Blob | null> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return null
  }
  const mimeType = normalizeMimeType(response.headers.get('content-type'))
  if (response.body === null) {
    const blob = await response.blob()
    return blob.size <= maximumBytes
      ? new Blob([blob], { type: mimeType })
      : null
  }

  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        return null
      }
      const chunk = new Uint8Array(value.byteLength)
      chunk.set(value)
      chunks.push(chunk.buffer)
    }
  } finally {
    reader.releaseLock()
  }
  return new Blob(chunks, { type: mimeType })
}

async function readSourceAsBlob(
  sourceUrl: string,
  maximumBytes: number,
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (sourceUrl.startsWith('data:')) {
    const parsed = parseAttachmentDataUrl(sourceUrl)
    if (parsed === null || parsed.size > maximumBytes) {
      return null
    }
    const response = await fetch(sourceUrl)
    return { blob: await response.blob(), mimeType: parsed.mimeType }
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(sourceUrl, {
      cache: 'force-cache',
      credentials: 'include',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Attachment request failed with status ${response.status}`)
    }
    const blob = await readResponseBlob(response, maximumBytes)
    return blob === null
      ? null
      : { blob, mimeType: normalizeMimeType(blob.type) }
  } finally {
    window.clearTimeout(timeout)
  }
}

async function captureCandidate(
  candidate: ExtractedAttachmentCandidate,
  id: string,
  policy: AttachmentCapturePolicy,
  cache: Map<string, ConversationAttachment>,
): Promise<ConversationAttachment> {
  if (candidate.size !== null && candidate.size > policy.maximumBytes) {
    return createMetadataAttachment(id, candidate, 'too-large')
  }
  if (candidate.kind === 'image' && !policy.saveImages) {
    return createMetadataAttachment(id, candidate, 'not-saved')
  }
  if (candidate.kind === 'file' && !policy.allowFiles) {
    return createMetadataAttachment(id, candidate, policy.skippedFileStatus)
  }
  const cached = cache.get(id)
  if (
    cached?.status === 'saved' &&
    cached.dataUrl !== undefined &&
    (cached.size ?? 0) <= policy.maximumBytes
  ) {
    return cached
  }
  const renderedImage = readRenderedImageAttachment(
    candidate,
    id,
    policy.maximumBytes,
  )
  const remoteImage = await readRemoteImageAttachment(
    candidate,
    id,
    policy.maximumBytes,
  )
  if (remoteImage !== null) {
    return remoteImage
  }
  if (candidate.sourceUrl === null) {
    return renderedImage ?? createMetadataAttachment(id, candidate, 'unavailable')
  }
  if (candidate.sourceUrl.startsWith('blob:') && renderedImage !== null) {
    return renderedImage
  }

  try {
    const source = await readSourceAsBlob(candidate.sourceUrl, policy.maximumBytes)
    if (source === null) {
      return renderedImage ?? createMetadataAttachment(id, candidate, 'too-large')
    }
    const mimeType = source.mimeType === 'application/octet-stream'
      ? normalizeMimeType(candidate.mimeType)
      : source.mimeType
    if (
      candidate.kind === 'image' &&
      !SAFE_RASTER_IMAGE_MIME_TYPES.has(mimeType)
    ) {
      return renderedImage ?? createMetadataAttachment(id, candidate, 'unavailable')
    }
    const blob = source.blob.type === mimeType
      ? source.blob
      : new Blob([source.blob], { type: mimeType })
    const dataUrl = await blobToDataUrl(blob)
    const parsed = parseAttachmentDataUrl(dataUrl)
    if (parsed === null || parsed.size > policy.maximumBytes) {
      return renderedImage ?? createMetadataAttachment(id, candidate, 'too-large')
    }
    return {
      id,
      name: candidate.name,
      kind: candidate.kind,
      mimeType,
      size: parsed.size,
      status: 'saved',
      ...(candidate.messageIndex !== undefined
        ? { messageIndex: candidate.messageIndex }
        : {}),
      ...(candidate.sourceTurnId !== undefined
        ? { sourceTurnId: candidate.sourceTurnId }
        : {}),
      dataUrl,
    }
  } catch {
    return renderedImage ?? createMetadataAttachment(id, candidate, 'unavailable')
  }
}

function deduplicateCandidates(
  candidates: readonly ExtractedAttachmentCandidate[],
): ExtractedAttachmentCandidate[] {
  const seen = new Map<string, number>()
  const unique: ExtractedAttachmentCandidate[] = []
  for (const candidate of candidates) {
    const key = [
      candidate.kind,
      candidate.name.normalize('NFKC').toLocaleLowerCase(),
      normalizeSourceIdentity(candidate.sourceUrl),
      candidate.sourceTurnId ?? '',
      String(candidate.messageIndex ?? -1),
    ].join('\0')
    const existingIndex = seen.get(key)
    if (existingIndex !== undefined) {
      const previous = unique[existingIndex]
      // A later sweep may expose a renewed signed URL or finish loading an
      // image. Keep that current source, retaining readable pixels only when
      // they came from the exact same rendered URL.
      unique[existingIndex] = candidate.renderedDataUrl === undefined &&
        previous.renderedDataUrl !== undefined &&
        previous.sourceUrl === candidate.sourceUrl
        ? { ...candidate, renderedDataUrl: previous.renderedDataUrl }
        : candidate
      continue
    }
    if (unique.length >= MAX_CAPTURE_CANDIDATES) {
      throw new Error('附件超过单次采集上限（100 个），未复制本轮附件；已保存的正文和附件保留')
    }
    seen.set(key, unique.length)
    unique.push(candidate)
  }
  return unique
}

export async function captureAttachments(
  candidates: readonly ExtractedAttachmentCandidate[],
  policy: AttachmentCapturePolicy,
  cache: Map<string, ConversationAttachment>,
): Promise<ConversationAttachment[]> {
  const uniqueCandidates = deduplicateCandidates(candidates)
  const ids = await Promise.all(
    uniqueCandidates.map((candidate) => createAttachmentId(candidate)),
  )
  const results = new Array<ConversationAttachment>(uniqueCandidates.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(ATTACHMENT_FETCH_CONCURRENCY, uniqueCandidates.length) },
    async () => {
      while (cursor < uniqueCandidates.length) {
        const index = cursor
        cursor += 1
        results[index] = await captureCandidate(
          uniqueCandidates[index],
          ids[index],
          policy,
          cache,
        )
      }
    },
  )
  await Promise.all(workers)

  let savedBytes = 0
  for (const [index, attachment] of results.entries()) {
    if (attachment.status !== 'saved' || attachment.dataUrl === undefined) {
      continue
    }
    const size = attachment.size ?? 0
    if (savedBytes + size > MAX_CONVERSATION_ATTACHMENT_BYTES) {
      results[index] = {
        ...attachment,
        status: 'too-large',
        dataUrl: undefined,
      }
      continue
    }
    savedBytes += size
    cache.set(attachment.id, attachment)
  }
  while (cache.size > MAX_ATTACHMENT_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value as string | undefined
    if (firstKey === undefined) {
      break
    }
    cache.delete(firstKey)
  }
  return results
}

export function getAttachmentMaximumBytes(maximumSizeMb: number): number {
  return Math.round(maximumSizeMb * BYTES_PER_MEBIBYTE)
}
