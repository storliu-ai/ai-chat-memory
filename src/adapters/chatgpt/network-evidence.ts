import type { ChatMessage } from '../../shared/models'
import type { CaptureEndpoint, CaptureEndpointTarget } from './network-response'

export interface NetworkRequestEvidence { before?: string; after?: string }
interface Node {
  id: string
  parent: string | null
  children?: string[]
  message: ChatMessage | null
  needsAttachment: boolean
  scanAttachments?: boolean
  widgetType?: 'chart' | 'interactive' | 'layout'
}
interface Page { nodes: Node[]; start: string; end: string; previous: boolean; next: boolean; request: NetworkRequestEvidence; initial: boolean }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const fail = (message: string): never => { throw new Error(message) }
const MAX_NODES = 100_000
const MAX_MESSAGES = 10_000
const MAX_TEXT = 12_000_000
const DIL_DISPLAY_TAGS = new Set('box row grid grid-item text title caption badge divider icon link cite citation memorycite codecite entity asyncimage asyncimagegroup chart slider rangeslider numberinput segmented segmented-control radio radio-group checkbox button svg line path circle rect table table-row table-cell'.split(' '))
const DIL_LAYOUT_TAGS = new Set('box row grid grid-item text title caption badge svg table table-row table-cell'.split(' '))

/** Native inline widgets have two text encodings. Keep their visible labels,
 * omit opaque citation IDs, and leave code examples byte-for-byte intact. */
function chartMarkdown(raw: string): string {
  if (raw.length > 512_000) return fail('接口图表超出支持容量，未保存对话')
  let widget: unknown
  try { widget = JSON.parse(raw) } catch { return fail('接口图表数据无法识别，未保存对话') }
  if (!record(widget) || Object.keys(widget).length !== 1 || !record(widget.charts_widget_v2) || !record(widget.charts_widget_v2.content)) return fail('接口包含暂不支持的可见组件，未保存对话')
  const chart = widget.charts_widget_v2.content
  if (!['line', 'bar', 'area'].includes(String(chart.chartType)) || !identifier(chart.xKey) || !Array.isArray(chart.series) || !chart.series.length || chart.series.length > 16 || !Array.isArray(chart.data) || !chart.data.length || chart.data.length > 2000) return fail('接口图表结构无法完整解释，未保存对话')
  const text = (value: unknown): string => value === undefined ? '' : typeof value === 'string' && value.length <= 2000 ? value : fail('接口图表文字无法识别')
  const scalar = (value: unknown): string => typeof value === 'string' && value.length <= 2000 ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : value === null ? '—' : fail('接口图表包含无法解释的数据点')
  const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const series = chart.series.map((value) => {
    if (!record(value) || !identifier(value.dataKey)) return fail('接口图表缺少稳定的数据列')
    return { key: value.dataKey, label: text(value.label) || value.dataKey, prefix: text(value.valuePrefix), suffix: text(value.valueSuffix) }
  })
  if (new Set(series.map((column) => column.key)).size !== series.length) return fail('接口图表的数据列重复')
  const headers = [text(chart.xAxisLabel) || chart.xKey, ...series.map((column) => column.label)]
  const lines = [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of chart.data) {
    if (!record(row)) return fail('接口图表包含无法解释的数据行')
    lines.push(`| ${[scalar(row[chart.xKey]), ...series.map((column) => `${column.prefix}${scalar(row[column.key])}${column.suffix}`)].map(cell).join(' | ')} |`)
  }
  const caption = [text(chart.title), text(chart.subtitle), text(chart.description), text(chart.yAxisLabel)].filter(Boolean)
  return `\n\n${[...caption, lines.join('\n')].join('\n\n')}\n\n`
}

