import type {
  AttachmentKind,
  ExtractedAttachmentCandidate,
} from '../shared/models'

const MAX_ATTACHMENT_CANDIDATES = 100
const MAX_RENDERED_IMAGE_DATA_URL_LENGTH = 14_000_000
const MAX_RENDERED_IMAGE_PIXELS = 40_000_000
const IMAGE_EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}
const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const GENERIC_IMAGE_NAME = /^(?:image|photo|picture|preview|thumbnail|图片|图像|照片)$/i
const DECORATIVE_IMAGE = /(?:avatar|profile|logo|icon|emoji)/i
const NON_CONVERSATION_ASSET_NAME = /(?:^|[-_. ])(?:favicons?|apple[-_. ]touch[-_. ]icon|site[-_. ]icon)(?:[-_. ]|$)/i
const OPAQUE_RESOURCE_NAME = /^(?:[a-f0-9]{12,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB)\b/i

interface RenderedImageCacheEntry {
  sourceUrl: string | null
  width: number
  height: number
  mimeType: string | null
  dataUrl: string | null
}

const renderedImageDataCache = new WeakMap<
  HTMLImageElement,
  RenderedImageCacheEntry
>()

function normalizeName(value: string): string {
  const lastPathPart = (value.split(/[\\/]/).at(-1) ?? value).slice(0, 1_024)
  return [...lastPathPart]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)
}

export function isNonConversationAssetName(value: string): boolean {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // Keep the original value when a page provides malformed URL encoding.
  }
  return NON_CONVERSATION_ASSET_NAME.test(normalizeName(decoded))
}

function isNonConversationAsset(
  candidate: ExtractedAttachmentCandidate,
): boolean {
  if (isNonConversationAssetName(candidate.name)) {
    return true
  }
  if (candidate.sourceUrl === null || /^(?:data|blob):/i.test(candidate.sourceUrl)) {
    return false
  }
  try {
    return isNonConversationAssetName(new URL(candidate.sourceUrl, location.href).pathname)
  } catch {
    return false
  }
}

