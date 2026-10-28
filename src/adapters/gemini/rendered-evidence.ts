import type { GeminiDisplayEvidence } from './network-presentation'

/** Inspect a detached copy only. No page actions or hidden action payloads. */
export function readGeminiDisplayEvidence(root: Element, includeSuggestions = true): GeminiDisplayEvidence {
  const clone = (root.querySelector('.presented-response-container') ?? root.querySelector('response-container') ?? root).cloneNode(true) as Element
  for (const node of clone.querySelectorAll('.only-show-to-message-actions, .sequence-event-marker-container, .follow-up-button-container, tool-bar, .action-bar, [class*="visually-hidden"], svg, script, style, [aria-hidden="true"], source-footnote, sources-carousel-inline, source-inline-chip')) node.remove()
  if (!includeSuggestions) for (const node of clone.querySelectorAll('elicitations, .elicitations-container')) node.remove()
  const blocks: GeminiDisplayEvidence['blocks'] = [], inline: string[] = []
  for (const block of clone.querySelectorAll('code-block')) {
    const code = block.querySelector('pre code, pre')
    if (!code) throw new Error('Gemini 代码块尚未完整显示')
    const language = block.querySelector('.code-block-decoration > span')?.textContent?.trim() ?? ''
    blocks.push({ language, content: code.textContent ?? '' })
    block.replaceWith(document.createTextNode(`\n\uE000BLOCK${blocks.length - 1}\uE001\n`))
  }
  for (const code of clone.querySelectorAll('code')) {
    inline.push(code.textContent ?? '')
    code.replaceWith(document.createTextNode(`\uE000INLINE${inline.length - 1}\uE001`))
  }
  for (const item of clone.querySelectorAll('button.elicitation-item')) item.replaceWith(document.createTextNode(item.querySelector('.elicitation-label')?.textContent ?? ''))
  for (const node of clone.querySelectorAll('.only-show-to-message-actions, .sequence-event-marker-container, .follow-up-button-container, tool-bar, .action-bar, [class*="visually-hidden"], button, svg, script, style, [aria-hidden="true"], source-footnote, sources-carousel-inline, source-inline-chip')) node.remove()
  for (const node of clone.querySelectorAll('br')) node.replaceWith(document.createTextNode('\n'))
  for (const node of clone.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, section, blockquote, tr')) {
    node.prepend(document.createTextNode('\n')); node.append(document.createTextNode('\n'))
  }
  return { displayText: clone.textContent ?? '', blocks, inline }
}

/** DOM-only text. Keep literal code outside prose whitespace normalization. */
export function geminiDomMarkdown(root: Element, includeSuggestions = false): string {
  const proof = readGeminiDisplayEvidence(root, includeSuggestions)
  const prose = proof.displayText.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return prose.replace(/\uE000(BLOCK|INLINE)(\d+)\uE001/g, (_token, kind: string, position: string) => {
    const index = Number(position)
    if (kind === 'INLINE') {
      const text = proof.inline[index]
      return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
    }
    const block = proof.blocks[index], content = block.content.replace(/\r\n/g, '\n').replace(/\n$/, '')
    const fence = content.includes('```') ? '~~~' : '```'
    if (content.includes('```') && content.includes('~~~')) throw new Error('代码块围栏无法无损保存，请保留原副本或使用接口采集')
    const language = /^[A-Za-z0-9_+.#-]{0,40}$/.test(block.language) ? block.language.toLowerCase() : ''
    return `${fence}${language}\n${content}\n${fence}`
  })
}
