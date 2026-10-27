import { BaseAdapter } from '../base-adapter'
import type { ChatMessage, ExtractedConversation } from '../../shared/models'
import { sanitizeChatGPTAccountLabel } from '../../shared/account-labels'
import {
  CHATGPT_SELECTORS,
  CHATGPT_UNPIN_SELECTORS,
  getConversationLinkSelectors,
  getPinnedConversationEvidenceSelectors,
} from './selectors'
import { collectAttachmentCandidates } from '../attachment-candidates'
import { collectConversationByScrolling } from '../dom-scroll-collector'
import { parseChatGPTMessageMenuTime } from './message-time'

const EMAIL_IDENTIFIER = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const MESSAGE_TIME_MENU_WAIT_MS = 5_000
const MAX_CAPTURED_MESSAGE_TIMES = 512
const MAX_CAPTURED_ATTACHMENT_CANDIDATES = 100

interface CapturedAssistantTime {
  sentAt: number
  precision: 'minute'
}

interface RenderedMessageEntry {
  root: Element
  attachmentRoot?: Element
  message: ChatMessage
}

const DOCUMENT_POSITION_FOLLOWING = 4
const DOCUMENT_POSITION_PRECEDING = 2

export class ChatGPTAdapter extends BaseAdapter {
  readonly platform = 'chatgpt' as const
  private readonly emptyTurnEvidence = new Map<string, { signature: string; since: number }>()
  private pendingEmptyTurn = false
  private readonly verifiedEmptyOrders = new Map<string, number>()
  // Search indexes are page-local (the original and its share can disagree).
  // Only the public scanner uses them, to prove coverage within that one page.
  protected includeSearchSourceOrder = false
  protected matchesRenderedConversationId(renderedId: string, conversationId: string): boolean {
    return renderedId === conversationId
  }

  hasPendingRenderedTurns(): boolean { return this.pendingEmptyTurn }
  getVerifiedEmptySourceOrders(): number[] {
    const prefix = `${this.getConversationId()}\0`
    return [...this.verifiedEmptyOrders.entries()].filter(([key]) => key.startsWith(prefix)).map(([, order]) => order)
  }

  private readonly capturedAssistantTimes = new Map<string, CapturedAssistantTime>()

  isConversationPage(): boolean {
    return this.getConversationId() !== null
  }