function getExtension(value: string): string {
  return /\.([a-z0-9]{1,10})(?:$|[?#])/i.exec(value)?.[1]?.toLowerCase() ?? ''
}

export function isOpaqueResourceName(value: string): boolean {
  return OPAQUE_RESOURCE_NAME.test(normalizeName(value))
}

export function isCredibleUrlOnlyFileName(value: string): boolean {
  const name = normalizeName(value)
  return name !== '' && getExtension(name) !== '' && !isOpaqueResourceName(name)
}

function getMimeTypeFromUrl(value: string): string | null {
  const dataMimeType = /^data:([^;,]+)/i.exec(value)?.[1]?.toLowerCase()
  if (dataMimeType) {
    return dataMimeType
  }
  return IMAGE_EXTENSION_TO_MIME[getExtension(value)] ?? null
}

function getNameFromUrl(value: string): string {
  if (/^(?:data|blob):/i.test(value)) {
    return ''
  }
  try {
    const url = new URL(value, location.href)
    for (const parameter of ['filename', 'file_name', 'name']) {
      const candidate = normalizeName(url.searchParams.get(parameter) ?? '')
      if (getExtension(candidate) !== '') {
        return candidate
      }
    }
    const rawName = (url.pathname.split('/').at(-1) ?? '').slice(0, 1_024)
    return normalizeName(decodeURIComponent(rawName))
  } catch {
    return ''
  }
}

function normalizeSourceUrl(value: string | null): string | null {
  if (!value) {
    return null
  }
  try {
    if (/^(?:data|blob):/i.test(value)) {
      return value
    }
    const url = new URL(value, location.href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function getAttributeValue(element: Element, names: readonly string[]): string {
  for (const name of names) {
    const value = normalizeName(element.getAttribute(name) ?? '')
    if (value !== '') {
      return value
    }
  }
  return ''
}

function getMimeType(element: Element, sourceUrl: string | null, name: string): string | null {
  for (const attribute of ['type', 'data-mime-type', 'data-content-type']) {
    const value = element.getAttribute(attribute)?.trim().toLowerCase()
    if (value && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)) {
      return value
    }
  }
  return getMimeTypeFromUrl(sourceUrl ?? '') ?? IMAGE_EXTENSION_TO_MIME[getExtension(name)] ?? null
}

function parseRenderedSize(element: Element): number | null {
  for (const attribute of ['data-size', 'data-file-size', 'data-bytes', 'size']) {
    const value = element.getAttribute(attribute)
    if (value !== null && /^\d+$/.test(value)) {
      const bytes = Number(value)
      if (Number.isSafeInteger(bytes) && bytes >= 0) {
        return bytes
      }
    }
  }
  const rendered = (element.textContent ?? '').slice(0, 1_000)
  const match = SIZE_PATTERN.exec(rendered)
  if (!match) {
    return null
  }
  const amount = Number(match[1])
  const units: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KIB: 1_024,
    MB: 1_000_000,
    MIB: 1_048_576,
    GB: 1_000_000_000,
    GIB: 1_073_741_824,
  }
  const bytes = Math.round(amount * units[match[2].toUpperCase()])
  return Number.isSafeInteger(bytes) ? bytes : null
}

function getElementSource(element: Element): string | null {
  const sourceElements = [
    element,
    ...Array.from(
      element.querySelectorAll('a[href], [data-download-url], [data-url]'),
    ),
  ]
  for (const sourceElement of sourceElements) {
    for (const attribute of ['data-download-url', 'data-url', 'href']) {
      const sourceUrl = normalizeSourceUrl(sourceElement.getAttribute(attribute))
      if (sourceUrl !== null) {
        return sourceUrl
      }
    }
  }
  return null
}

function getImageSource(image: HTMLImageElement): string | null {
  return normalizeSourceUrl(image.currentSrc || image.getAttribute('src'))
}

function getRenderedImageDataUrl(
  image: HTMLImageElement,
  mimeType: string | null,
): string | null {
  const sourceUrl = getImageSource(image)
  const width = image.naturalWidth
  const height = image.naturalHeight
  const cached = renderedImageDataCache.get(image)
  if (
    cached !== undefined &&
    cached.sourceUrl === sourceUrl &&
    cached.width === width &&
    cached.height === height &&
    cached.mimeType === mimeType
  ) {
    return cached.dataUrl
  }
  try {
    if (
      !image.complete ||
      width <= 0 ||
      height <= 0 ||
      width > 16_384 ||
      height > 16_384 ||
      width * height > MAX_RENDERED_IMAGE_PIXELS
    ) {
      return null
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) {
      return null
    }
    context.drawImage(image, 0, 0, width, height)
    const outputMimeType = mimeType === 'image/jpeg' || mimeType === 'image/webp'
      ? mimeType
      : 'image/png'
    const dataUrl = canvas.toDataURL(outputMimeType, 0.92)
    const result = dataUrl !== 'data:,' && dataUrl.length <= MAX_RENDERED_IMAGE_DATA_URL_LENGTH
      ? dataUrl
      : null
    renderedImageDataCache.set(image, {
      sourceUrl,
      width,
      height,
      mimeType,
      dataUrl: result,
    })
    return result
  } catch {
    // Cross-origin images can taint a canvas. The capture layer will still try
    // the original source URL when a rendered fallback is unavailable.
    if (image.complete && width > 0 && height > 0) {
      renderedImageDataCache.set(image, {
        sourceUrl,
        width,
        height,
        mimeType,
        dataUrl: null,
      })
    }
    return null
  }
}

function isDecorativeImage(image: HTMLImageElement, sourceUrl: string | null): boolean {
  if (
    sourceUrl === null ||
    sourceUrl.startsWith('chrome-extension:') ||
    image.getAttribute('aria-hidden') === 'true' ||
    image.closest('[data-extension-ui="ai-chat-memory"]') !== null
  ) {
    return true
  }
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (width > 0 && height > 0 && width <= 24 && height <= 24) {
    return true
  }
  const descriptor = [
    image.className,
    image.getAttribute('alt'),
    image.getAttribute('aria-label'),
  ].join(' ')
  return DECORATIVE_IMAGE.test(descriptor) && width <= 128 && height <= 128
}

function readImageCandidate(
  image: HTMLImageElement,
  imageIndex: number,
): ExtractedAttachmentCandidate | null {
  const sourceUrl = getImageSource(image)
  if (isDecorativeImage(image, sourceUrl)) {
    return null
  }
  const mimeType = getMimeType(image, sourceUrl, '')
  const urlName = getNameFromUrl(sourceUrl ?? '')
  const renderedName = getAttributeValue(image, ['data-file-name', 'alt', 'title'])
  const extension = MIME_TO_EXTENSION[mimeType ?? ''] ?? (getExtension(urlName) || 'png')
  const preferredName = renderedName !== '' && !GENERIC_IMAGE_NAME.test(renderedName)
    ? renderedName
    : urlName
  const name = preferredName !== ''
    ? preferredName
    : `image-${imageIndex + 1}.${extension}`
  const renderedDataUrl = getRenderedImageDataUrl(image, mimeType)
  return {
    name: getExtension(name) === '' ? `${name}.${extension}` : name,
    kind: 'image',
    mimeType,
    size: parseRenderedSize(image),
    sourceUrl,
    ...(renderedDataUrl !== null ? { renderedDataUrl } : {}),
  }
}

function readFileCandidate(element: Element): ExtractedAttachmentCandidate | null {
  const sourceUrl = getElementSource(element)
  const sourceElement = element.matches('a[href], [download]')
    ? element
    : element.querySelector('a[href], [download]') ?? element
  const nativeNameAttributes = [
    'download',
    'data-file-name',
    'data-filename',
  ] as const
  const nativeName = getAttributeValue(element, nativeNameAttributes) ||
    getAttributeValue(sourceElement, nativeNameAttributes)
  const accessibleName = getAttributeValue(element, ['title', 'aria-label']) ||
    getAttributeValue(sourceElement, ['title', 'aria-label'])
  const urlName = getNameFromUrl(sourceUrl ?? '')
  const renderedLines = (element.textContent ?? '')
    .split(/\r?\n/)
    .map(normalizeName)
    .filter((value) => value !== '' && !SIZE_PATTERN.test(value))
  // Overlay-style cards render the full filename in a descendant title and
  // concatenate the filename/type in textContent without a line separator.
  const titledName = Array.from(element.querySelectorAll('[title]'))
    .map((node) => normalizeName(node.getAttribute('title') ?? ''))
    .find((value) => getExtension(value) !== '') ?? ''
  const renderedName = titledName || renderedLines.find((value) => getExtension(value) !== '') || ''
  const renderedSize = parseRenderedSize(element)
  const declaredMimeType = getMimeType(sourceElement, null, '')
  const accessibleFileName = getExtension(accessibleName) !== ''
    ? accessibleName
    : ''
  const urlFileName = isCredibleUrlOnlyFileName(urlName) ? urlName : ''
  const name = nativeName || renderedName || accessibleFileName || urlFileName
  if (name === '') {
    return null
  }
  // Host resource links frequently end in an opaque object id. A broad
  // `[data-testid*="file"]` selector is not file evidence by itself: require
  // a real rendered/native name, type, or size before accepting an
  // extensionless identifier as an attachment.
  if (
    getExtension(name) === '' &&
    isOpaqueResourceName(name) &&
    renderedName === '' &&
    declaredMimeType === null &&
    renderedSize === null
  ) {
    return null
  }
  const mimeType = declaredMimeType ?? getMimeType(sourceElement, sourceUrl, name)
  const kind: AttachmentKind = mimeType?.startsWith('image/') === true ||
    getExtension(name) in IMAGE_EXTENSION_TO_MIME
    ? 'image'
    : 'file'
  const image = element instanceof HTMLImageElement
    ? element
    : element.querySelector('img')
  const resolvedSourceUrl = kind === 'image' && image !== null
    ? getImageSource(image) ?? sourceUrl
    : sourceUrl
  const renderedDataUrl = kind === 'image' && image !== null
    ? getRenderedImageDataUrl(image, mimeType)
    : null
  return {
    name,
    kind,
    mimeType,
    size: renderedSize,
    sourceUrl: resolvedSourceUrl,
    ...(renderedDataUrl !== null ? { renderedDataUrl } : {}),
  }
}

function queryAllSafely(root: ParentNode, selectors: readonly string[]): Element[] {
  try {
    return Array.from(root.querySelectorAll(selectors.join(',')))
  } catch {
    return []
  }
}

export function collectAttachmentCandidates(
  roots: readonly {
    root: ParentNode
    messageIndex?: number
    sourceTurnId?: string
    excludeWithin?: string
  }[],
  attachmentSelectors: readonly string[],
): ExtractedAttachmentCandidate[] {
  const candidates: ExtractedAttachmentCandidate[] = []
  const seen = new Set<string>()
  let imageIndex = 0

  const add = (
    candidate: ExtractedAttachmentCandidate | null,
    messageIndex: number | undefined,
    sourceTurnId: string | undefined,
  ): void => {
    if (
      candidate === null ||
      isNonConversationAsset(candidate) ||
      candidates.length >= MAX_ATTACHMENT_CANDIDATES
    ) {
      return
    }
    const positionedCandidate = {
      ...candidate,
      ...(messageIndex === undefined ? {} : { messageIndex }),
      ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
    }
    const key = `${positionedCandidate.kind}\0${positionedCandidate.name.toLocaleLowerCase()}\0${positionedCandidate.sourceUrl ?? ''}\0${positionedCandidate.sourceTurnId ?? ''}\0${positionedCandidate.messageIndex ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(positionedCandidate)
    }
  }

  for (const { root, messageIndex, sourceTurnId, excludeWithin } of roots) {
    for (const element of queryAllSafely(root, ['img[src]', 'img[srcset]'])) {
      if (excludeWithin && element.closest(excludeWithin)) continue
      if (element instanceof HTMLImageElement) {
        add(readImageCandidate(element, imageIndex), messageIndex, sourceTurnId)
        imageIndex += 1
      }
    }
    for (const element of queryAllSafely(root, attachmentSelectors)) {
      if (excludeWithin && element.closest(excludeWithin)) continue
      add(readFileCandidate(element), messageIndex, sourceTurnId)
    }
  }
  return candidates
}
