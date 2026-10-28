import type { RenderedMessageEvidence } from '../../shared/network-capture'

export type GeminiDisplayEvidence = Omit<RenderedMessageEvidence, 'messageIndex'>
export interface GeminiAnswerPresentation { markdown: string; evidence: GeminiDisplayEvidence }
interface Component { name: string; attributes: Record<string, string>; children: string[]; step: number; suggestionsOnly: boolean }

const fail = (): never => { throw new Error('Gemini 回答包含无法完整解释的显示组件，请使用 DOM 采集') }
const MAX_TEXT = 12_000_000
const ATTRIBUTES: Record<string, readonly string[]> = {
  Sequence: [], Step: ['title'], ElicitationsGroup: ['message'],
  Elicitation: ['label', 'query'], FollowUp: ['label', 'query'],
}

function entities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi, (token) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }
    if (named[token.toLowerCase()] !== undefined) return named[token.toLowerCase()]
    const hex = token[2]?.toLowerCase() === 'x'
    const point = Number.parseInt(token.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    if (!Number.isSafeInteger(point) || point < 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return fail()
    return String.fromCodePoint(point)
  })
}

function attributes(value: string, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {}
  let rest = value
  while (rest.trim()) {
    const match = /^\s+([A-Za-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/.exec(rest)
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(result, match[1])) return fail()
    const text = match[2] ?? match[3]
    if (text.length > 16_000) return fail()
    result[match[1]] = entities(text.replace(/\\(["'\\nrt])/g, (_token, escaped: string) => ({ n: '\n', r: '\r', t: '\t' }[escaped] ?? escaped)))
    rest = rest.slice(match[0].length)
  }
  return result
}

function dedent(value: string): string {
  const lines = value.replace(/^\s*\n/, '').replace(/\n\s*$/, '').split('\n')
  const occupied = lines.filter((line) => line.trim())
  const width = occupied.length ? occupied.reduce((minimum, line) => Math.min(minimum, /^[ \t]*/.exec(line)![0].length), Number.MAX_SAFE_INTEGER) : 0
  return lines.map((line) => line.slice(Math.min(width, /^[ \t]*/.exec(line)![0].length))).join('\n')
}

function renderComponent(component: Component): string {
  const body = dedent(component.children.join(''))
  if (component.name === 'Sequence') return `\n${body}\n`
  if (component.name === 'Step') {
    const title = component.attributes.title
    if (!title) return fail()
    return `\n### ${component.step}. ${title}\n\n${body}\n`
  }
  if (component.name === 'ElicitationsGroup') {
    if (!component.attributes.message) return fail()
    return `\n${component.attributes.message}\n\n${body}\n`
  }
  return fail()
}

/** A bounded display interpreter, not a JSX evaluator. Hidden render comments
 * and action queries never become archived prose. Code examples stay literal. */
export function renderGeminiAnswer(value: string, hideSuggestions = false): GeminiAnswerPresentation {
  if (value.length > MAX_TEXT || /[\uE000\uE001]/.test(value)) return fail()
  const blocks: GeminiDisplayEvidence['blocks'] = []
  const inline: string[] = []
  const root: Component = { name: '', attributes: {}, children: [], step: 0, suggestionsOnly: true }
  const stack: Component[] = [root]
  const append = (text: string, suggestion = false): void => {
    const current = stack.at(-1)!
    if (current.name === 'ElicitationsGroup' && text.trim() && !suggestion) current.suggestionsOnly = false
    current.children.push(text)
  }
  const plain = (raw: string): void => {
    const text = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    if (text.includes('{/*')) return fail()
    let offset = 0
    const tags = /<\/?([A-Za-z][A-Za-z0-9-]*)\b(?:[^>"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*>/g
    for (const match of text.matchAll(tags)) {
      append(text.slice(offset, match.index))
      const token = match[0], name = match[1]
      if (/^<br\s*\/?>$/i.test(token)) append('\n')
      else {
        if (!Object.hasOwn(ATTRIBUTES, name)) return fail()
        const closing = token.startsWith('</'), selfClosing = /\/\s*>$/.test(token)
        const attrStart = token.indexOf(name) + name.length
        const attrText = token.slice(attrStart, selfClosing ? token.lastIndexOf('/') : -1)
        if (closing) {
          if (attrText.trim() || stack.length < 2 || stack.at(-1)!.name !== name) return fail()
          append('')
          const node = stack.pop()!
          const rendered = renderComponent(node)
          append(hideSuggestions && node.name === 'ElicitationsGroup' && node.suggestionsOnly ? '' : rendered)
        } else {
          const props = attributes(attrText, ATTRIBUTES[name])
          if (name === 'Elicitation' || name === 'FollowUp') {
            if (!selfClosing || !props.label || name === 'Elicitation' && stack.at(-1)!.name !== 'ElicitationsGroup') return fail()
            if (!hideSuggestions || name !== 'FollowUp') append(`\n${name === 'Elicitation' ? '- ' : ''}${props.label}\n`, true)
          } else {
            if (selfClosing || stack.length >= 32 || name === 'Step' && stack.at(-1)!.name !== 'Sequence') return fail()
            const step = name === 'Step' ? ++stack.at(-1)!.step : 0
            stack.push({ name, attributes: props, children: [], step, suggestionsOnly: true })
          }
        }
      }
      offset = match.index! + token.length
    }
    const remaining = text.slice(offset)
    if (/<\/?(?:Sequence|Step|ElicitationsGroup|Elicitation|FollowUp)\b/.test(remaining)) return fail()
    append(remaining)
  }

  let offset = 0
  const code = /(```|~~~)([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*(?=\n|$)|`[^`\n]*`/gm
  for (const match of value.matchAll(code)) {
    plain(value.slice(offset, match.index))
    if (match[1]) {
      const language = match[2].trim()
      if (!/^[A-Za-z0-9_+.#-]{0,40}$/.test(language) || blocks.length >= 1000) return fail()
      const indentation = /(?:^|\n)([ \t]*)$/.exec(value.slice(0, match.index))?.[1] ?? ''
      const content = match[3].split('\n').map((line) => indentation && line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n').replace(/\n$/, '')
      blocks.push({ language, content })
      append(`\uE000BLOCK${blocks.length - 1}\uE001`)
    } else {
      if (inline.length >= 2000) return fail()
      inline.push(match[0].slice(1, -1))
      append(`\uE000INLINE${inline.length - 1}\uE001`)
    }
    offset = match.index! + match[0].length
  }
  plain(value.slice(offset))
  if (stack.length !== 1) return fail()
  const displayText = root.children.join('')
  if (displayText.includes('```') || displayText.includes('~~~')) return fail()
  const markdown = displayText.replace(/\uE000(BLOCK|INLINE)(\d+)\uE001/g, (_token, kind: string, position: string, index: number) => {
    const number = Number(position)
    if (kind === 'INLINE') return `\`${inline[number]}\``
    const block = blocks[number]
    const indent = /(?:^|\n)([ \t]*)$/.exec(displayText.slice(0, index))?.[1] ?? ''
    return `\`\`\`${block.language}\n${block.content.split('\n').map((line) => indent + line).join('\n')}\n${indent}\`\`\``
  }).trim()
  return { markdown, evidence: { displayText, blocks, inline } }
}

/** Display formatting only. Fenced/inline code is compared separately without
 * case folding, punctuation removal, Unicode normalization or whitespace loss. */
export function normalizeGeminiDisplayText(value: string): string {
  let clean = entities(value).replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1').replace(/__([\s\S]*?)__/g, '$1')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
  for (let pass = 0; pass < 4; pass += 1) clean = clean.replace(/(^|\n)[ \t]*(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s?)/g, '$1')
  return clean
    .replace(/(^|\n)\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*(?=\n|$)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s*\|([^\n]+)\|\s*(?=\n|$)/g, (_token, start: string, row: string) => start + row.replace(/\|/g, ' '))
    .replace(/\*([^*\n]+)\*/g, '$1').replace(/\s+/g, '').trim()
}

export function matchesGeminiDisplay(source: GeminiDisplayEvidence, rendered: GeminiDisplayEvidence): boolean {
  const code = (value: string): string => value.replace(/\r\n/g, '\n').replace(/\n$/, '')
  return normalizeGeminiDisplayText(source.displayText) === normalizeGeminiDisplayText(rendered.displayText) &&
    source.blocks.length === rendered.blocks.length && source.inline.length === rendered.inline.length &&
    source.blocks.every((block, index) => block.language.toLowerCase() === rendered.blocks[index].language.toLowerCase() && code(block.content) === code(rendered.blocks[index].content)) &&
    source.inline.every((text, index) => text === rendered.inline[index])
}