  getConversationId(): string | null {
    try {
      const url = new URL(location.href)
      if (url.hostname !== 'chatgpt.com') {
        return null
      }

      const match = /^\/c\/([^/?#]+)/.exec(url.pathname)
      if (match === null || match[1] === '') {
        return null
      }

      return decodeURIComponent(match[1])
    } catch {
      return null
    }
  }

  getConversationIdFromTarget(target: EventTarget | null): string | null {
    return this.getRenderedConversationIdFromTarget(target, (href) => {
      try {
        const match = /^\/c\/([^/?#]+)/.exec(new URL(href, location.origin).pathname)
        return match?.[1] ? decodeURIComponent(match[1]) : null
      } catch {
        return null
      }
    })
  }

  getTitle(): string {
    try {
      const conversationId = this.getConversationId()
      if (conversationId !== null) {
        const linkTitle = this.readText(
          this.queryFirst(getConversationLinkSelectors(conversationId)),
        )
        if (this.isUsefulTitle(linkTitle)) {
          return linkTitle
        }
      }

      const renderedTitle = this.readText(this.queryFirst(CHATGPT_SELECTORS.TITLE))
      if (this.isUsefulTitle(renderedTitle)) {
        return renderedTitle
      }

      const documentTitle = this.normalizeText(
        document.title
          .replace(/\s*[|–—-]\s*(ChatGPT|OpenAI)\s*$/i, '')
          .replace(/^ChatGPT\s*[|–—-]\s*/i, ''),
      )
      return this.isUsefulTitle(documentTitle) ? documentTitle : 'Untitled conversation'
    } catch {
      return 'Untitled conversation'
    }
  }

  getMessages(): ChatMessage[] {
    try {
      const container = this.getConversationContainer()
      if (container === null) {
        return []
      }
      return this.getRenderedMessageEntries(container).map(({ message }) => message)
    } catch {
      return []
    }
  }

  /**
   * Explicitly collect a virtualized ChatGPT conversation from the DOM. This
   * is called only for a user-requested manual save. The shared DOM collector
   * advances in small viewport-sized steps, waits for React to mount the next
   * window, and de-duplicates by the stable turn/message identity exposed by
   * ChatGPT. A successful sweep intentionally remains at the verified top so
   * the page does not spend more work remounting the original partial window.
   */
  async collectConversation(
    onProgress: (messageCount: number) => void = () => undefined,
    isCancelled: () => boolean = () => false,
  ): Promise<ExtractedConversation | null> {
    const conversationId = this.getConversationId()
    const container = this.getConversationContainer()
    if (conversationId === null || container === null) {
      return this.extractConversation()
    }
    return collectConversationByScrolling({
      container,
      getContainer: () => this.getConversationContainer(),
      conversationId,
      getConversationId: () => isCancelled() ? null : this.getConversationId(),
      extractConversation: () => this.extractConversation(),
      turnSelector: CHATGPT_SELECTORS.MESSAGE_TURN.join(','),
      hasKnownRenderedStart: () => {
        const current = this.getConversationContainer()
        return current !== null && this.hasKnownRenderedStart(current)
      },
      onProgress,
    })
  }

  observeMessageTimes(onCaptured: () => void): () => void {
    let menuObserver: MutationObserver | null = null
    let menuTimeout: number | null = null

    const clearPendingCapture = (): void => {
      menuObserver?.disconnect()
      menuObserver = null
      if (menuTimeout !== null) {
        window.clearTimeout(menuTimeout)
        menuTimeout = null
      }
    }

    const handleClick = (event: MouseEvent): void => {
      try {
        if (!event.isTrusted || !(event.target instanceof Element)) {
          return
        }
        const trigger = event.target.closest(
          CHATGPT_SELECTORS.MESSAGE_TIME_MENU_TRIGGER.join(','),
        )
        if (
          !(trigger instanceof HTMLButtonElement) ||
          trigger.id === '' ||
          trigger.getAttribute('aria-expanded') === 'true'
        ) {
          return
        }
        const turn = trigger.closest(CHATGPT_SELECTORS.MESSAGE_TURN.join(','))
        if (
          turn === null ||
          (
            turn.getAttribute('data-turn') !== 'assistant' &&
            this.queryFirst(
              ['[data-message-author-role="assistant"]'],
              turn,
            ) === null && this.queryFirst(CHATGPT_SELECTORS.RENDERED_MESSAGE.filter((selector) => !selector.includes('data-user-message-bubble')), turn) === null
          )
        ) {
          return
        }
        const conversationId = this.getConversationId()
        const turnIdentity = this.getTurnIdentity(turn)
        const body = document.body
        if (
          conversationId === null ||
          turnIdentity === null ||
          body === null
        ) {
          return
        }

        clearPendingCapture()
        const captureFromOpenMenu = (): void => {
          const menu = this.queryAll(CHATGPT_SELECTORS.MESSAGE_TIME_MENU)
            .find((candidate) =>
              (candidate.getAttribute('aria-labelledby') ?? '')
                .split(/\s+/)
                .includes(trigger.id),
            )
          if (menu === undefined) {
            return
          }
          const label = this.readText(
            this.queryFirst(CHATGPT_SELECTORS.MESSAGE_TIME_LABEL, menu),
          )
          const parsed = parseChatGPTMessageMenuTime(label)
          if (parsed === null || this.getConversationId() !== conversationId) {
            return
          }
          const cacheKey = `${conversationId}:${turnIdentity}`
          const previous = this.capturedAssistantTimes.get(cacheKey)
          if (
            previous?.sentAt === parsed.sentAt &&
            previous.precision === parsed.precision
          ) {
            clearPendingCapture()
            return
          }
          if (
            !this.capturedAssistantTimes.has(cacheKey) &&
            this.capturedAssistantTimes.size >= MAX_CAPTURED_MESSAGE_TIMES
          ) {
            const oldestKey = this.capturedAssistantTimes.keys().next().value
            if (typeof oldestKey === 'string') {
              this.capturedAssistantTimes.delete(oldestKey)
            }
          }
          this.capturedAssistantTimes.set(cacheKey, parsed)
          clearPendingCapture()
          onCaptured()
        }

        menuObserver = new MutationObserver(captureFromOpenMenu)
        menuObserver.observe(body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['aria-labelledby', 'data-state'],
        })
        menuTimeout = window.setTimeout(
          clearPendingCapture,
          MESSAGE_TIME_MENU_WAIT_MS,
        )
        queueMicrotask(captureFromOpenMenu)
      } catch {
        clearPendingCapture()
      }
    }

    document.addEventListener('click', handleClick, true)
    return () => {
      clearPendingCapture()
      document.removeEventListener('click', handleClick, true)
      this.capturedAssistantTimes.clear()
    }
  }

  getAccountIdentifier(): string | null {
    try {
      const candidates = this.queryAll(CHATGPT_SELECTORS.ACCOUNT_IDENTIFIER)
      for (const element of candidates) {
        const identityElements = [
          element,
          ...this.queryAll(
            ['[data-email]', '[data-user-name]'],
            element,
          ),
        ]
        for (const identityElement of identityElements) {
          for (const value of [
            identityElement.getAttribute('data-email'),
            identityElement.getAttribute('data-user-name'),
          ]) {
            const identifier = this.normalizeIdentifier(value)
            if (identifier !== null) {
              return identifier
            }
          }
        }
      }

      return this.getPersistentSidebarAccountLabel()
    } catch {
      return null
    }
  }

  getAccountLabel(): string {
    return this.getAccountIdentifier() ?? 'Unknown'
  }

  supportsPinnedConversations(): boolean {
    return true
  }

  isPinActionTarget(target: EventTarget | null): boolean {
    return this.isRenderedPinActionTarget(target)
  }

  isUnpinActionTarget(target: EventTarget | null): boolean {
    return this.isRenderedUnpinActionTarget(target)
  }

  isCurrentConversationPinned(): boolean {
    try {
      const conversationId = this.getConversationId()
      if (conversationId === null) {
        return false
      }

      if (
        this.queryFirst(getPinnedConversationEvidenceSelectors(conversationId)) !== null
      ) {
        return true
      }

      return this.hasRenderedPinnedConversation(
        getConversationLinkSelectors(conversationId),
        CHATGPT_SELECTORS.PINNED_SECTION,
        CHATGPT_UNPIN_SELECTORS,
        [],
        CHATGPT_SELECTORS.CONVERSATION_LINK,
      )
    } catch {
      return false
    }
  }

  extractConversation(): ExtractedConversation | null {
    try {
      const conversationId = this.getConversationId()
      if (conversationId === null) {
        return null
      }

      const container = this.getConversationContainer()
      const messageEntries = container === null
        ? []
        : this.getRenderedMessageEntries(container)
      const messages = messageEntries.map(({ message }) => message)
      if (messages.length === 0) {
        return null
      }

      // Anonymous image names must use the same message-local numbering as
      // getAttachmentNames, independent of the mounted virtual-list window.
      const attachmentCandidates = messageEntries.flatMap(({ root, attachmentRoot, message }, messageIndex) => collectAttachmentCandidates(
        [{ root: attachmentRoot ?? root, messageIndex, sourceTurnId: message.sourceTurnId, excludeWithin: CHATGPT_SELECTORS.ATTACHMENT_UI }],
        CHATGPT_SELECTORS.ATTACHMENT,
      )).slice(0, MAX_CAPTURED_ATTACHMENT_CANDIDATES)
      const accountIdentifier = this.getAccountIdentifier()
      const accountLabel = this.getAccountLabel()

      return {
        platform: this.platform,
        conversationId,
        title: this.getTitle(),
        url: location.href,
        messages,
        ...(attachmentCandidates.length > 0 ? { attachmentCandidates } : {}),
        accountIdentifier,
        accountLabel,
      }
    } catch {
      return null
    }
  }

  getConversationContainer(): Element | null {
    const id = this.getConversationId()
    if (id === null) return null
    const candidates = this.queryAll([
      ...CHATGPT_SELECTORS.TRANSCRIPT,
      ...CHATGPT_SELECTORS.CHAT_CONTAINER,
    ]).filter((element) => element.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null)
    const ranked = candidates.flatMap((element) => {
      const ids = this.queryAll(CHATGPT_SELECTORS.CONVERSATION_ID, element)
        .map((node) => node.getAttribute('data-chatgpt-selection-conversation-id'))
      // Never relabel a retained SPA page or a mixed conversation region with
      // the current URL, even while the new page is still mounting.
      if (ids.some((value) => value === null || !this.matchesRenderedConversationId(value, id))) return []
      const specificity = CHATGPT_SELECTORS.TRANSCRIPT.findIndex((selector) => element.matches(selector))
      const count = this.queryAll([...CHATGPT_SELECTORS.RENDERED_MESSAGE, ...CHATGPT_SELECTORS.ROLE_MESSAGE], element).length
      return [{ element, score: (ids.length ? 1_000_000 : 0) + count * 10 + (specificity < 0 ? 0 : 3 - specificity) }]
    }).sort((left, right) => right.score - left.score)
    const best = ranked[0]
    if (!best || ranked.some((entry) => entry !== best && entry.score === best.score && !entry.element.contains(best.element) && !best.element.contains(entry.element))) return null
    return best.element
  }

  getConversationObservationContainer(): Element | null {
    const container = this.getConversationContainer()
    return container?.closest('main, [role="main"]') ?? container
  }

  getSidebarContainer(): Element | null {
    return this.queryFirst(CHATGPT_SELECTORS.SIDEBAR)
  }

  getConversationSidebarElement(conversationId: string): Element | null {
    return this.queryFirst(getConversationLinkSelectors(conversationId))
  }

  private getRenderedMessageEntries(container: Element): RenderedMessageEntry[] {
    this.pendingEmptyTurn = false
    // Prefer the complete role-node view. ChatGPT can temporarily omit the
    // `conversation-turn-*` marker from a user turn while assistant turns
    // already have it; choosing turn entries first would silently drop that
    // question as soon as one assistant turn matched.
    const roleEntries = this.readRoleEntries(container)
    const modernEntries = this.readSearchMessageEntries(container)
      .filter((entry) => !roleEntries.some((legacy) => legacy.root.contains(entry.root)))
    if (modernEntries.length > 0) {
      const fallback = this.queryAll(CHATGPT_SELECTORS.MESSAGE_TURN, container)
        .filter((turn) => this.getTopLevelRoleElements(turn).length === 0 && this.queryAll(CHATGPT_SELECTORS.RENDERED_MESSAGE, turn).length === 0)
        .flatMap((turn) => this.readTurnEntries(turn))
      return [...roleEntries, ...modernEntries, ...fallback].sort((left, right) => {
        const position = left.root.compareDocumentPosition(right.root)
        return position & DOCUMENT_POSITION_FOLLOWING ? -1 : position & DOCUMENT_POSITION_PRECEDING ? 1 : 0
      })
    }
    if (roleEntries.length > 0) {
      const fallback = this.queryAll(CHATGPT_SELECTORS.MESSAGE_TURN, container)
        .filter((turn) => this.getTopLevelRoleElements(turn).length === 0)
        .flatMap((turn) => this.readTurnEntries(turn))
      return [...roleEntries, ...fallback].sort((left, right) => {
        const position = left.root.compareDocumentPosition(right.root)
        return position & DOCUMENT_POSITION_FOLLOWING ? -1 : position & DOCUMENT_POSITION_PRECEDING ? 1 : 0
      })
    }

    const turnEntries = this.queryAll(CHATGPT_SELECTORS.MESSAGE_TURN, container)
      .flatMap((turn) => this.readTurnEntries(turn))
    if (turnEntries.length > 0) {
      return turnEntries
    }

    return this.readRoleEntries(container)
  }

  private readSearchMessageEntries(container: Element): RenderedMessageEntry[] {
    const roots = this.queryAll(CHATGPT_SELECTORS.RENDERED_MESSAGE, container)
      .filter((node) => node.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null && node.closest(CHATGPT_SELECTORS.CONTENT_UI) === null)
    const entries: RenderedMessageEntry[] = []
    for (const candidate of roots.filter((node) => !roots.some((parent) => parent !== node && parent.contains(node)))) {
      const role = candidate.matches(`${CHATGPT_SELECTORS.USER_BODY}, ${CHATGPT_SELECTORS.USER_UNIT}`) ? 'user' : 'assistant'
      const root = role === 'user'
        ? candidate.querySelector(CHATGPT_SELECTORS.USER_BODY) ?? candidate
        : candidate.querySelector('[data-markdown-text-style="assistant-message"]') ?? candidate
      const unit = root.closest('[data-chatgpt-search-message-ids]') ?? root.closest(CHATGPT_SELECTORS.MESSAGE_UNIT)
      const turn = root.closest('[data-turn-key]') ?? root.closest('[data-content-search-turn-key]')
      const attachmentRoot = role === 'user' ? unit ?? root : root.closest(CHATGPT_SELECTORS.RESPONSE_ID) ?? root
      if (role === 'assistant' && !root.matches('[data-markdown-text-style="assistant-message"]') && !root.closest(CHATGPT_SELECTORS.RESPONSE_ID) &&
          !/:assistant$/.test(unit?.getAttribute('data-chatgpt-search-unit-key') ?? unit?.getAttribute('data-content-search-unit-key') ?? '')) continue
      const idValues = [
        root.getAttribute('data-dil-message-id'),
        root.getAttribute('data-dil-source-message-id'),
        attachmentRoot.getAttribute('data-chatgpt-selection-message-id'),
        ...this.queryAll(['[data-dil-source-message-id]', '[data-dil-message-id]'], root)
          .map((node) => node.getAttribute('data-dil-source-message-id') ?? node.getAttribute('data-dil-message-id')),
        ...(unit?.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/) ?? []),
      ].filter((value): value is string => !!value)
      const ids = [...new Set(idValues)]
      if (ids.length > 1) { this.pendingEmptyTurn = true; continue }
      const sourceMessageId = ids[0] ?? (role === 'user' ? turn?.getAttribute('data-turn-key') : undefined) ?? undefined
      const content = this.readSearchMessageContent(root)
      const attachmentNames = this.getAttachmentNames(attachmentRoot)
      if (!content && !attachmentNames.length) { this.pendingEmptyTurn = true; continue }
      const searchIndex = this.readSearchTurnIndex(turn ?? root)
      const order = searchIndex !== null ? searchIndex * 2 + (role === 'assistant' ? 1 : 0) : undefined
      // Give each message its own stable identity, rather than giving an
      // answer attachment the same turn key as the preceding question.
      const sourceTurnId = sourceMessageId ?? (turn?.getAttribute('data-turn-key') ? `${turn.getAttribute('data-turn-key')}:${role}` : undefined)
      const message: ChatMessage = {
        role, content,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceTurnId ? { sourceTurnId } : {}),
        ...(this.includeSearchSourceOrder && Number.isSafeInteger(order) ? { sourceOrder: order } : {}),
        ...(attachmentNames.length ? { attachmentNames } : {}),
      }
      entries.push({ root, attachmentRoot, message: this.withCapturedAssistantTime(message, turn ?? root) })
    }
    if (this.includeSearchSourceOrder) {
      for (const turn of this.queryAll(['[data-turn-key]'], container)) {
        const hasQuestion = entries.some((entry) => entry.message.role === 'user' && turn.contains(entry.root))
        const hasAnswer = entries.some((entry) => entry.message.role === 'assistant' && turn.contains(entry.root))
        // A question or blank DIL placeholder alone cannot prove an empty
        // answer. A completed native thought-only activity has separate proof.
        const emptyAnswer = this.verifyPairedEmptyAnswer(turn, hasQuestion, hasAnswer)
        if (!hasAnswer && !emptyAnswer) this.pendingEmptyTurn = true
      }
    }
    return entries
  }

  private readSearchTurnIndex(turn: Element): number | null {
    const key = turn.getAttribute('data-content-search-turn-key') ??
      this.queryFirst(['[data-content-search-turn-key]'], turn)?.getAttribute('data-content-search-turn-key') ?? ''
    const match = /^fallback-turn-(\d+)$/.exec(key)
    const index = match ? Number(match[1]) : NaN
    return Number.isSafeInteger(index) && index >= 0 ? index : null
  }

  private hasKnownRenderedStart(container: Element): boolean {
    const turns = this.queryAll(['[data-turn-key]'], container)
      .filter((turn) => turn.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null)
    // These numbers prove the beginning of this one DOM window only. They do
    // not become message sourceOrder or cross-page merge keys. A partial or
    // sticky window with missing paired turns cannot authorize static history.
    return turns.length > 0 && turns.every((turn, index) => this.readSearchTurnIndex(turn) === index) &&
      turns.every((turn) => {
        const entries = this.readSearchMessageEntries(turn)
        const hasQuestion = entries.some((entry) => entry.message.role === 'user')
        const hasAnswer = entries.some((entry) => entry.message.role === 'assistant')
        return hasQuestion && (hasAnswer || this.verifyPairedEmptyAnswer(turn, hasQuestion, hasAnswer))
      })
  }

  protected getCompletedThoughtLabel(turn: Element): Element | null {
    const marker = this.queryFirst([CHATGPT_SELECTORS.AGENT_TURN_START], turn)
    const activity = marker?.parentElement
    if (!activity) return null
    // The current activity header uses an empty overlay button and a sibling
    // text label. Read that native header, never thought markdown or user text.
    return this.queryAll(['button'], activity)
      .map((button) => button.parentElement)
      .find((label) => label !== null && label.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null &&
        /^(思考了|已思考|Thought for)\s*\d/i.test(this.readText(label))) ?? null
  }

  private verifyPairedEmptyAnswer(turn: Element, hasQuestion: boolean, hasAnswer: boolean): boolean {
    const index = this.readSearchTurnIndex(turn)
    if (index === null) return false
    const order = index * 2 + 1
    const key = `${this.getConversationId()}\0paired:${turn.getAttribute('data-turn-key')}:${order}`
    const label = this.getCompletedThoughtLabel(turn)
    const complete = label?.closest(CHATGPT_SELECTORS.COMPLETED_TURN)
    const hasAnswerRenderer = this.queryFirst([
      CHATGPT_SELECTORS.ASSISTANT_UNIT, CHATGPT_SELECTORS.RESPONSE_ID,
      '[data-markdown-text-style="assistant-message"]', '[data-dil-source-message-id]', '[data-dil-message-id]',
    ], turn) !== null
    if (!hasQuestion || hasAnswer || hasAnswerRenderer || !label || !complete || !turn.contains(complete) ||
        turn.closest(CHATGPT_SELECTORS.INACTIVE_REGION) !== null || turn.querySelector(CHATGPT_SELECTORS.BUSY_RESPONSE)) {
      this.emptyTurnEvidence.delete(key)
      this.verifiedEmptyOrders.delete(key)
      return false
    }
    const signature = this.readText(label)
    const previous = this.emptyTurnEvidence.get(key)
    if (previous && previous.signature !== signature) {
      this.emptyTurnEvidence.delete(key)
      this.verifiedEmptyOrders.delete(key)
    }
    const bounds = label.getBoundingClientRect()
    if (bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= window.innerHeight) {
      if (!previous || previous.signature !== signature) {
        if (this.emptyTurnEvidence.size >= 512) this.emptyTurnEvidence.clear()
        this.emptyTurnEvidence.set(key, { signature, since: Date.now() })
      } else if (Date.now() - previous.since >= 600) {
        if (this.verifiedEmptyOrders.size >= 512) this.verifiedEmptyOrders.clear()
        this.verifiedEmptyOrders.set(key, order)
      }
    }
    return this.verifiedEmptyOrders.get(key) === order
  }

  private readSearchMessageContent(root: Element): string {
    const codeText = (node: Node): string => {
      if (node.nodeType === 3) return node.parentElement?.closest(CHATGPT_SELECTORS.CONTENT_UI) ? '' : node.textContent ?? ''
      if (!(node instanceof Element) || node.closest(CHATGPT_SELECTORS.CONTENT_UI)) return ''
      return node.tagName === 'BR' ? '\n' : Array.from(node.childNodes).map(codeText).join('')
    }
    const visit = (node: Node): string => {
      if (node.nodeType === 3) return node.parentElement?.closest(CHATGPT_SELECTORS.CONTENT_UI) ? '' : node.textContent ?? ''
      if (!(node instanceof Element) || node.closest(CHATGPT_SELECTORS.CONTENT_UI)) return ''
      if (node.tagName === 'BR') return '\n'
      if (node.tagName === 'PRE') {
        const code = node.querySelector('code') ?? node
        const language = /(?:^|\s)language-([\w+-]+)/.exec(code.className)?.[1] ?? ''
        return `\n\n\`\`\`${language}\n${codeText(code).trim()}\n\`\`\`\n\n`
      }
      const text = Array.from(node.childNodes).map(visit).join('')
      if (/^(P|H[1-6])$/.test(node.tagName)) return `${text}\n\n`
      if (node.tagName === 'LI') {
        if (!text.trim()) return ''
        const list = node.parentElement
        const index = list ? Array.from(list.children).indexOf(node) : 0
        const marker = list?.tagName === 'OL' ? `${Number(list.getAttribute('start') ?? 1) + index}. ` : '- '
        return `${marker}${text.trim()}\n`
      }
      if (/^(UL|OL)$/.test(node.tagName)) return `\n\n${text}\n\n`
      if (node.tagName === 'BLOCKQUOTE') return `\n\n${text.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`
      if (/^(TD|TH)$/.test(node.tagName)) return `${text.trim()}\t`
      if (node.tagName === 'TR') return `${text.trimEnd()}\n`
      if (node.tagName === 'TABLE') return `\n\n${text}\n\n`
      return text
    }
    return this.normalizeText(visit(root))
  }

  private readTurnEntries(turn: Element): RenderedMessageEntry[] {
    const roleElements = this.getTopLevelRoleElements(turn)
    if (roleElements.length === 0) {
      const role = turn.getAttribute('data-turn')
      if (role !== 'user' && role !== 'assistant') return []
      const candidates = collectAttachmentCandidates([{ root: turn }], CHATGPT_SELECTORS.ATTACHMENT)
      const thoughtButton = this.queryAll(['[data-streaming-response-group] button[aria-expanded]'], turn).find((button) => /^(思考了|已思考|Thought for|Thinking for)\s*/i.test(this.readText(button)))
      // Thought disclosures are host UI, not an answer. Even when the user has
      // expanded one, its rendered markdown must not become a saved message.
      const thoughtRoot = thoughtButton?.parentElement
      const contentRoot = this.queryAll(CHATGPT_SELECTORS.MESSAGE_CONTENT, turn)
        .find((candidate) => !thoughtRoot?.contains(candidate)) ?? null
      const completedThought = thoughtButton !== undefined && /^(思考了|已思考|Thought for)\s*/i.test(this.readText(thoughtButton))
      // A completed empty response has a concrete empty output renderer, unlike
      // the offscreen virtualizer skeleton. Accept it only inside the viewport,
      // after the same native renderer remains stable for a render-settle round.
      const emptyOutput = role === 'assistant' ? turn.querySelector('span.sr-only:has(> br)') : null
      const bounds = turn.getBoundingClientRect()
      const signature = turn.textContent ?? ''
      const evidenceKey = `${this.getConversationId()}\0${turn.getAttribute('data-testid')}`
      if (contentRoot || candidates.length > 0) {
        this.emptyTurnEvidence.delete(evidenceKey)
        this.verifiedEmptyOrders.delete(evidenceKey)
      }
      let verifiedEmpty = false
      if (!contentRoot && candidates.length === 0 && (completedThought || (emptyOutput && this.readText(emptyOutput) === '')) && bounds.top >= 0 && bounds.bottom <= window.innerHeight && !turn.querySelector('[aria-busy="true"], [role="progressbar"]')) {
        const previous = this.emptyTurnEvidence.get(evidenceKey)
        if (!previous || previous.signature !== signature) {
          if (this.emptyTurnEvidence.size >= 512) this.emptyTurnEvidence.clear()
          this.emptyTurnEvidence.set(evidenceKey, { signature, since: Date.now() })
        } else verifiedEmpty = Date.now() - previous.since >= 600
        this.pendingEmptyTurn ||= !verifiedEmpty
      }
      if (verifiedEmpty) {
        const order = this.readRenderedTurnOrder(turn)
        if (order !== null) {
          if (this.verifiedEmptyOrders.size >= 512) this.verifiedEmptyOrders.clear()
          this.verifiedEmptyOrders.set(evidenceKey, order)
        }
        return []
      }
      if (!contentRoot && candidates.length === 0) return []
      const message = contentRoot ? this.readRoleElement(contentRoot, turn, role) : null
      if (!message && candidates.length === 0) return []
      const fallbackMessage = message ?? {
        role, content: '',
        ...(turn.getAttribute('data-turn-id') ? { sourceTurnId: turn.getAttribute('data-turn-id')! } : {}),
        ...(this.readRenderedTurnOrder(turn) !== null ? { sourceOrder: this.readRenderedTurnOrder(turn)! } : {}),
      }
      return [{ root: turn, attachmentRoot: turn, message: { ...fallbackMessage, ...(candidates.length ? { attachmentNames: [...new Set([...(fallbackMessage.attachmentNames ?? []), ...candidates.map((candidate) => candidate.name)])] } : {}) } }]
    }
    return roleElements.flatMap((roleElement) => {
      const message = this.readRoleElement(roleElement, turn)
      return message === null
        ? []
        : [{ root: roleElement, attachmentRoot: turn, message }]
    })
  }

  private readRoleEntries(root: Element): RenderedMessageEntry[] {
    return this.getTopLevelRoleElements(root).flatMap((roleElement) => {
      const attachmentRoot = roleElement.closest(
        '[data-testid^="conversation-turn-"]',
      ) ?? roleElement
      const message = this.readRoleElement(roleElement, attachmentRoot)
      return message === null
        ? []
        : [{ root: roleElement, attachmentRoot, message }]
    })
  }

  private getTopLevelRoleElements(root: Element): Element[] {
    const candidates = [
      ...(root.matches(CHATGPT_SELECTORS.ROLE_MESSAGE.join(',')) ? [root] : []),
      ...this.queryAll(CHATGPT_SELECTORS.ROLE_MESSAGE, root),
    ]
    const unique = candidates.filter(
      (element, index) => candidates.indexOf(element) === index,
    )
    return unique
      .filter((element) => element.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null)
      .filter((element, index, elements) =>
        !elements.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index && candidate.contains(element),
        ),
      )
      .sort((left, right) => {
        const position = left.compareDocumentPosition(right)
        if ((position & DOCUMENT_POSITION_FOLLOWING) !== 0) {
          return -1
        }
        if ((position & DOCUMENT_POSITION_PRECEDING) !== 0) {
          return 1
        }
        return 0
      })
  }

