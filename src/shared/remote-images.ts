export const REMOTE_IMAGE_HOST_PERMISSIONS = [
  'https://lh3.googleusercontent.com/*',
  // Gemini's rendered rd-gg URLs redirect through this exact host before
  // returning the image response. It is never accepted as a caller-supplied
  // source URL; the permission only lets fetch follow Google's redirect chain.
  'https://lh3.google.com/*',
  'https://*.oaiusercontent.com/*',
  'https://images.openai.com/*',
] as const

export const MAX_REMOTE_IMAGE_URL_LENGTH = 8_192

export function isPermittedRemoteImageUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REMOTE_IMAGE_URL_LENGTH) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (
        url.hostname === 'lh3.googleusercontent.com' ||
        url.hostname === 'images.openai.com' ||
        url.hostname === 'oaiusercontent.com' ||
        url.hostname.endsWith('.oaiusercontent.com')
      )
    )
  } catch {
    return false
  }
}

export function isPermittedRemoteImageForHost(
  value: string,
  hostOrigin: string,
): boolean {
  if (!isPermittedRemoteImageUrl(value)) {
    return false
  }
  const hostname = new URL(value).hostname
  if (hostOrigin === 'https://gemini.google.com') {
    return hostname === 'lh3.googleusercontent.com'
  }
  if (hostOrigin === 'https://chatgpt.com') {
    return hostname === 'images.openai.com' ||
      hostname === 'oaiusercontent.com' || hostname.endsWith('.oaiusercontent.com')
  }
  return false
}

export function getOriginalRemoteImageUrl(value: string): string | null {
  if (!isPermittedRemoteImageUrl(value)) {
    return null
  }
  const url = new URL(value)
  if (
    url.hostname !== 'lh3.googleusercontent.com' ||
    !url.pathname.startsWith('/rd-gg/') ||
    !/=s\d+(?:-[a-z0-9-]+)?$/i.test(url.pathname)
  ) {
    return null
  }
  url.pathname = url.pathname.replace(/=s\d+(?:-[a-z0-9-]+)?$/i, '=s0')
  return url.href === value ? null : url.href
}
