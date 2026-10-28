import type { ChatMessage } from '../../shared/models'
import type { CaptureEndpoint, CaptureEndpointTarget, RenderedMessageEvidence } from '../../shared/network-capture'
import { matchesGeminiDisplay, renderGeminiAnswer, type GeminiAnswerPresentation } from './network-presentation'

interface Turn {
  id: string
  parent: string | null
  parentCandidate: string | null
  candidate: string
  question: string
  answer: GeminiAnswerPresentation
  withoutSuggestions: GeminiAnswerPresentation
}
const fail = (): never => { throw new Error('Gemini 接口历史、分支或显示内容无法完整核对，请重新采集或使用 DOM') }
const parse = (value: string): unknown => {
  try { return JSON.parse(value) } catch { return fail() }
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail()
const native = (value: unknown, prefix: string): string => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{8,128}$`, 'i').test(value) ? value : fail()
const text = (value: unknown): string => typeof value === 'string' && value.length <= 12_000_000 ? value : fail()
function matchesQuestion(source: string, rendered: string): boolean {
  const lines = (value: string): string => value.replace(/\r\n/g, '\n').trim()
  if (lines(source) === lines(rendered)) return true
  // Gemini wraps rich prompt fragments with layout whitespace. Keep the DOM's
  // formatting when it differs; never use this relaxation for fenced code.
  if (/```|~~~/.test(source + rendered)) return false
  return source.replace(/\s+/g, '') === rendered.replace(/\s+/g, '')
}
function presentationFor(turn: Turn, rendered: RenderedMessageEvidence): GeminiAnswerPresentation | null {
  if (matchesGeminiDisplay(turn.answer.evidence, rendered)) return turn.answer
  // The native app omits old suggestion groups that the public share renders.
  // Only the entire known action-only group can be absent; body/code stay exact.
  return matchesGeminiDisplay(turn.withoutSuggestions.evidence, rendered) ? turn.withoutSuggestions : null
}

/** Google's length marker uses UTF-16 JSON length plus two framing characters.
 * Require every frame, including trailing metadata, to be complete. */
export function decodeGeminiRpc(body: string, rpc: string): unknown {
  if (!body.startsWith(")]}'\n") || body.length > 64 * 1024 * 1024) return fail()
  const lines = body.slice(5).split('\n')
  let found = false, result: unknown
  for (let index = 0; index < lines.length;) {
    if (!lines[index]) { index += 1; continue }
    const size = lines[index++]
    if (!/^\d{1,9}$/.test(size) || index >= lines.length) return fail()
    const line = lines[index++]
    if (Number(size) !== line.length + 2 || index >= lines.length) return fail()
    const frame = array(parse(line))
    for (const entry of frame) {
      const row = array(entry)
      if (row[0] !== 'wrb.fr') continue
      if (row[1] !== rpc || found || typeof row[2] !== 'string') return fail()
      result = parse(row[2]); found = true
    }
  }
  return found ? result : fail()
}

export class GeminiNetworkEvidence {
  private readonly turns = new Map<string, Turn>()
  private terminal = false
  private initial = false
  private readonly target: CaptureEndpointTarget
  constructor(target: CaptureEndpointTarget) { this.target = target }

  add(body: string, endpoint: CaptureEndpoint): number {
    const share = this.target.mode === 'share'
    if (endpoint !== (share ? 'share' : 'initial')) return fail()
    const payload = array(decodeGeminiRpc(body, share ? 'ujx1Bf' : 'hNvQHb'))
    let entries: unknown[]
    if (share) {
      const snapshot = array(payload[0])
      if (snapshot[3] !== this.target.id) return fail()
      entries = array(snapshot[1]); this.terminal = true
    } else {
      entries = array(payload[0])
      if (payload[1] !== null && (typeof payload[1] !== 'string' || !payload[1] || payload[1].length > 32_000)) return fail()
      this.terminal ||= payload[1] === null
    }
    if (!entries.length || entries.length > 5000) return fail()
    const cid = `c_${this.target.sourceId ?? this.target.id}`
    for (const entry of entries) {
      const raw = array(entry), key = array(raw[0]), parent = raw[1] == null ? [] : array(raw[1])
      if (key[0] !== cid || parent.length && parent[0] && parent[0] !== cid) return fail()
      const id = native(key[1], 'r')
      const parentId = parent[1] ? native(parent[1], 'r') : null
      const parentCandidate = parentId ? native(parent[2], 'rc') : null
      const response = array(raw[3]), selected = native(response[3], 'rc')
      const candidates = array(response[0]).map(array).filter((candidate) => candidate[0] === selected)
      if (candidates.length !== 1) return fail()
      const parts = array(candidates[0][1])
      if (parts.length !== 1) return fail()
      const question = text(array(array(raw[2])[0])[0])
      const rawAnswer = text(parts[0])
      const turn: Turn = { id, parent: parentId, parentCandidate, candidate: selected, question, answer: renderGeminiAnswer(rawAnswer), withoutSuggestions: renderGeminiAnswer(rawAnswer, true) }
      if (!question.trim() || !turn.answer.markdown.trim()) return fail()
      const previous = this.turns.get(id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(turn)) return fail()
      this.turns.set(id, turn)
      if (this.turns.size > 5000) return fail()
    }
    this.initial = true
    return entries.length
  }