  private readRoleElement(roleElement: Element, attachmentRoot: Element = roleElement, roleOverride?: ChatMessage['role']): ChatMessage | null {
    const role = roleOverride ?? roleElement.getAttribute('data-message-author-role')
    if (role !== 'user' && role !== 'assistant') {
      return null
    }

    const contentElement = this.queryFirst(CHATGPT_SELECTORS.MESSAGE_CONTENT, roleElement)
    const content = this.readMessageContent(contentElement ?? roleElement)
    const attachmentNames = this.getAttachmentNames(attachmentRoot)
    if (content === '' && attachmentNames.length === 0) {
      return null
    }

    const sourceTurn = attachmentRoot.matches('[data-testid^="conversation-turn-"]')
      ? attachmentRoot
      : attachmentRoot.closest('[data-testid^="conversation-turn-"]')
    const sourceTurnId = sourceTurn?.getAttribute('data-turn-id') ??
      roleElement.getAttribute('data-turn-id') ??
      sourceTurn?.getAttribute('data-testid') ??
      null
    const sourceMessageId = roleElement.getAttribute('data-message-id')
    const sourceOrder = this.readRenderedTurnOrder(sourceTurn)
    const sourceMetadata = {
      ...(sourceTurnId === null || sourceTurnId === '' ? {} : { sourceTurnId }),
      ...(sourceMessageId === null || sourceMessageId === ''
        ? {}
        : { sourceMessageId }),
      ...(sourceOrder === null ? {} : { sourceOrder }),
    }
    const message: ChatMessage = attachmentNames.length > 0
      ? { role, content, ...sourceMetadata, attachmentNames }
      : { role, content, ...sourceMetadata }
    return this.withCapturedAssistantTime(
      this.withSourceMessageTime(message, attachmentRoot),
      attachmentRoot,
    )
  }

