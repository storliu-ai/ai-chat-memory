import type { ChatMessage, ConversationSavePayload, ExtractedConversation } from '../../shared/models'
import { findShareAnchor } from '../../shared/share-capture'
import { normalizeGeminiDisplayText, renderGeminiAnswer } from './network-presentation'

// Weak keys do not extend the lifetime of source text after its task is released.
const displayKeys = new WeakMap<ChatMessage, { role: string; content: string; key: string }>()
function displayKey(message: ChatMessage): string {
  const cached = displayKeys.get(message)
  if (cached?.content === message.content && cached.role === message.role) return cached.key
  let key = JSON.stringify([message.role, 'literal', message.content])
  if (message.role === 'user' && !/```|~~~/.test(message.content)) key = JSON.stringify(['user', 'prose', message.content.replace(/\s+/g, '')])
  else if (message.role === 'assistant') {
    try {
      const proof = renderGeminiAnswer(message.content, true).evidence
      key = JSON.stringify(['assistant', normalizeGeminiDisplayText(proof.displayText), proof.blocks.map((block) => [block.language.toLowerCase(), block.content.replace(/\r\n/g, '\n').replace(/\n$/, '')]), proof.inline])
    } catch { /* Unsupported markup can match only its exact literal text. */ }
  }
  displayKeys.set(message, { role: message.role, content: message.content, key })
  return key
}
const exactKey = (message: ChatMessage): string => JSON.stringify([message.role, message.content])

function equivalentMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role) return false
  if (left.content === right.content) return true
  return displayKey(left) === displayKey(right)
}

export function hasGeminiDomHead(source: readonly ChatMessage[], incoming: readonly ChatMessage[]): boolean {
  const pair = incoming.slice(-2)
  if (pair.length !== 2 || pair[0].role !== 'user' || pair[1].role !== 'assistant') return false
  const matches = (messages: readonly ChatMessage[]): number => messages.reduce((count, message, index) => count + (index + 1 < messages.length && equivalentMessage(message, pair[0]) && equivalentMessage(messages[index + 1], pair[1]) ? 1 : 0), 0)
  return matches(source) === 1 && matches(incoming) === 1
}

/** Compare the entire overlap with exact code before retaining source formatting.
 * Appending a source tail additionally requires consecutive paired DOM slots. */
export function alignGeminiDomShare(source: ExtractedConversation, incoming: ExtractedConversation): ExtractedConversation {
  const left = source.messages, right = incoming.messages
  if (!hasGeminiDomHead(left, right)) throw new Error('请在原对话显示分享末轮问答，或更新整条对话分享后重试')
  const candidates = new Set<number>()
  for (let index = 0; index + 1 < right.length; index += 1) if (equivalentMessage(left[0], right[index]) && equivalentMessage(left[1], right[index + 1])) candidates.add(index)
  for (let index = 0; index + 1 < left.length; index += 1) if (equivalentMessage(left[index], right[0]) && equivalentMessage(left[index + 1], right[1])) candidates.add(-index)
  if (candidates.size > 32) throw new Error('分享正文重复，无法唯一对应原对话')
  const valid = [...candidates].filter((offset) => {
    const start = Math.max(0, offset), end = Math.min(right.length, offset + left.length)
    const covered = end - start
    const extendsSource = offset < 0 || offset + left.length > right.length
    return (!extendsSource || source.domWindowContiguous === true) && covered >= 2 && (covered === Math.min(left.length, right.length) || source.domWindowContiguous === true && incoming.domWindowContiguous === true) && right.slice(start, end).every((message, index) => equivalentMessage(left[start + index - offset], message))
  })
  if (valid.length !== 1) throw new Error('Gemini 分享与原页的完整消息窗口无法唯一对应，请更新分享后重试')
  const offset = valid[0]
  const messages = right.map((message, index) => left[index - offset] ? { ...message, content: left[index - offset].content } : message)
  return { ...incoming, messages, domMessageAliases: messages.map((message, index) => [...new Set([...(incoming.domMessageAliases?.[index] ?? []), right[index].content, message.content])]) }
}

export function mergeGeminiDomShare(source: ExtractedConversation, incoming: ExtractedConversation): ExtractedConversation {
  const shared = alignGeminiDomShare(source, incoming)
  const head = shared.messages.slice(-2)
  const sourceHead = source.messages.findIndex((message, index) => index + 1 < source.messages.length && equivalentMessage(message, head[0]) && equivalentMessage(source.messages[index + 1], head[1]))
  const offset = shared.messages.length - 2 - sourceHead
  const begin = Math.min(0, offset), end = Math.max(shared.messages.length, offset + source.messages.length)
  const messages: ChatMessage[] = [], aliases: string[][] = []
  for (let position = begin; position < end; position += 1) {
    const sourceIndex = position - offset, local = source.messages[sourceIndex], remote = shared.messages[position]
    if (!local && !remote) throw new Error('Gemini 分享补全仍有消息缺口')
    messages.push({ ...(local ?? remote) })
    aliases.push([...new Set([...(source.domMessageAliases?.[sourceIndex] ?? []), ...(shared.domMessageAliases?.[position] ?? []), (local ?? remote).content])])
  }
  const attachments = new Map<string, NonNullable<ExtractedConversation['attachmentCandidates']>[number]>()
  for (const [snapshot, displacement] of [[shared, -begin], [source, offset - begin]] as const) {
    for (const candidate of snapshot.attachmentCandidates ?? []) {
      const positioned = { ...candidate, sourceTurnId: undefined, ...(candidate.messageIndex !== undefined ? { messageIndex: candidate.messageIndex + displacement } : {}) }
      const key = JSON.stringify([positioned.kind, positioned.name.normalize('NFKC').toLowerCase(), positioned.messageIndex])
      const previous = attachments.get(key)
      if (!previous || positioned.sourceUrl !== null || previous.sourceUrl === null) attachments.set(key, positioned)
    }
  }
  return { ...source, messages, domMessageAliases: aliases, domWindowContiguous: true, attachmentCandidates: [...attachments.values()], captureComplete: true }
}

/** Numeric DOM positions prove coverage within one page, never cross-page identity. */
export function portableGeminiDomCapture(capture: ExtractedConversation): ExtractedConversation {
  const first = capture.messages[0]?.sourceOrder
  const contiguous = Number.isSafeInteger(first) && first! >= 0 && capture.messages.length % 2 === 0 && capture.messages.every((message, index) => message.sourceOrder === first! + index && message.role === (index % 2 ? 'assistant' : 'user'))
  return { ...capture, domWindowContiguous: contiguous || capture.domWindowContiguous === true, messages: capture.messages.map((message) => {
    const clean = { ...message }
    delete clean.sourceMessageId; delete clean.sourceTurnId; delete clean.sourceOrder
    return clean
  }), attachmentCandidates: capture.attachmentCandidates?.map((candidate) => ({ ...candidate, sourceTurnId: undefined })) }
}

/** Called only by the worker for a ready, account/document-bound DOM task.
 * Reuse exact local text after matching visible DOM/code; never rewrite it. */
export function retainGeminiDomShareText(payload: ConversationSavePayload, existing: readonly ChatMessage[], witnesses: readonly ExtractedConversation[]): ConversationSavePayload {
  const incoming = payload.messages
  const byDisplay = new Map<string, Set<string>>(), byExact = new Map<string, Set<string>>()
  const add = (index: Map<string, Set<string>>, key: string, values: Iterable<string>): void => {
    const entries = index.get(key) ?? new Set<string>()
    for (const value of values) entries.add(value)
    index.set(key, entries)
  }
  for (const message of incoming) {
    add(byDisplay, displayKey(message), [message.content]); add(byExact, exactKey(message), [message.content])
  }
  const aliasesByDisplay = new Map<string, Set<string>>(), aliasesByExact = new Map<string, Set<string>>()
  for (const capture of witnesses) capture.messages.forEach((visible, index) => {
    const values = new Set([...(byDisplay.get(displayKey(visible)) ?? []), ...(byExact.get(exactKey(visible)) ?? [])])
    for (const alias of capture.domMessageAliases?.[index] ?? []) {
      const message = { role: visible.role, content: alias }
      add(aliasesByDisplay, displayKey(message), values); add(aliasesByExact, exactKey(message), values)
    }
  })
  const projected = existing.map((message) => {
    const key = displayKey(message), exact = exactKey(message)
    const values = [...new Set([...(byDisplay.get(key) ?? []), ...(byExact.get(exact) ?? []), ...(aliasesByDisplay.get(key) ?? []), ...(aliasesByExact.get(exact) ?? [])])]
    return { role: message.role, content: values.length === 1 ? values[0] : message.content }
  })
  if (!existing.length) return payload
  const anchor = findShareAnchor(projected, incoming)
  if (!anchor || anchor.length !== Math.min(existing.length, incoming.length) || anchor.source !== 0 && anchor.incoming !== 0) throw new Error('分享与本地历史无法完整对应，已保留旧记录；请更新整条分享或使用本页采集')
  const offset = anchor.incoming - anchor.source
  return { ...payload, messages: incoming.map((message, index) => {
    const previous = existing[index - offset]
    if (!previous) return message
    if (projected[index - offset].role !== message.role || projected[index - offset].content !== message.content) throw new Error('分享与本地正文对应冲突，未覆盖原记录')
    const retained = { ...previous }
    delete retained.sourceOrder
    return retained
  }) }
}
