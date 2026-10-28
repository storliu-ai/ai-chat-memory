import type { CaptureEndpoint, CaptureEndpointTarget } from '../../shared/network-capture'

const NATIVE_ID = /^[a-f0-9]{8,128}$/i
const SHARE_ID = /^[a-f0-9]{8,128}$/i
export const GEMINI_HISTORY_RPC = 'hNvQHb'
export const GEMINI_SHARE_RPC = 'ujx1Bf'

function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null
  } catch { return null }
}

export function getGeminiSourceId(value: unknown): string | null {
  const url = safeUrl(value)
  const match = url?.hostname === 'gemini.google.com' ? /^(?:\/u\/\d+)?\/app\/([^/]+)\/?$/.exec(url.pathname) : null
  return match && NATIVE_ID.test(match[1]) ? match[1] : null
}

export function getGeminiAccountContext(value: string): string | null {
  const url = safeUrl(value)
  if (!url || !getGeminiSourceId(value)) return null
  const routeSlot = /^\/u\/(\d+)\//.exec(url.pathname)?.[1]
  const querySlots = url.searchParams.getAll('authuser')
  if (querySlots.length > 1 || routeSlot !== undefined && querySlots.length && Number(querySlots[0]) !== Number(routeSlot)) return null
  const slot = routeSlot ?? querySlots[0] ?? '0'
  return /^\d{1,4}$/.test(slot) ? `google-slot:${Number(slot)}` : null
}

export function getGeminiSourceUrl(value: string): string | null {
  const url = safeUrl(value)
  if (!url || !getGeminiSourceId(value) || !getGeminiAccountContext(value)) return null
  const authuser = url.searchParams.get('authuser')
  return url.origin + url.pathname.replace(/\/$/, '') + (authuser && !/^\/u\/\d+\//.test(url.pathname) ? `?authuser=${Number(authuser)}` : '')
}

export function normalizeGeminiShareUrl(value: unknown): string | null {
  const url = safeUrl(value)
  if (!url) return null
  if (url.hostname === 'gemini.google.com') {
    const match = /^(?:\/u\/\d+)?\/share\/([^/]+)\/?$/.exec(url.pathname)
    return match && SHARE_ID.test(match[1]) ? `https://gemini.google.com/share/${match[1]}` : null
  }
  if (url.hostname === 'share.gemini.google' && /^\/[A-Za-z0-9_-]{8,64}\/?$/.test(url.pathname)) {
    return url.origin + url.pathname.replace(/\/$/, '')
  }
  return null
}

export function getGeminiShareId(value: unknown): string | null {
  const normalized = normalizeGeminiShareUrl(value)
  return normalized?.startsWith('https://gemini.google.com/share/') ? normalized.split('/').at(-1)! : null
}

/** Only an explicitly supplied public Google short link is expanded. No RPC,
 * cookies, request body or page body is used to resolve the canonical URL. */
export async function resolveGeminiShareUrl(value: unknown): Promise<string> {
  const normalized = normalizeGeminiShareUrl(value)
  if (!normalized) throw new Error('请提供有效的 Gemini 整条对话分享链接')
  if (getGeminiShareId(normalized)) return normalized
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(normalized, { method: 'GET', credentials: 'omit', redirect: 'follow', signal: controller.signal, referrerPolicy: 'no-referrer' })
    await response.body?.cancel()
    const canonical = normalizeGeminiShareUrl(response.url)
    if (!response.ok || !canonical || !getGeminiShareId(canonical)) throw new Error('unresolved')
    return canonical
  } catch {
    throw new Error('Gemini 短链接未能展开；请先在浏览器打开，再复制完整分享页地址')
  } finally { clearTimeout(timer) }
}

/** POST bodies may carry authentication values and are never inspected. The
 * document/loader and decoded native graph provide independent identity proof. */
export function matchGeminiCaptureEndpoint(value: string, target: CaptureEndpointTarget): CaptureEndpoint | null {
  const url = safeUrl(value)
  if (!url || url.hostname !== 'gemini.google.com' || url.pathname !== '/_/BardChatUi/data/batchexecute') return null
  const rpc = target.mode === 'share' ? GEMINI_SHARE_RPC : GEMINI_HISTORY_RPC
  return url.searchParams.getAll('rpcids').length === 1 && url.searchParams.get('rpcids') === rpc ? target.mode === 'share' ? 'share' : 'initial' : null
}