  private withCapturedAssistantTime(
    message: ChatMessage,
    root: Element,
  ): ChatMessage {
    if (message.role !== 'assistant' || message.sentAt !== undefined) {
      return message
    }
    const turn = root.matches(CHATGPT_SELECTORS.MESSAGE_TURN.join(','))
      ? root
      : root.closest(CHATGPT_SELECTORS.MESSAGE_TURN.join(','))
    const conversationId = this.getConversationId()
    const turnIdentity = turn === null ? null : this.getTurnIdentity(turn)
    if (conversationId === null || turnIdentity === null) {
      return message
    }
    const captured = this.capturedAssistantTimes.get(
      `${conversationId}:${turnIdentity}`,
    )
    return captured === undefined
      ? message
      : {
          ...message,
          sentAt: captured.sentAt,
          sentAtPrecision: captured.precision,
        }
  }

  private getTurnIdentity(turn: Element): string | null {
    return turn.getAttribute('data-turn-id') || turn.getAttribute('data-testid') || turn.getAttribute('data-turn-key')
  }

  private readRenderedTurnOrder(turn: Element | null): number | null {
    const testId = turn?.getAttribute('data-testid') ?? ''
    const match = /^conversation-turn-(\d+)$/.exec(testId)
    if (match === null) {
      return null
    }
    const order = Number(match[1])
    return Number.isSafeInteger(order) && order >= 0 ? order : null
  }