  private ordered(): Turn[] | null {
    if (!this.initial || !this.terminal || !this.turns.size) return null
    const roots = [...this.turns.values()].filter((turn) => !turn.parent)
    if (roots.length !== 1) return null
    const children = new Map<string, Turn>()
    for (const turn of this.turns.values()) {
      if (!turn.parent) continue
      const parent = this.turns.get(turn.parent)
      if (!parent || parent.candidate !== turn.parentCandidate || children.has(turn.parent)) return null
      children.set(turn.parent, turn)
    }
    const ordered: Turn[] = [], seen = new Set<string>()
    let current: Turn | undefined = roots[0]
    while (current) {
      if (seen.has(current.id)) return null
      seen.add(current.id); ordered.push(current); current = children.get(current.id)
    }
    return ordered.length === this.turns.size ? ordered : null
  }

  get complete(): boolean { return this.ordered() !== null }
  get messageCount(): number { return this.turns.size * 2 }
  get needsAttachmentScan(): boolean { return true }
  reviewCandidate(): null { return null }
  clear(): void { this.turns.clear(); this.initial = false; this.terminal = false }

  matchesSource(capture: { messages: readonly ChatMessage[]; networkEvidence?: readonly RenderedMessageEvidence[] }, requireAll = false, requireHead = false): boolean {
    const ordered = this.ordered()
    if (!ordered || !capture.networkEvidence?.length) return false
    let matched = 0, previous = -1
    for (let index = 0; index + 1 < capture.messages.length; index += 1) {
      const user = capture.messages[index], assistant = capture.messages[index + 1]
      if (user.role !== 'user' || assistant.role !== 'assistant') continue
      const proof = capture.networkEvidence.find((item) => item.messageIndex === index + 1)
      const candidates = proof ? ordered.flatMap((turn, position) => matchesQuestion(turn.question, user.content) && presentationFor(turn, proof) ? [position] : []) : []
      if (!requireAll && candidates.length === 1 && (!requireHead || candidates[0] === ordered.length - 1)) return true
      if (!requireAll) continue
      if (candidates.length !== 1 || previous >= 0 && candidates[0] !== previous + 1) return false
      previous = candidates[0]; matched += 2; index += 1
    }
    return requireAll && matched === capture.messages.length && matched > 0
  }

  verify(rendered: readonly ChatMessage[], requireAttachmentEvidence = true, evidence?: readonly RenderedMessageEvidence[]): ChatMessage[] {
    if (!requireAttachmentEvidence) return fail()
    const ordered = this.ordered()
    if (!ordered || rendered.length !== ordered.length * 2 || !Array.isArray(evidence) || evidence.length !== ordered.length) return fail()
    const result: ChatMessage[] = []
    for (let index = 0; index < ordered.length; index += 1) {
      const turn = ordered[index], user = rendered[index * 2], assistant = rendered[index * 2 + 1]
      const proof = evidence.filter((item) => item.messageIndex === index * 2 + 1)
      const presentation = proof.length === 1 ? presentationFor(turn, proof[0]) : null
      if (user.role !== 'user' || assistant.role !== 'assistant' || !matchesQuestion(turn.question, user.content) || !presentation) return fail()
      result.push({ role: 'user', content: user.content, sourceTurnId: turn.id, sourceMessageId: `${turn.id}:user`, sourceOrder: index * 2,
        ...(user.attachmentNames ? { attachmentNames: user.attachmentNames } : {}) })
      result.push({ role: 'assistant', content: presentation.markdown, sourceTurnId: turn.id, sourceMessageId: turn.candidate, sourceOrder: index * 2 + 1,
        ...(assistant.attachmentNames ? { attachmentNames: assistant.attachmentNames } : {}) })
    }
    return result
  }
}
