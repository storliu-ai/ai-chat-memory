import type { ChatMessage, ExtractedAttachmentCandidate, ExtractedConversation } from './models'

export type ChatGPTCaptureMode = 'conversation' | 'share'
export type ShareCapturePhase = 'loading' | 'scanning' | 'needs-foreground' | 'ready' | 'complete' | 'cancelled' | 'failed'

export const SHARE_SOURCE_CONTEXT_REQUEST = 'AI_CHAT_MEMORY_SHARE_SOURCE_CONTEXT'
export const SHARE_TASK_STATUS_EVENT = 'AI_CHAT_MEMORY_SHARE_TASK_STATUS'

export interface ShareCaptureStatus {
  /** Older tasks without this field belong to ChatGPT. */
  platform?: 'chatgpt' | 'gemini'
  id: string
  conversationId: string
  originTabId: number
  captureTabId: number | null
  phase: ShareCapturePhase
  messageCount: number
  /** Monotonic scan/stage estimate; 100 is reserved for a confirmed save. */
  progress?: number
  message: string
  updatedAt: number
}

export interface ShareCaptureResponse {
  status: ShareCaptureStatus | null
  capture?: ExtractedConversation
}

export function getShareCaptureProgress(status: ShareCaptureStatus | null): number {
  if (status?.phase === 'complete') return 100
  if (status?.phase === 'ready') return 95
  return Math.min(85, Math.max(3, status?.progress ?? 3))
}

export function normalizeChatGPTShareUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null
  try {
    const url = new URL(value.trim())
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.port) return null
    const match = /^\/share\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname)
    return match ? `https://chatgpt.com/share/${match[1].toLowerCase()}` : null
  } catch {
    return null
  }
}

export function getChatGPTSourceId(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '')
    return url.origin === 'https://chatgpt.com'
      ? /^\/c\/([^/?#]+)\/?$/.exec(url.pathname)?.[1] ?? null
      : null
  } catch {
    return null
  }
}

function sameText(left: ChatMessage, right: ChatMessage): boolean {
  return left.role === right.role && left.content === right.content
}

function identity(message: ChatMessage): string | null {
  const id = message.sourceMessageId ?? message.sourceTurnId
  return id ? `${message.role}\0${id}` : null
}

function sharedIdentity(left: ChatMessage, right: ChatMessage): boolean {
  return !!left.sourceMessageId && left.sourceMessageId === right.sourceMessageId ||
    !left.sourceMessageId && !right.sourceMessageId && !!left.sourceTurnId && left.sourceTurnId === right.sourceTurnId
}

function sameAnchorMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (!sameText(left, right)) return false
  if (left.sourceMessageId && right.sourceMessageId) return left.sourceMessageId === right.sourceMessageId
  if (!left.sourceMessageId && !right.sourceMessageId && left.sourceTurnId && right.sourceTurnId) return left.sourceTurnId === right.sourceTurnId
  return true
}

/** A unique contiguous question/answer anchor binds a public snapshot to its source.
 * Numeric turn positions and titles alone are insufficient identity evidence. */