  private getAttachmentNames(root: Element): string[] {
    return [...new Set(collectAttachmentCandidates(
      [{ root, excludeWithin: CHATGPT_SELECTORS.ATTACHMENT_UI }],
      CHATGPT_SELECTORS.ATTACHMENT,
    ).map((candidate) => candidate.name))]
  }

  private readMessageContent(element: Element): string {
    // DIL also appears inside legacy role/markdown roots. Use the same
    // presentation-aware serializer as search roots so citation badges and
    // their source labels cannot leak into the visible answer cross-check.
    if (element.querySelector('[data-d-component]') !== null) return this.readSearchMessageContent(element)
    if (this.queryFirst(CHATGPT_SELECTORS.CODE_BLOCK, element) === null) {
      return this.readText(element)
    }

    const parts: string[] = []
    const visit = (current: Element): void => {
      if (current.tagName === 'PRE') {
        const codeElement = this.queryFirst(CHATGPT_SELECTORS.CODE_CONTENT, current)
        const code = this.readText(codeElement ?? current)
        if (code !== '') {
          const languageMatch = /(?:^|\s)language-([\w+-]+)/.exec(codeElement?.className ?? '')
          parts.push(`\`\`\`${languageMatch?.[1] ?? ''}\n${code}\n\`\`\``)
        }
        return
      }

      if (/^(P|LI|BLOCKQUOTE|H[1-6])$/.test(current.tagName)) {
        const text = this.readText(current)
        if (text !== '') {
          parts.push(current.tagName === 'LI' ? `- ${text}` : text)
        }
        return
      }

      const children = Array.from(current.children)
      if (children.length === 0) {
        const text = this.readText(current)
        if (text !== '') {
          parts.push(text)
        }
        return
      }
      children.forEach(visit)
    }

    Array.from(element.children).forEach(visit)
    return this.normalizeText(parts.join('\n\n')) || this.readText(element)
  }

