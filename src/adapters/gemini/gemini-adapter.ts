import type { ChatMessage, ExtractedConversation } from '../../shared/models'
import { BaseAdapter } from '../base-adapter'
import {
  collectAttachmentCandidates,
  isOpaqueResourceName,
} from '../attachment-candidates'
import { collectConversationByScrolling } from '../dom-scroll-collector'
import {
  GEMINI_SELECTORS,
  getConversationLinkSelectors,
  getConversationTitleSelectors,
  isBetterGeminiConversationRoot,
  isUsefulGeminiConversationTitle,
  parseGeminiConversationIdFromJslog,
  parseGeminiRenderedMessageOrder,
  type GeminiConversationRootMetrics,
} from './selectors'

const EMAIL_IDENTIFIER = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const ACCOUNT_INDEX = /(?:authuser|account)[=: ](\d+)/i
const GENERIC_ACCOUNT_LABEL = /^(?:google account|google 账号|google 帳戶|account|profile|menu)$/i
const GENERIC_MESSAGE_METADATA = /^(?:conversation[-_ ]?(?:turn|container)|chat[-_ ]?history[-_ ]?container|infinite[-_ ]?scroller|turn|message|user[-_ ]?query|model[-_ ]?response|response|query)(?:[-_ ]?(?:container|root|element|content))?$/i

interface RenderedMessageEntry {
  root: Element
  message: ChatMessage
}

export class GeminiAdapter extends BaseAdapter {
  readonly platform = 'gemini' as const

  isConversationPage(): boolean {
    return this.getConversationId() !== null
  }