function visibleNetworkMarkdown(value: string, strictWidgets = false): string {
  return value.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part
    // Image search instructions are presentation, not visible answer text or
    // downloadable image URLs. The rendered attachment sweep owns their images.
    .replace(/image_group[^]*/g, '')
    .replace(/genui([^]*)/g, (token, raw: string) => {
      try { return chartMarkdown(raw) } catch (error: unknown) { if (strictWidgets) throw error; return token }
    })
    .replace(/<Entity\b[^<>]*?\bvalue="((?:\\.|[^"\\])*)"[^<>]*\/\s*>/g, (_token, raw: string) => {
      try { return JSON.parse(`"${raw}"`) as string } catch { return raw }
    })
    .replace(/<(?:Cite|Citation|MemoryCite|CodeCite)\b[^<>]*\/\s*>/g, '')
    .replace(/entity(\[[^]*\])/g, (_token, raw: string) => {
      try {
        const entity: unknown = JSON.parse(raw)
        return Array.isArray(entity) && typeof entity[1] === 'string' ? entity[1] : ''
      } catch { return '' }
    }).replace(/cite[^]*/g, '')).join('')
}

/** Transient cursor evidence only. No URL, query, headers or request body is retained. */
export function readChatGPTPaginationRequest(value: string): NetworkRequestEvidence {
  const query = new URL(value).searchParams
  const before = query.get('before')
  const after = query.get('after')
  const cursor = query.get('cursor')
  if (query.getAll('before').length > 1 || query.getAll('after').length > 1 || query.getAll('cursor').length > 1 || before && after || cursor && (before || after)) fail('接口分页请求的游标存在歧义')
  if (before && !identifier(before) || after && !identifier(after) || cursor && !identifier(cursor)) fail('接口分页游标超出支持范围')
  if (cursor) {
    const direction = query.get('direction')
    if (direction === 'before' || direction === 'backward') return { before: cursor }
    if (direction === 'after' || direction === 'forward') return { after: cursor }
    fail('暂不支持此分页游标方向，未保存对话')
  }
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) }
}

function parseMessage(value: unknown, id: string): { message: ChatMessage | null; needsAttachment: boolean; scanAttachments?: boolean; widgetType?: Node['widgetType'] } {
  const ignored = { message: null, needsAttachment: false }
  if (value === null || value === undefined) return ignored
  if (!record(value) || value.id !== id || !record(value.author) || !record(value.content)) return fail('接口消息结构无法识别')
  const role = value.author.role
  const metadata = record(value.metadata) ? value.metadata : {}
  if (role !== 'user' && role !== 'assistant' || metadata.is_visually_hidden_from_conversation === true || metadata.is_redacted === true) return ignored
  if (role === 'assistant' && (value.recipient !== 'all' || value.channel !== 'final' && value.channel !== null && value.channel !== undefined)) return ignored
  const content = value.content
  if (['thoughts', 'reasoning_recap', 'model_editable_context', 'user_editable_context'].includes(String(content.content_type))) return ignored
  if (value.status !== 'finished_successfully') return fail('接口包含尚未完成的可见消息，请等待回答结束后重新采集')
  let text: string
  let needsAttachment = Array.isArray(metadata.attachments) && metadata.attachments.length > 0
  if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
    if (!Array.isArray(content.parts)) return fail('接口正文部分无法识别')
    const strings: string[] = []
    for (const part of content.parts) {
      if (typeof part === 'string') strings.push(part)
      else if (record(part) && part.content_type === 'text' && typeof part.text === 'string') strings.push(part.text)
      else if (record(part) && ['image_asset_pointer', 'image_url'].includes(String(part.content_type))) needsAttachment = true
      else return fail('接口包含暂不支持的可见内容类型，未保存对话')
    }
    text = strings.join('\n')
  } else if (content.content_type === 'code' && typeof content.text === 'string') {
    const language = typeof content.language === 'string' && /^[\w+-]{0,32}$/.test(content.language) ? content.language : ''
    text = `\`\`\`${language}\n${content.text}\n\`\`\``
  } else return fail('接口包含暂不支持的可见内容类型，未保存对话')
  const scanAttachments = /<(?:AsyncImage|AsyncImageGroup)\b|image_group|!\[/.test(text)
  let widgetType: Node['widgetType'] = /<Chart\b|genui/.test(text) ? 'chart' : undefined
  // DIL v1 explicitly supplies the user-facing Markdown alongside its layout
  // source. Read only that declared text field: code/constants/appData and the
  // rest of metadata never become conversation content.
  if (role === 'assistant' && record(metadata.model_dil_v2)) {
    const display = metadata.model_dil_v2
    if (display.fallbackMarkdownVersion !== 1 || typeof display.fallbackMarkdown !== 'string') return fail('接口显示正文版本无法识别，未保存对话')
    // DIL's declared fallback can omit repeated cards and selected values even
    // for ordinary row/text layouts. Recognize component names only; never
    // execute layout expressions or read code/constants/appData to fill them.
    const markup = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).filter((_part, index) => index % 2 === 0).join('')
    const tags = [...markup.matchAll(/<\/?([A-Za-z][\w.-]*)\b/g)].map((match) => match[1].toLowerCase())
    if (tags.some((tag) => !DIL_DISPLAY_TAGS.has(tag))) return fail('接口包含暂不支持的可见组件，未保存对话')
    if (/<(?:Slider|RangeSlider|NumberInput|Segmented|Radio|Checkbox)\b/i.test(markup) || /滑块当前值不可用|Slider current value (?:is )?unavailable/i.test(display.fallbackMarkdown)) widgetType = 'interactive'
    else if (widgetType !== 'chart' && tags.some((tag) => DIL_LAYOUT_TAGS.has(tag))) widgetType = 'layout'
    text = display.fallbackMarkdown
  }
  if (text.length > MAX_TEXT) return fail('接口单条正文超出保存容量')
  return { message: { role, content: role === 'assistant' ? visibleNetworkMarkdown(text, true) : text, sourceMessageId: id }, needsAttachment, scanAttachments, ...(role === 'assistant' && widgetType ? { widgetType } : {}) }
}