  private normalizeIdentifier(value: string | null): string | null {
    const rawIdentifier = this.normalizeText(value ?? '')
    const email = EMAIL_IDENTIFIER.exec(rawIdentifier)?.[0]
    if (email !== undefined) {
      return email
    }
    const identifier = sanitizeChatGPTAccountLabel(rawIdentifier)
    if (
      identifier.length < 2 ||
      identifier.length > 120
    ) {
      return null
    }
    return identifier
  }

  private getPersistentSidebarAccountLabel(): string | null {
    // New sidebar rows use an empty menu-overlay button. The dedicated name
    // is its sibling, while the plan and upgrade control occupy another line.
    for (const trigger of this.queryAll(CHATGPT_SELECTORS.ACCOUNT_OVERLAY_TRIGGER)) {
      const row = trigger.closest(CHATGPT_SELECTORS.ACCOUNT_OVERLAY_ROW)
      if (!row || row.closest(`main, [role="main"], a[href], ${CHATGPT_SELECTORS.INACTIVE_REGION}`) ||
          !trigger.parentElement?.querySelector('img') || row.querySelector(CHATGPT_SELECTORS.CONVERSATION_LINK.join(','))) continue
      const names = this.queryAll([CHATGPT_SELECTORS.ACCOUNT_OVERLAY_NAME], trigger.parentElement)
        .filter((node) => node.closest(CHATGPT_SELECTORS.INACTIVE_REGION) === null)
        .map((node) => this.normalizeIdentifier(this.readText(node)))
        .filter((name): name is string => name !== null)
      const labels = [...new Set(names)]
      if (labels.length === 1) return labels[0]
    }

    // The persistent bottom-left account button contains both the display name
    // and the subscription plan. Only its dedicated name/marquee node is an
    // account label; reading the whole button would produce values such as
    // "Alice Plus" and make the UI depend on the current plan.
    for (const profileButton of this.queryAll(
      CHATGPT_SELECTORS.ACCOUNT_PROFILE_TRIGGER,
    )) {
      for (const element of this.queryAll(
        CHATGPT_SELECTORS.ACCOUNT_DISPLAY_LABEL,
        profileButton,
      )) {
        for (const line of this.readText(element).split(/\n+/)) {
          const label = this.normalizeIdentifier(line)
          if (label !== null) {
            return label
          }
        }
      }
    }

    // ChatGPT's current sidebar can omit the profile-button test ID while
    // retaining this dedicated truncate/marquee name node. Search only that
    // structural node, require an interactive trigger, and exclude conversation
    // rows and main content so ordinary truncated text cannot become an account.
    const structuralLabels = this.queryAll(
      CHATGPT_SELECTORS.ACCOUNT_DISPLAY_LABEL_FALLBACK,
    ).reverse()
    const sidebar = this.getSidebarContainer()
    for (const element of structuralLabels) {
      const hasInteractiveTrigger =
        element.closest('button, [role="button"]') !== null
      if (
        element.closest('main, a[href^="/c/"], a[href^="https://chatgpt.com/c/"]') !== null ||
        (!hasInteractiveTrigger && (sidebar === null || !sidebar.contains(element)))
      ) {
        continue
      }
      for (const line of this.readText(element).split(/\n+/)) {
        const label = this.normalizeIdentifier(line)
        if (label !== null) {
          return label
        }
      }
    }

    return null
  }

  private isUsefulTitle(value: string): boolean {
    return value !== '' && !/^(chatgpt|new chat|temporary chat)$/i.test(value)
  }
}