export function findShareAnchor(source: readonly ChatMessage[], incoming: readonly ChatMessage[], verifiedNativeIds = false): { source: number; incoming: number; length: number } | null {
  const positions = new Map<string, number[]>()
  // Only a background-verified network save may use this option. Ordinary DOM
  // shares still require the exact text anchor and cannot assert this authority.
  const key = (message: ChatMessage): string => `${message.role}\0${verifiedNativeIds && message.sourceMessageId ? `id:${message.sourceMessageId}` : `text:${message.content}`}`
  const matchesAnchor = (left: ChatMessage, right: ChatMessage): boolean => verifiedNativeIds && !!left.sourceMessageId && !!right.sourceMessageId
    ? left.role === right.role && left.sourceMessageId === right.sourceMessageId
    : sameAnchorMessage(left, right)
  incoming.forEach((message, index) => {
    const indexes = positions.get(key(message)) ?? []
    indexes.push(index)
    positions.set(key(message), indexes)
  })
  const candidates = new Map<number, { source: number; incoming: number; length: number; identities: number }>()
  const covered = new Map<number, number>()
  for (let s = 0; s < source.length - 1; s += 1) {
    const matches = (positions.get(key(source[s])) ?? []).filter((index) => matchesAnchor(source[s], incoming[index]))
    // Repeated boilerplate cannot serve as reliable conversation identity.
    if (matches.length > 32) continue
    for (const i of matches) {
      const offset = i - s
      if ((covered.get(offset) ?? -1) >= s) continue
      let length = 0
      while (s + length < source.length && i + length < incoming.length && matchesAnchor(source[s + length], incoming[i + length])) length += 1
      covered.set(offset, s + length - 2)
      const window = source.slice(s, s + length)
      const identities = window.filter((message, index) => sharedIdentity(message, incoming[i + index])).length
      if (length >= 2 && window.some((message) => message.role === 'user') && window.some((message) => message.role === 'assistant') && (identities === length || window.reduce((total, message) => total + message.content.length, 0) >= 32)) {
        const previous = candidates.get(offset)
        if (!previous || identities > previous.identities || identities === previous.identities && length > previous.length) candidates.set(offset, { source: s, incoming: i, length, identities })
      }
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.identities - a.identities || b.length - a.length)
  const best = ranked[0]
  if (!best || ranked.some((candidate) => candidate !== best && candidate.identities === best.identities && candidate.length === best.length)) return null
  return { source: best.source, incoming: best.incoming, length: best.length }
}

function supplementByIdentity(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] | null {
  const localKeys = existing.map(identity)
  const sharedKeys = incoming.map(identity)
  if (localKeys.includes(null) || sharedKeys.includes(null)) return null
  if (new Set(localKeys).size !== localKeys.length || new Set(sharedKeys).size !== sharedKeys.length) throw new Error('分享或本地存在重复消息 ID，未覆盖已有副本')
  const sharedIndexes = new Map(sharedKeys.map((key, index) => [key, index]))
  const common = localKeys.flatMap((key, index) => sharedIndexes.has(key) ? [{ local: index, shared: sharedIndexes.get(key)! }] : [])
  if (!common.length) return null
  if (common.some((entry, index) => index > 0 && entry.shared <= common[index - 1].shared)) throw new Error('分享与本地消息 ID 的顺序冲突，未覆盖已有副本')
  const localByKey = new Map(localKeys.map((key, index) => [key, existing[index]]))
  const ordersComparable = existing.every((message) => message.sourceOrder !== undefined) && incoming.every((message) => message.sourceOrder !== undefined) &&
    common.every(({ local, shared }) => existing[local].sourceOrder === incoming[shared].sourceOrder)
  const result = incoming.map((message) => {
    const local = localByKey.get(identity(message))
    const names = local && sameText(local, message) ? [...new Set([...(local.attachmentNames ?? []), ...(message.attachmentNames ?? [])])] : local?.attachmentNames
    const merged = { ...message, ...local, ...(names?.length ? { attachmentNames: names } : {}) }
    // Public search indexes do not belong to the native conversation. Retain
    // numeric metadata only when common identities prove the same numbering.
    if (!ordersComparable) delete merged.sourceOrder
    return merged
  })
  for (let start = 0; start < existing.length;) {
    if (sharedIndexes.has(localKeys[start])) { start += 1; continue }
    let end = start + 1
    while (end < existing.length && !sharedIndexes.has(localKeys[end])) end += 1
    const before = start > 0 ? localKeys[start - 1] : null
    const after = end < existing.length ? localKeys[end] : null
    const beforeIndex = before === null ? -1 : result.findIndex((message) => identity(message) === before)
    const afterIndex = after === null ? result.length : result.findIndex((message) => identity(message) === after)
    if (after !== null && afterIndex !== beforeIndex + 1) throw new Error('分享与本地未匹配消息的顺序无法可靠核对，未覆盖已有副本')
    const extra = existing.slice(start, end).map((message) => {
      const copy = { ...message }
      if (!ordersComparable) delete copy.sourceOrder
      return copy
    })
    result.splice(afterIndex, 0, ...extra)
    start = end
  }
  if (result.some((message, index) => message.sourceOrder !== undefined && index > 0 && result[index - 1].sourceOrder !== undefined && message.sourceOrder <= result[index - 1].sourceOrder!)) {
    result.forEach((message) => { delete message.sourceOrder })
  }
  return result
}

/** Older public snapshots may fill holes, but local text and source times win. */
export function supplementConversationMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[], verifiedNativeIds = false): ChatMessage[] {
  if (existing.length === 0) return incoming.map((message) => ({ ...message }))
  const anchor = findShareAnchor(existing, incoming, verifiedNativeIds)
  if (anchor === null) throw new Error('分享内容与原对话缺少唯一的问题和回答锚点，请更新整条对话的分享链接后重试')
  const identified = supplementByIdentity(existing, incoming)
  if (identified !== null) return identified
  // Without common stable identities only a contiguous local window can be
  // placed safely. Never guess across a sparse original-page window.
  if (anchor.length !== Math.min(existing.length, incoming.length) || (anchor.source !== 0 && anchor.incoming !== 0)) throw new Error('分享与本地消息的顺序无法可靠核对，未覆盖已有副本')
  const offset = anchor.incoming - anchor.source
  const begin = Math.min(0, offset)
  const end = Math.max(incoming.length, offset + existing.length)
  const result: ChatMessage[] = []
  for (let position = begin; position < end; position += 1) {
    const local = existing[position - offset]
    const shared = incoming[position]
    const message = local ?? shared
    if (!message) throw new Error('分享补全仍存在消息缺口')
    result.push({ ...message })
  }
  return result
}

