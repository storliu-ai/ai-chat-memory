export interface ContentPart {
  type: 'text' | 'code' | 'diagram'
  value: string
  language?: string
  label?: string
}

const SVG_TAGS = new Set('svg g path rect circle ellipse line polyline polygon text tspan title desc'.split(' '))
const SVG_ATTRIBUTES = new Set('xmlns viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-opacity opacity transform font-size font-family font-weight text-anchor dominant-baseline dx dy'.split(' '))

/** An image document, never inserted as page markup. Reject active content and
 * external resources rather than trying to repair an arbitrary SVG document. */
function diagram(source: string): ContentPart {
  if (source.length > 512_000) return { type: 'text', value: '［图示超出预览大小］' }
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || document.querySelector('parsererror')) return { type: 'text', value: '［图示格式无法预览］' }
  const nodes = [root, ...root.querySelectorAll('*')]
  const label = [...root.querySelectorAll('title, desc, text')].map((node) => node.textContent?.trim()).filter(Boolean).join('；') || '对话图示'
  if (nodes.length > 2000 || nodes.some((node) =>
    !SVG_TAGS.has(node.localName) || node.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    [...node.attributes].some((attribute) => !SVG_ATTRIBUTES.has(attribute.name) || /url\s*\(|javascript:|data:|https?:|\/\//i.test(attribute.value) && attribute.name !== 'xmlns') ||
    node.hasAttribute('xmlns') && node.getAttribute('xmlns') !== 'http://www.w3.org/2000/svg',
  )) return { type: 'text', value: `［图示未预览］${label}` }
  return { type: 'diagram', value: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(root.outerHTML)}`, label }
}

export function parseMessagePresentation(content: string, assistantMarkup: boolean): ContentPart[] {
  const parts: ContentPart[] = []
  const appendText = (value: string): void => {
    if (!value) return
    const last = parts.at(-1)
    if (last?.type === 'text') last.value += value
    else parts.push({ type: 'text', value })
  }
  const tokens = /```([^\n`]*)\n?([\s\S]*?)```|~~~([^\n~]*)\n?([\s\S]*?)~~~|`[^`\n]*`|<svg\b[^>]*>[\s\S]*?<\/svg\s*>|image_group[^]*/g
  let offset = 0
  for (const match of content.matchAll(tokens)) {
    appendText(content.slice(offset, match.index))
    const token = match[0]
    if (token.startsWith('```') || token.startsWith('~~~')) {
      const language = (match[1] ?? match[3]).trim() || undefined
      const value = (match[2] ?? match[4]).replace(/\n$/, '')
      const isDiagram = assistantMarkup && /^(?:svg|xml|html)?$/i.test(language ?? '') &&
        /^<svg\b[^>]*>[\s\S]*<\/svg\s*>$/.test(value.trim())
      parts.push(isDiagram ? diagram(value.trim()) : { type: 'code', language, value })
    } else if (assistantMarkup && token.startsWith('<svg')) parts.push(diagram(token))
    else if (!assistantMarkup || !token.startsWith('image_group')) appendText(token)
    offset = match.index! + token.length
  }
  appendText(content.slice(offset))
  return parts
}