function parseFlat(value: unknown): Node {
  if (!record(value) || !identifier(value.id)) return fail('接口消息缺少稳定 ID')
  const metadata = record(value.metadata) ? value.metadata : {}
  return { id: value.id, parent: identifier(metadata.parent_id) ? metadata.parent_id : null, ...parseMessage(value, value.id) }
}

function signature(node: Node): string { return JSON.stringify([node.id, node.parent, node.message, node.needsAttachment, node.scanAttachments, node.widgetType]) }

/** Removes presentation markup for a cross-check, never for saved Markdown. */
export function normalizeNetworkDisplayText(value: string): string {
  return visibleNetworkMarkdown(value).normalize('NFKC')
    .replace(/^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '')
    .replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, '').replace(/[^]*/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\s*\/?>/gi, '').replace(/[`*_#>|~\\]/g, '').replace(/\s+/g, '').trim()
}

function consistentText(rendered: ChatMessage, incoming: ChatMessage): boolean {
  const left = normalizeNetworkDisplayText(rendered.content)
  const right = normalizeNetworkDisplayText(incoming.content)
  if (left === right) return true
  if (!left || !right) return false
  // A folded user input may omit parts of the full source. Require its actual
  // shown characters in source order, in addition to the exact native ID.
  if (left.length < right.length && left.length >= 16) {
    let offset = 0
    for (const character of left.replace(/[…]/g, '')) {
      const position = right.indexOf(character, offset)
      if (position < 0) return false
      offset = position + character.length
    }
    return true
  }
  return false
}

/** Native chart accessibility text and live calculator values differ from a
 * static DIL fallback. Exact native identity remains mandatory; two independent
 * static lines (or one long paragraph) bind the rendered component to its source. */
function consistentWidget(rendered: ChatMessage, source: ChatMessage): boolean {
  const visible = normalizeNetworkDisplayText(rendered.content)
  const anchors = [...new Set(source.content.split('\n').map(normalizeNetworkDisplayText))]
    .filter((line) => line.length >= 16 && visible.includes(line))
  return anchors.length >= 2 || anchors.some((line) => line.length >= 64)
}

export class ChatGPTNetworkEvidence {
  private readonly target: CaptureEndpointTarget
  private pages: Page[] = []
  private tree: Node[] | null = null
  private branch: string | null = null
  private schema: 'messages' | 'mapping' | null = null
  private bytes = 0
  constructor(target: CaptureEndpointTarget) { this.target = target }

  add(body: string, endpoint: CaptureEndpoint, request: NetworkRequestEvidence = {}): number {
    let value: unknown
    try { value = JSON.parse(body) } catch { return fail('接口未返回有效 JSON，未保存对话') }
    if (!record(value)) return fail('接口响应结构无法识别')
    if (endpoint === 'initial' && value.conversation_id !== undefined && value.conversation_id !== this.target.id) return fail('接口响应不属于目标原对话')
    if (identifier(value.current_node)) {
      if (this.branch && this.branch !== value.current_node) return fail('采集中当前分支已变化，请重新采集')
      this.branch = value.current_node
    }
    let nodes: Node[]
    if (record(value.mapping) && identifier(value.current_node)) {
      if (this.schema && this.schema !== 'mapping') return fail('接口响应结构在采集中发生变化')
      this.schema = 'mapping'
      const mapping = value.mapping
      const entries = Object.entries(mapping)
      if (!entries.length || entries.length > MAX_NODES) return fail('接口树超出支持容量')
      const all = new Map<string, Node>()
      for (const [key, raw] of entries) {
        if (!identifier(key) || !record(raw) || raw.id !== key || raw.parent !== undefined && raw.parent !== null && !identifier(raw.parent) || !Array.isArray(raw.children) || raw.children.some((child) => !identifier(child))) return fail('接口树节点结构不完整')
        all.set(key, { id: key, parent: typeof raw.parent === 'string' ? raw.parent : null, children: raw.children as string[], message: null, needsAttachment: false })
      }
      // Check every edge, including branches outside the selected path.
      for (const node of all.values()) {
        if (node.parent && !all.get(node.parent)?.children?.includes(node.id) || new Set(node.children).size !== node.children!.length || node.children!.some((child) => all.get(child)?.parent !== node.id)) return fail('接口树存在缺失或冲突的父子节点')
      }
      const complete = new Set<string>()
      for (const node of all.values()) {
        const path = new Set<string>()
        let cursor: Node | undefined = node
        while (cursor && !complete.has(cursor.id)) {
          if (path.has(cursor.id)) return fail('接口树存在循环，未保存对话')
          path.add(cursor.id)
          cursor = cursor.parent ? all.get(cursor.parent) : undefined
        }
        path.forEach((id) => complete.add(id))
      }
      nodes = []
      let cursor = all.get(value.current_node)
      if (!cursor) return fail('接口树缺少当前分支节点')
      while (cursor) {
        nodes.push({ ...cursor, ...parseMessage((mapping[cursor.id] as Record<string, unknown>).message, cursor.id) })
        cursor = cursor.parent ? all.get(cursor.parent) : undefined
      }
      nodes.reverse()
      if (this.tree && JSON.stringify(this.tree.map(signature)) !== JSON.stringify(nodes.map(signature))) return fail('接口当前分支正文在采集中发生变化')
      this.tree = nodes
    } else if (Array.isArray(value.messages) && record(value.page_info) && endpoint !== 'share') {
      if (this.schema && this.schema !== 'messages') return fail('接口响应结构在采集中发生变化')
      this.schema = 'messages'
      nodes = value.messages.map(parseFlat)
      const info = value.page_info
      if (!nodes.length || nodes.length > MAX_NODES || !identifier(info.start_cursor) || !identifier(info.end_cursor) || typeof info.has_previous_page !== 'boolean' || typeof info.has_next_page !== 'boolean' || info.start_cursor !== nodes[0].id || info.end_cursor !== nodes.at(-1)!.id || new Set(nodes.map((node) => node.id)).size !== nodes.length) return fail('接口分页边界或消息顺序无法核对')
      const page: Page = { nodes, start: info.start_cursor, end: info.end_cursor, previous: info.has_previous_page, next: info.has_next_page, request, initial: endpoint === 'initial' }
      if (!page.initial && !request.before && !request.after) return fail('历史接口缺少可核对的请求游标')
      const duplicate = this.pages.find((entry) => entry.start === page.start && entry.end === page.end)
      if (duplicate) {
        if (JSON.stringify(duplicate.nodes.map(signature)) !== JSON.stringify(page.nodes.map(signature)) || duplicate.previous !== page.previous || duplicate.next !== page.next) return fail('重试分页的正文或边界发生变化')
        return nodes.length
      }
      if (this.pages.length >= 2048) return fail('接口分页数量超出容量')
      this.pages.push(page)
    } else return fail('暂不支持此接口响应结构，未保存对话')
    const textSize = nodes.reduce((total, node) => total + (node.message?.content.length ?? 0), 0)
    this.bytes = this.tree ? textSize : this.bytes + textSize
    if (this.bytes > MAX_TEXT || this.pages.reduce((total, page) => total + page.nodes.length, 0) > MAX_NODES) return fail('整理后的接口正文超出保存容量')
    this.orderedNodes()
    return nodes.length
  }

  private orderedNodes(): Node[] | null {
    if (this.tree) return this.tree
    if (!this.branch) return null
    const latest = this.pages.filter((page) => page.initial && !page.next)
    if (latest.length !== 1) return null
    const chain: Page[] = []
    const seen = new Set<Page>()
    let page = latest[0]
    while (true) {
      if (seen.has(page)) return fail('接口分页游标形成循环')
      seen.add(page); chain.unshift(page)
      if (!page.previous) break
      const previous = this.pages.filter((candidate) => candidate !== page && (candidate.request.before === page.start || page.request.after === candidate.end))
      if (previous.length > 1) return fail('同一分页游标返回多个不一致批次')
      if (!previous.length) return null
      page = previous[0]
    }
    if (seen.size !== this.pages.length) return null
    if (chain.slice(0, -1).some((entry) => !entry.next)) return fail('接口中间分页的最新边界标记不一致')
    const nodes: Node[] = []
    const ids = new Map<string, number>()
    for (const entry of chain) {
      let last = -1
      let appended = false
      for (const node of entry.nodes) {
        const existing = ids.get(node.id)
        if (existing !== undefined) {
          if (appended || existing <= last || signature(nodes[existing]) !== signature(node)) return fail('重叠分页的消息身份或顺序冲突')
          last = existing
        } else { appended = true; ids.set(node.id, nodes.length); nodes.push(node) }
      }
    }
    if (nodes.at(-1)?.id !== this.branch) return fail('接口分页最新边界与当前分支不一致')
    return nodes
  }

  get complete(): boolean { return this.orderedNodes() !== null }
  get messageCount(): number { return (this.tree ?? this.pages.flatMap((page) => page.nodes)).filter((node) => node.message).length }
  get needsAttachmentScan(): boolean { return (this.tree ?? this.pages.flatMap((page) => page.nodes)).some((node) => node.widgetType === 'interactive' || node.widgetType === 'layout' || node.scanAttachments || node.needsAttachment || /!\[|sandbox:|\/backend-api\/files\//.test(node.message?.content ?? '')) }

  /** Provisional text only. This does not grant verified-save authority: a
   * complete structural branch and exact rendered native IDs are still required,
   * but a display mismatch can be retained for the user's explicit decision. */
  reviewCandidate(rendered: readonly ChatMessage[]): ChatMessage[] | null {
    const nodes = this.orderedNodes()
    if (!nodes) return null
    const messages = nodes.flatMap((node) => node.message ? [{ ...node.message }] : [])
    if (!messages.length || messages.length > MAX_MESSAGES || messages[0].role !== 'user' || JSON.stringify(messages).length > MAX_TEXT) return null
    const byId = new Map(messages.map((message, index) => [message.sourceMessageId, index]))
    let previous = -1
    for (const visible of rendered) {
      const index = byId.get(visible.sourceMessageId)
      if (index === undefined || index <= previous || messages[index].role !== visible.role) return null
      previous = index
      if (visible.sourceTurnId) messages[index].sourceTurnId = visible.sourceTurnId
      if (visible.attachmentNames?.length) messages[index].attachmentNames = [...visible.attachmentNames]
    }
    return previous < 0 ? null : messages
  }

  verify(rendered: readonly ChatMessage[], requireAttachmentEvidence = true): ChatMessage[] {
    const nodes = this.orderedNodes()
    if (!nodes) return fail('接口历史尚未完整：缺少连续分页、最早边界或当前分支证据')
    const messages = nodes.flatMap((node) => node.message ? [{ ...node.message }] : [])
    if (!messages.length || messages.length > MAX_MESSAGES || messages[0].role !== 'user') return fail('接口没有可保存的完整用户对话')
    const byId = new Map(messages.map((message, index) => [message.sourceMessageId!, index]))
    const widgets = new Map(nodes.filter((node) => node.widgetType).map((node) => [node.id, node.widgetType]))
    const renderedWidgets = new Set<string>()
    let previous = -1
    let checked = 0
    for (const visible of rendered) {
      const index = visible.sourceMessageId ? byId.get(visible.sourceMessageId) : undefined
      if (index === undefined || index <= previous || visible.role !== messages[index].role) return fail('接口正文与已展示消息的身份、顺序或内容不一致，未保存')
      let end = index
      let content = messages[index].content
      const widget = widgets.get(visible.sourceMessageId!)
      if (widget) {
        if (!consistentText(visible, messages[index]) && !consistentWidget(visible, messages[index])) return fail('页面组件与接口静态正文缺少可靠锚点，未保存')
        if (widget === 'interactive' || widget === 'layout' && !consistentText(visible, messages[index])) messages[index] = { ...messages[index], content: visible.content, networkWidgetSource: messages[index].content }
        renderedWidgets.add(visible.sourceMessageId!)
      }
      // Older DOM renderers expose one answer root for several final-channel
      // fragments. Cross-check that rendered root against contiguous fragments,
      // while keeping the original network messages separate in storage.
      while (!widget && !consistentText(visible, { ...messages[index], content }) && visible.role === 'assistant' && end + 1 < messages.length && messages[end + 1].role === 'assistant') {
        end += 1
        content += '\n' + messages[end].content
      }
      if (!widget && !consistentText(visible, { ...messages[index], content })) {
        return fail(`接口与页面第 ${index + 1} 条${visible.role === 'user' ? '提问' : '回答'}显示不一致，未保存`)
      }
      previous = end
      checked += 1
      if (visible.sourceTurnId && end === index) messages[index].sourceTurnId = visible.sourceTurnId
      const names = visible.attachmentNames
      if (names?.length) messages[index].attachmentNames = [...names]
    }
    if (!checked) return fail('页面没有可核对的原生消息锚点')
    if (requireAttachmentEvidence && nodes.some((node) => (node.widgetType === 'interactive' || node.widgetType === 'layout') && !renderedWidgets.has(node.id))) return fail('接口包含尚未完整显示的交互组件或显示布局，请打开采集页后重试')
    for (const node of nodes) if (requireAttachmentEvidence && node.message && (!node.message.content.trim() || node.needsAttachment) && !messages[byId.get(node.id)!].attachmentNames?.length) return fail('接口包含尚未在页面核实的空回复或附件消息')
    if (JSON.stringify(messages).length > MAX_TEXT) return fail('整理后的正文和组件显示超出保存容量')
    return messages
  }

  clear(): void { this.pages = []; this.tree = null; this.branch = null; this.schema = null; this.bytes = 0 }
}