/** Keep originating-page uploads even when the public page omits their cards. */
export function supplementShareCapture(source: ExtractedConversation, incoming: ExtractedConversation): ExtractedConversation {
  const messages = supplementConversationMessages(source.messages, incoming.messages)
  const candidates = new Map<string, ExtractedAttachmentCandidate>()
  for (const snapshot of [incoming, source]) {
    const anchor = findShareAnchor(snapshot.messages, messages)
    for (const candidate of snapshot.attachmentCandidates ?? []) {
      const sourceIndex = candidate.messageIndex ?? snapshot.messages.findIndex((message) => message.sourceTurnId === candidate.sourceTurnId)
      const message = snapshot.messages[sourceIndex]
      let indexes: number[] = []
      if (message) {
        indexes = messages.flatMap((final, index) => final.role === message.role && sharedIdentity(message, final) ? [index] : [])
        if (indexes.length === 0 && anchor && sourceIndex >= anchor.source && sourceIndex < anchor.source + anchor.length) {
          indexes = [sourceIndex + anchor.incoming - anchor.source]
        }
      }
      const positioned = { ...candidate }
      if (indexes.length === 1) {
        positioned.messageIndex = indexes[0]
        positioned.sourceTurnId = messages[indexes[0]].sourceTurnId
      } else {
        // Retain unpositioned metadata rather than attaching a file to a
        // repeated question or reusing a page-local index from another page.
        delete positioned.messageIndex
        delete positioned.sourceTurnId
      }
      const key = [positioned.kind, positioned.name.normalize('NFKC').toLocaleLowerCase(), positioned.messageIndex ?? '', positioned.sourceTurnId ?? ''].join('\0')
      const previous = candidates.get(key)
      // An actual rendered source URL is more useful than a metadata-only card.
      if (!previous || positioned.sourceUrl !== null || previous.sourceUrl === null) candidates.set(key, positioned)
    }
  }
  return { ...source, messages, attachmentCandidates: [...candidates.values()], captureComplete: true }
}
