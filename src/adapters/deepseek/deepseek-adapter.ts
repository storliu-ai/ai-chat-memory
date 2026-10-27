import type { ChatMessage, ExtractedConversation } from '../../shared/models'
import { BaseAdapter } from '../base-adapter'
import { collectAttachmentCandidates } from '../attachment-candidates'
import { DEEPSEEK_SELECTORS, getConversationLinkSelectors } from './selectors'

const EMAIL_IDENTIFIER = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_IDENTIFIER = /\+?\d[\d\s()-]{6,}\d/
const GENERIC_ACCOUNT_LABEL = /^(?:account|profile|menu|settings|账号|账户|设置)$/i

interface RenderedMessageEntry {
  root: Element
  attachmentRoot?: Element
  message: ChatMessage
}

const DOCUMENT_POSITION_FOLLOWING = 4
const DOCUMENT_POSITION_PRECEDING = 2

export class DeepSeekAdapter extends BaseAdapter {
  readonly platform = 'deepseek' as const

  isConversationPage(): boolean {
    return this.getConversationId() !== null
  }

  getConversationId(): string | null {
    try {
      const url = new URL(location.href)
      if (url.hostname !== 'chat.deepseek.com') {
        return null
      }
      const match = /^\/a\/chat\/s\/([^/?#]+)/.exec(url.pathname)
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
        const match = /^\/a\/chat\/s\/([^/?#]+)/.exec(
          new URL(href, location.origin).pathname,
        )
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
      const renderedTitle = this.readText(this.queryFirst(DEEPSEEK_SELECTORS.TITLE))
      if (this.isUsefulTitle(renderedTitle)) {
        return renderedTitle
      }
      const documentTitle = this.normalizeText(
        document.title
          .replace(/\s*[|–—-]\s*DeepSeek\s*$/i, '')
          .replace(/^DeepSeek\s*[|–—-]\s*/i, ''),
      )
      return this.isUsefulTitle(documentTitle) ? documentTitle : 'Untitled conversation'
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

  getAccountIdentifier(): string | null {
    try {
      for (const element of this.queryAll(DEEPSEEK_SELECTORS.ACCOUNT_IDENTIFIER)) {
        for (const raw of [
          element.getAttribute('data-email'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          this.readText(element),
        ]) {
          const value = this.normalizeText(raw ?? '')
          const email = EMAIL_IDENTIFIER.exec(value)?.[0]
          if (email !== undefined) {
            return email
          }
          const phone = PHONE_IDENTIFIER.exec(value)?.[0]
          if (phone !== undefined) {
            return phone.replace(/[\s()-]/g, '')
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  getAccountLabel(): string {
    try {
      for (const element of this.queryAll(DEEPSEEK_SELECTORS.ACCOUNT_IDENTIFIER)) {
        const value = this.normalizeText(
          element.getAttribute('aria-label') ??
            element.getAttribute('title') ??
            this.readText(element),
        )
        if (value.length >= 2 && value.length <= 100 && !GENERIC_ACCOUNT_LABEL.test(value)) {
          return EMAIL_IDENTIFIER.exec(value)?.[0] ?? value
        }
      }
    } catch {
      // Fall through to the identifier.
    }
    return this.getAccountIdentifier() ?? 'Unknown'
  }

  getConversationContainer(): Element | null {
    const assistant = this.queryFirst(DEEPSEEK_SELECTORS.ASSISTANT_MESSAGE)
    if (assistant !== null) {
      const messageList = assistant.closest('.ds-virtual-list, [class*="ds-virtual-list"]')
      if (messageList !== null) {
        return messageList
      }
    }
    return this.queryFirst(DEEPSEEK_SELECTORS.CHAT_CONTAINER)
  }

  getSidebarContainer(): Element | null {
    return this.queryFirst(DEEPSEEK_SELECTORS.SIDEBAR)
  }

  getConversationSidebarElement(conversationId: string): Element | null {
    return this.queryFirst(getConversationLinkSelectors(conversationId))
  }

  supportsPinnedConversations(): boolean {
    return false
  }

  isPinActionTarget(): boolean {
    return false
  }

  isUnpinActionTarget(): boolean {
    return false
  }

  isCurrentConversationPinned(): boolean {
    return false
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
      messageEntries.map(({ root, attachmentRoot }, messageIndex) => ({
        root: attachmentRoot ?? root,
        messageIndex,
      })),
      DEEPSEEK_SELECTORS.ATTACHMENT,
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

  private readAssistantMessage(
    element: Element,
    sourceRoot: Element = element,
  ): ChatMessage | null {
    const content = this.readDetachedText(element, [
      '.ds-markdown-code-copy-button',
      '.ds-think-content',
    ])
    return content === ''
      ? null
      : this.withSourceMessageTime({ role: 'assistant', content }, sourceRoot)
  }

  private readUserMessage(
    element: Element,
    attachmentRoot: Element = element,
  ): ChatMessage | null {
    const content = this.readDetachedText(element, [
      '[class*="message-action"]',
      '[class*="toolbar"]',
    ])
    const attachmentNames = this.queryAll(DEEPSEEK_SELECTORS.ATTACHMENT, attachmentRoot)
      .map((attachment) => this.readText(attachment))
      .filter((name) => name !== '' && name.length <= 255)
    if (content === '' && attachmentNames.length === 0) {
      return null
    }
    const message: ChatMessage = attachmentNames.length > 0
      ? { role: 'user', content, attachmentNames: [...new Set(attachmentNames)] }
      : { role: 'user', content }
    return this.withSourceMessageTime(message, attachmentRoot)
  }

  private getTopLevelElements(elements: Element[]): Element[] {
    return elements.filter((element, index, candidates) =>
      !candidates.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index && candidate.contains(element),
      ),
    )
  }

  private readRoleEntries(
    root: Element,
    userAttachmentRoot: Element | null = null,
  ): RenderedMessageEntry[] {
    const userElements = this.getTopLevelElements(
      this.queryElementsIncludingRoot(root, DEEPSEEK_SELECTORS.USER_MESSAGE),
    )
    const assistantElements = this.getTopLevelElements(
      this.queryElementsIncludingRoot(root, DEEPSEEK_SELECTORS.ASSISTANT_MESSAGE),
    )
    return this.readRoleEntriesFromElements(
      userElements,
      assistantElements,
      userAttachmentRoot,
    )
  }

  private readRoleEntriesFromElements(
    userElements: Element[],
    assistantElements: Element[],
    userAttachmentRoot: Element | null,
  ): RenderedMessageEntry[] {
    const userSet = new Set(userElements)
    const roleElements = this.sortInDocumentOrder(
      this.getTopLevelElements([...userElements, ...assistantElements]),
    )
    return roleElements.flatMap((element) => {
      const message = userSet.has(element)
        ? this.readUserMessage(element, userAttachmentRoot ?? element)
        : this.readAssistantMessage(element, userAttachmentRoot ?? element)
      return message === null
        ? []
        : [{
            root: element,
            attachmentRoot: userSet.has(element)
              ? userAttachmentRoot ?? element
              : element,
            message,
          }]
    })
  }

  private queryElementsIncludingRoot(
    root: Element,
    selectors: readonly string[],
  ): Element[] {
    const candidates = [
      ...(selectors.some((selector) => {
        try {
          return root.matches(selector)
        } catch {
          return false
        }
      }) ? [root] : []),
      ...this.queryAll(selectors, root),
    ]
    return candidates.filter(
      (element, index) => candidates.indexOf(element) === index,
    )
  }

  private sortInDocumentOrder(elements: Element[]): Element[] {
    return [...elements].sort((left, right) => {
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

  /**
   * DeepSeek currently renders a user question and its answer in the same
   * virtual-list item. The old assistant-first branch discarded the question
   * as soon as an answer node was present. Collect both role roots and sort
   * them by their actual DOM order instead.
   */
  private readMessageEntries(item: Element): RenderedMessageEntry[] {
    if (item.getAttribute('data-virtual-list-item-key') === '-999') {
      return []
    }
    return this.readRoleEntries(item, item)
  }

  private getRenderedMessageEntries(container: Element): RenderedMessageEntry[] {
    const items = this.getTopLevelElements(
      this.queryElementsIncludingRoot(container, DEEPSEEK_SELECTORS.MESSAGE_ITEM),
    )
    const itemEntries = items.flatMap((root) => this.readMessageEntries(root))

    // Some virtual-list updates mount the question beside the item that owns
    // the answer. Keep those role nodes as well, while excluding nodes already
    // covered by an item so the same message is not emitted twice.
    const userCandidates = this.queryElementsIncludingRoot(
      container,
      DEEPSEEK_SELECTORS.USER_MESSAGE,
    ).filter((element) => !items.some((item) => item.contains(element)))
    const assistantCandidates = this.queryElementsIncludingRoot(
      container,
      DEEPSEEK_SELECTORS.ASSISTANT_MESSAGE,
    ).filter((element) => !items.some((item) => item.contains(element)))
    const outsideEntries = this.readRoleEntriesFromElements(
      this.getTopLevelElements(userCandidates),
      this.getTopLevelElements(assistantCandidates),
      null,
    )

    const seenRoots = new Set<Element>()
    return this.sortEntriesInDocumentOrder([...itemEntries, ...outsideEntries])
      .filter(({ root }) => {
        if (seenRoots.has(root)) {
          return false
        }
        seenRoots.add(root)
        return true
      })
  }

  private sortEntriesInDocumentOrder(
    entries: RenderedMessageEntry[],
  ): RenderedMessageEntry[] {
    return [...entries].sort((left, right) =>
      this.compareDocumentOrder(left.root, right.root),
    )
  }

  private compareDocumentOrder(left: Element, right: Element): number {
    const position = left.compareDocumentPosition(right)
    if ((position & DOCUMENT_POSITION_FOLLOWING) !== 0) {
      return -1
    }
    if ((position & DOCUMENT_POSITION_PRECEDING) !== 0) {
      return 1
    }
    return 0
  }

  private isUsefulTitle(value: string): boolean {
    return value !== '' && !/^(deepseek|new chat|新建对话|新对话)$/i.test(value)
  }
}