  getConversationId(): string | null {
    try {
      const url = new URL(location.href)
      if (url.hostname !== 'gemini.google.com') {
        return null
      }
      const match = /^(?:\/u\/\d+)?\/app\/([^/?#]+)/.exec(url.pathname)
      if (match === null || match[1] === '' || match[1] === 'download') {
        return null
      }
      return decodeURIComponent(match[1])
    } catch {
      return null
    }
  }

  getConversationIdFromTarget(target: EventTarget | null): string | null {
    try {
      if (target instanceof Element) {
        const sidebar = this.getSidebarContainer()
        if (sidebar !== null && sidebar.contains(target)) {
          const rowSelector = 'gem-nav-list-item[data-test-id="conversation"], .conversation'
          let row = target.closest(rowSelector)
          let current: Element | null = target.parentElement
          for (let depth = 0; row === null && current !== null && depth < 6; depth += 1) {
            if (current === sidebar) {
              break
            }
            const rows = this.queryAll([rowSelector], current)
            row = rows.length === 1 ? rows[0] : null
            current = current.parentElement
          }
          if (row !== null) {
            for (const element of [row, ...this.queryAll(['[jslog]'], row)]) {
              const jslog = element.getAttribute('jslog') ?? ''
              const conversationId = parseGeminiConversationIdFromJslog(jslog)
              if (conversationId !== null) {
                return conversationId
              }
            }
            const explicitId = row.getAttribute('data-conversation-id')
            if (explicitId) {
              return explicitId.startsWith('c_') ? explicitId.slice(2) : explicitId
            }
          }
        }
      }
    } catch {
      // Fall back to link-based extraction below.
    }
    return this.getRenderedConversationIdFromTarget(target, (href) => {
      try {
        const match = /^(?:\/u\/\d+)?\/app\/([^/?#]+)/.exec(
          new URL(href, location.origin).pathname,
        )
        return match?.[1] && match[1] !== 'download'
          ? decodeURIComponent(match[1])
          : null
      } catch {
        return null
      }
    })
  }

  getTitle(): string {
    try {
      const conversationId = this.getConversationId()
      if (conversationId !== null) {
        const sidebarTitle = this.readSidebarConversationTitle(conversationId)
        if (isUsefulGeminiConversationTitle(sidebarTitle)) {
          return sidebarTitle
        }
      }
      const renderedTitle = this.readText(this.queryFirst(GEMINI_SELECTORS.TITLE))
      if (isUsefulGeminiConversationTitle(renderedTitle)) {
        return renderedTitle
      }
      const documentTitle = this.normalizeText(
        document.title
          .replace(/\s*[|–—-]\s*(Google\s+)?Gemini\s*$/i, '')
          .replace(/^(Google\s+)?Gemini\s*[|–—-]\s*/i, ''),
      )
      return isUsefulGeminiConversationTitle(documentTitle)
        ? documentTitle
        : 'Untitled conversation'
    } catch {
      return 'Untitled conversation'
    }
  }

  getMessages(): ChatMessage[] {
    const container = this.getConversationContainer()
    if (container === null) {
      return []
    }

    return this.getRenderedMessageEntries(container).map(({ message }) => message)
  }

  /** Explicitly sweep Gemini's virtualized history for a manual save. */
  collectConversation(
    onProgress: (messageCount: number) => void = () => undefined,
  ): Promise<ExtractedConversation | null> {
    const conversationId = this.getConversationId()
    const container = this.getConversationContainer()
    if (conversationId === null || container === null) {
      return Promise.resolve(this.extractConversation())
    }
    return collectConversationByScrolling({
      container,
      getContainer: () => this.getConversationContainer(),
      conversationId,
      getConversationId: () => this.getConversationId(),
      extractConversation: () => this.extractConversation(),
      turnSelector: GEMINI_SELECTORS.CONVERSATION_TURN.join(','),
      onProgress,
    })
  }

  private readMessageEntriesFromRoot(root: ParentNode): RenderedMessageEntry[] {
    return this.getTopLevelElements(this.queryAll(GEMINI_SELECTORS.MESSAGE, root))
      .map((element): RenderedMessageEntry | null => {
        const message = this.readMessage(element)
        return message === null ? null : { root: element, message }
      })
      .filter((entry): entry is RenderedMessageEntry => entry !== null)
  }

  private getRenderedMessageEntries(container: Element): RenderedMessageEntry[] {
    // Read all top-level message nodes in the selected history first. During
    // a SPA update Gemini can leave a newly mounted question outside the
    // conversation-turn wrapper while the answer is already inside it; using
    // the wrapper-only path would then save consecutive answers without the
    // question that belongs to the turn.
    const rootEntries = this.readMessageEntriesFromRoot(container)
    if (rootEntries.length > 0) {
      return rootEntries
    }

    const turns = this.getTopLevelElements(
      this.queryAll(GEMINI_SELECTORS.CONVERSATION_TURN, container),
    )
    if (turns.length > 0) {
      const turnEntries = turns.flatMap((turn) =>
        this.readMessageEntriesFromRoot(turn),
      )
      if (turnEntries.length > 0) {
        return turnEntries
      }
    }

    return this.readMessageEntriesFromRoot(container)
  }

  private getTopLevelElements(elements: Element[]): Element[] {
    return elements
      .filter((element, index, messages) =>
        !messages.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index && candidate.contains(element),
        ),
      )
  }

  getAccountIdentifier(): string | null {
    try {
      for (const element of this.queryAll(GEMINI_SELECTORS.ACCOUNT_IDENTIFIER)) {
        const values = [
          element.getAttribute('data-email'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('alt'),
          element.getAttribute('href'),
          this.readText(element),
        ]
        for (const value of values) {
          const email = EMAIL_IDENTIFIER.exec(value ?? '')?.[0]
          if (email !== undefined) {
            return email
          }
        }
      }

      const url = new URL(location.href)
      const pathAccountIndex = /^\/u\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]
      if (pathAccountIndex !== undefined) {
        return `google-account-${pathAccountIndex}`
      }
      const authUser = url.searchParams.get('authuser')
      if (authUser !== null && /^\d+$/.test(authUser)) {
        return `google-account-${authUser}`
      }
      for (const element of this.queryAll(GEMINI_SELECTORS.ACCOUNT_IDENTIFIER)) {
        const combined = [
          element.getAttribute('href'),
          element.getAttribute('aria-label'),
        ].join(' ')
        const index = ACCOUNT_INDEX.exec(combined)?.[1]
        if (index !== undefined) {
          return `google-account-${index}`
        }
      }
      return null
    } catch {
      return null
    }
  }

  getAccountLabel(): string {
    try {
      for (const element of this.queryAll(GEMINI_SELECTORS.ACCOUNT_IDENTIFIER)) {
        for (const raw of [element.getAttribute('aria-label'), element.getAttribute('title')]) {
          const value = this.normalizeText(raw ?? '')
          const email = EMAIL_IDENTIFIER.exec(value)?.[0]
          if (email !== undefined) {
            return email
          }
          const cleaned = value
            .replace(/^(?:google account|google 账号|google 帳戶)\s*[:：]?\s*/i, '')
            .trim()
          if (cleaned.length >= 2 && cleaned.length <= 100 && !GENERIC_ACCOUNT_LABEL.test(cleaned)) {
            return cleaned
          }
        }
      }
    } catch {
      // Fall back to the stable identifier below.
    }
    return this.getAccountIdentifier() ?? 'Unknown'
  }

  getConversationContainer(): Element | null {
    let bestContainer: Element | null = null
    let bestMetrics: GeminiConversationRootMetrics | null = null

    for (const selector of GEMINI_SELECTORS.CHAT_CONTAINER) {
      for (const candidate of this.queryAll([selector])) {
        const turnCount = this.queryAll(
          GEMINI_SELECTORS.CONVERSATION_TURN,
          candidate,
        ).length
        const messageCount = this.queryAll(
          GEMINI_SELECTORS.MESSAGE,
          candidate,
        ).length
        const metrics = { turnCount, messageCount }
        if (isBetterGeminiConversationRoot(metrics, bestMetrics)) {
          bestContainer = candidate
          bestMetrics = metrics
        }
      }
    }

    if (
      bestMetrics !== null &&
      bestMetrics.turnCount === 0 &&
      bestMetrics.messageCount === 0
    ) {
      return this.queryFirst([
        'main',
        '[role="main"]',
        'chat-window-content',
        'chat-window',
      ]) ?? bestContainer
    }

    return bestContainer
  }

  getConversationObservationContainer(): Element | null {
    const conversationContainer = this.getConversationContainer()
    if (conversationContainer === null) {
      return null
    }
    return (
      conversationContainer.closest('main') ??
      conversationContainer.closest('[role="main"]') ??
      conversationContainer.closest('chat-window-content') ??
      conversationContainer.closest('chat-window') ??
      conversationContainer
    )
  }

  getSidebarContainer(): Element | null {
    const sidebar = this.queryFirst(GEMINI_SELECTORS.SIDEBAR)
    if (sidebar === null) {
      return null
    }

    // The chats expandable section and pinned-conversations can be siblings.
    // Observe their shared shell so a late-rendered pinned title triggers a
    // fresh extraction instead of leaving the generic document title stored.
    return sidebar.closest(GEMINI_SELECTORS.SIDEBAR_SHELL.join(',')) ?? sidebar
  }

  getConversationSidebarElement(conversationId: string): Element | null {
    return this.queryFirst(getConversationLinkSelectors(conversationId))
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
    const conversationId = this.getConversationId()
    return conversationId !== null && this.hasRenderedPinnedConversation(
      getConversationLinkSelectors(conversationId),
      GEMINI_SELECTORS.PINNED_SECTION,
      GEMINI_SELECTORS.UNPIN_ACTION,
      GEMINI_SELECTORS.INLINE_PIN_INDICATOR,
    )
  }

  extractConversation(): ExtractedConversation | null {
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
    const attachmentCandidates = collectAttachmentCandidates(
      messageEntries.map(({ root, message }, messageIndex) => ({
        root,
        messageIndex,
        sourceTurnId: message.sourceTurnId,
      })),
      GEMINI_SELECTORS.ATTACHMENT,
    )
    return {
      platform: this.platform,
      conversationId,
      title: this.getTitle(),
      url: location.href,
      messages,
      ...(attachmentCandidates.length > 0 ? { attachmentCandidates } : {}),
      accountIdentifier: this.getAccountIdentifier(),
      accountLabel: this.getAccountLabel(),
    }
  }

  private readMessage(element: Element): ChatMessage | null {
    const tagName = element.tagName.toLowerCase()
    const renderedRole = element.getAttribute('data-message-author-role')
    const role =
      renderedRole === 'user' ||
      tagName.includes('user-query') ||
      element.matches('.user-query, .question-block')
        ? 'user'
        : 'assistant'
    const selectors = role === 'user'
      ? GEMINI_SELECTORS.USER_MESSAGE
      : GEMINI_SELECTORS.ASSISTANT_MESSAGE
    const contentElement = this.queryFirst(selectors, element) ?? element
    const content = this.readDetachedText(contentElement, [
      'tool-bar',
      '.action-bar',
      'details[class*="thought"]',
      '[class*="visually-hidden"]',
    ])
    const attachmentElements = this.queryAll(GEMINI_SELECTORS.ATTACHMENT, element)
    const attachmentNames = attachmentElements
      .map((attachment) => this.readText(attachment))
      .filter((name) =>
        name !== '' && name.length <= 255 && !isOpaqueResourceName(name),
      )
    const hasRenderedAttachment = attachmentElements.some((attachment) =>
      attachment.matches('img[data-test-id="uploaded-img"], user-query-file-preview') ||
      this.queryAll([
        'img[src]',
        'img[srcset]',
        'a[href]',
        '[download]',
        '[data-download-url]',
        '[data-url]',
      ], attachment).length > 0,
    ) || attachmentNames.length > 0
    if (content === '' && attachmentNames.length === 0 && !hasRenderedAttachment) {
      return null
    }
    const sourceMetadata = this.readSourceMetadata(element, role)
    const message: ChatMessage = attachmentNames.length > 0
      ? { role, content, ...sourceMetadata, attachmentNames: [...new Set(attachmentNames)] }
      : { role, content, ...sourceMetadata }
    return this.withSourceMessageTime(message, element)
  }

  private readSourceMetadata(
    element: Element,
    role: ChatMessage['role'],
  ): Pick<
    ChatMessage,
    'sourceTurnId' | 'sourceMessageId' | 'sourceOrder'
  > {
    const turn = element.closest(
      '[data-turn-id], [data-conversation-turn-id], ' +
      '[data-testid*="conversation-turn" i], ' +
      '[data-test-id*="conversation-turn" i], ' +
      GEMINI_SELECTORS.CONVERSATION_TURN.join(','),
    )
    const meaningfulMetadata = (value: string | null): string | null => {
      const normalized = value?.trim() ?? ''
      return normalized === '' || GENERIC_MESSAGE_METADATA.test(normalized)
        ? null
        : normalized
    }
    const sourceTurnId =
      meaningfulMetadata(element.getAttribute('data-turn-id')) ??
      meaningfulMetadata(element.getAttribute('data-conversation-turn-id')) ??
      meaningfulMetadata(turn?.getAttribute('data-turn-id') ?? null) ??
      meaningfulMetadata(turn?.getAttribute('data-conversation-turn-id') ?? null) ??
      meaningfulMetadata(turn?.getAttribute('id') ?? null) ??
      meaningfulMetadata(turn?.getAttribute('data-testid') ?? null) ??
      meaningfulMetadata(turn?.getAttribute('data-test-id') ?? null)
    const sourceMessageId = meaningfulMetadata(
      element.getAttribute('data-message-id'),
    )
    const parseNumericAttribute = (value: string | null | undefined): number | null => {
      const normalized = value?.trim() ?? ''
      if (!/^\d+$/.test(normalized)) {
        return null
      }
      const parsed = Number(normalized)
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
    }
    // Some Gemini versions expose a message-level index. Prefer that value;
    // otherwise derive a deterministic interleaved order from the rendered
    // `user-query-content-N` id (user first, assistant second).
    const messageOrder = [
      turn?.getAttribute('data-message-index'),
      element.getAttribute('data-message-index'),
      turn?.getAttribute('aria-posinset'),
      element.getAttribute('aria-posinset'),
    ]
      .map(parseNumericAttribute)
      .find((value): value is number => value !== null)
    const turnOrder = [
      turn?.getAttribute('data-turn-index'),
      turn?.getAttribute('data-index'),
      turn?.getAttribute('data-order'),
    ]
      .map(parseNumericAttribute)
      .find((value): value is number => value !== null)
    const testId = turn?.getAttribute('data-testid') ??
      turn?.getAttribute('data-test-id') ??
      ''
    const orderMatch = /(?:conversation[-_ ]?turn|turn)[-_ ](\d+)/i.exec(testId)
    const testIdOrder = orderMatch === null
      ? null
      : parseNumericAttribute(orderMatch[1])
    const promptOrder = parseGeminiRenderedMessageOrder(
      this.queryFirst(GEMINI_SELECTORS.MESSAGE_ORDER, turn ?? element)?.getAttribute('id') ?? null,
    )
    const derivedTurnOrder = turnOrder ?? testIdOrder ?? promptOrder
    const roleOffset = role === 'assistant' ? 1 : 0
    const derivedMessageOrder = derivedTurnOrder === null
      ? null
      : derivedTurnOrder <= Math.floor((Number.MAX_SAFE_INTEGER - roleOffset) / 2)
        ? derivedTurnOrder * 2 + roleOffset
        : null
    const sourceOrder = messageOrder ?? derivedMessageOrder
    return {
      ...(sourceTurnId === null || sourceTurnId === '' ? {} : { sourceTurnId }),
      ...(sourceMessageId === null || sourceMessageId === ''
        ? {}
        : { sourceMessageId }),
      ...(sourceOrder === null || !Number.isSafeInteger(sourceOrder)
        ? {}
        : { sourceOrder }),
    }
  }

  private readSidebarConversationTitle(conversationId: string): string {
    const titleElement = this.queryFirst(
      getConversationTitleSelectors(conversationId),
    )
    if (titleElement === null) {
      return ''
    }

    const renderedText = this.readDetachedText(titleElement, [
      'mat-icon',
      '[data-icon]',
      '[fonticon]',
      '[data-mat-icon-name]',
      '[class*="material-symbol" i]',
      '[class*="trailing" i]',
    ])
    const candidates = [
      ...renderedText.split('\n'),
      titleElement.getAttribute('title') ?? '',
      titleElement.getAttribute('aria-label') ?? '',
      renderedText,
    ]
    for (const candidate of candidates) {
      const normalized = this.normalizeText(candidate)
      if (isUsefulGeminiConversationTitle(normalized)) {
        return normalized
      }
    }
    return ''
  }
}
