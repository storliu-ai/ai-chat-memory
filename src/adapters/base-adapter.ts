import type { AIAdapter } from './types'
import type { ChatMessage } from '../shared/models'
import { parseSourceMessageTimestamp } from '../shared/message-timestamps'
import {
  isPinActionDescriptor,
  isPinIconDescriptor,
  isPinnedDescriptor,
  isUnpinActionDescriptor,
} from './pin-descriptors'

const GENERIC_PINNED_SECTION_SELECTORS = [
  '[data-pinned="true"]',
  '[data-is-pinned="true"]',
  '[data-section="pinned"]',
  '[data-state="pinned"]',
  '[data-testid*="pinned" i]',
  '[data-test-id*="pinned" i]',
  '[aria-label*="pinned" i]',
  '[aria-label*="已置顶"]',
  '[aria-label*="已置頂"]',
  '[aria-label*="置顶对话"]',
  '[aria-label*="置頂對話"]',
  '[aria-label*="已固定"]',
  '[aria-label*="固定的对话"]',
  '[aria-label*="固定的對話"]',
  '[class~="pinned"]',
  '[class*="pinned-conversation" i]',
] as const

const GENERIC_UNPIN_SELECTORS = [
  '[data-testid*="unpin" i]',
  '[data-test-id*="unpin" i]',
  '[aria-label*="unpin" i]',
  '[title*="unpin" i]',
  '[aria-label*="remove pin" i]',
  '[title*="remove pin" i]',
  '[aria-label*="取消置顶"]',
  '[aria-label*="取消置頂"]',
  '[title*="取消置顶"]',
  '[title*="取消置頂"]',
  '[aria-label*="解除置顶"]',
  '[aria-label*="解除置頂"]',
  '[aria-label*="取消固定"]',
  '[title*="取消固定"]',
  '[aria-label*="解除固定"]',
  '[title*="解除固定"]',
  '[data-icon="keep_off"]',
] as const

const PIN_ICON_CANDIDATES = [
  'mat-icon',
  '[data-icon]',
  '[fonticon]',
  '[data-mat-icon-name]',
  '[class*="material-symbol" i]',
] as const

const CONVERSATION_COLLECTION_BOUNDARY_SELECTOR = [
  'mat-nav-list',
  'conversations-list',
  'pinned-conversations',
  '[role="list"]',
  '[data-testid*="conversation-list" i]',
  '[data-test-id*="conversation-list" i]',
].join(',')

export abstract class BaseAdapter implements AIAdapter {
  abstract readonly platform: AIAdapter['platform']
  abstract isConversationPage(): boolean
  abstract getConversationId(): string | null
  abstract getConversationIdFromTarget(target: EventTarget | null): string | null
  abstract getTitle(): string
  abstract getMessages(): ReturnType<AIAdapter['getMessages']>
  abstract getAccountIdentifier(): string | null
  abstract getAccountLabel(): string
  abstract getConversationContainer(): Element | null
  getConversationObservationContainer(): Element | null {
    return this.getConversationContainer()
  }
  abstract getSidebarContainer(): Element | null
  abstract getConversationSidebarElement(conversationId: string): Element | null
  abstract supportsPinnedConversations(): boolean
  abstract isPinActionTarget(target: EventTarget | null): boolean
  abstract isUnpinActionTarget(target: EventTarget | null): boolean
  abstract isCurrentConversationPinned(): boolean
  abstract extractConversation(): ReturnType<AIAdapter['extractConversation']>

  protected queryFirst(
    selectors: readonly string[],
    root: ParentNode = document,
  ): Element | null {
    for (const selector of selectors) {
      try {
        const element = root.querySelector(selector)
        if (element !== null) {
          return element
        }
      } catch {
        // A stale selector must never escape into the host page.
      }
    }
    return null
  }

  protected queryAll(selectors: readonly string[], root: ParentNode = document): Element[] {
    try {
      return Array.from(root.querySelectorAll(selectors.join(',')))
    } catch {
      return []
    }
  }

  protected readText(element: Element | null): string {
    if (element === null) {
      return ''
    }

    try {
      const text = element instanceof HTMLElement ? element.innerText : element.textContent
      return this.normalizeText(text ?? '')
    } catch {
      return ''
    }
  }

  protected normalizeText(value: string): string {
    return value
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  protected withSourceMessageTime(
    message: ChatMessage,
    root: Element,
  ): ChatMessage {
    const attributes = [
      'data-message-timestamp',
      'data-timestamp',
      'data-created-at',
      'data-create-time',
      'data-sent-at',
    ] as const
    const elements = [
      root,
      ...this.queryAll([
        '[data-message-timestamp]',
        '[data-timestamp]',
        '[data-created-at]',
        '[data-create-time]',
        '[data-sent-at]',
        'time[datetime][data-testid*="time" i]',
        'time[datetime][data-test-id*="time" i]',
        'time[datetime][class*="timestamp" i]',
      ], root),
    ]
    for (const element of elements) {
      for (const attribute of attributes) {
        const sentAt = parseSourceMessageTimestamp(element.getAttribute(attribute))
        if (sentAt !== null) {
          return { ...message, sentAt }
        }
      }
      if (element instanceof HTMLTimeElement) {
        const sentAt = parseSourceMessageTimestamp(element.dateTime)
        if (sentAt !== null) {
          return { ...message, sentAt }
        }
      }
    }
    return message
  }

  protected isRenderedPinActionTarget(target: EventTarget | null): boolean {
    return this.getRenderedPinActionDescriptors(target).some(isPinActionDescriptor)
  }

  protected isRenderedUnpinActionTarget(target: EventTarget | null): boolean {
    return this.getRenderedPinActionDescriptors(target).some(isUnpinActionDescriptor)
  }

  private getRenderedPinActionDescriptors(target: EventTarget | null): string[] {
    try {
      if (!(target instanceof Element)) {
        return []
      }
      const action = target.closest(
        '[role^="menuitem"], [role="option"], mat-option, [mat-menu-item], .mat-mdc-menu-item, button, [data-action], [data-testid], [data-test-id]',
      )
      if (action === null) {
        return []
      }
      return [
        action.getAttribute('aria-label'),
        action.getAttribute('data-testid'),
        action.getAttribute('data-test-id'),
        action.getAttribute('title'),
        action.getAttribute('data-tooltip'),
        action.getAttribute('mattooltip'),
        action.getAttribute('data-icon'),
        this.readText(action),
        this.normalizeText(action.textContent ?? ''),
      ]
        .filter((value): value is string => value !== null)
        .map((value) => this.normalizeText(value))
        .filter((value) => value !== '')
    } catch {
      return []
    }
  }

  protected getRenderedConversationIdFromTarget(
    target: EventTarget | null,
    parseHref: (href: string) => string | null,
  ): string | null {
    try {
      if (!(target instanceof Element)) {
        return null
      }
      const sidebar = this.getSidebarContainer()
      if (sidebar === null || !sidebar.contains(target)) {
        return null
      }

      let current: Element | null = target
      for (let depth = 0; current !== null && depth < 8; depth += 1) {
        const link = current.matches('a[href]')
          ? current
          : this.queryFirst(['a[href]'], current)
        const href = link?.getAttribute('href')
        if (href !== null && href !== undefined) {
          const conversationId = parseHref(href)
          if (conversationId !== null) {
            return conversationId
          }
        }
        if (current === sidebar) {
          break
        }
        current = current.parentElement
      }
      return null
    } catch {
      return null
    }
  }

  protected hasRenderedPinnedConversation(
    conversationSelectors: readonly string[],
    pinnedSectionSelectors: readonly string[] = [],
    unpinSelectors: readonly string[] = [],
    inlinePinSelectors: readonly string[] = [],
    collectionConversationSelectors: readonly string[] = conversationSelectors,
  ): boolean {
    try {
      const sectionSelectors = [
        ...GENERIC_PINNED_SECTION_SELECTORS,
        ...pinnedSectionSelectors,
      ]
      for (const section of this.queryAll(sectionSelectors)) {
        const descriptor = [
          section.tagName,
          section.getAttribute('data-testid'),
          section.getAttribute('data-test-id'),
          section.getAttribute('data-section'),
          section.getAttribute('data-state'),
          section.getAttribute('aria-label'),
          section.getAttribute('class'),
        ]
          .filter((value): value is string => value !== null)
          .join(' ')
        const isExplicitPinnedSection =
          section.getAttribute('data-pinned') === 'true' ||
          section.getAttribute('data-is-pinned') === 'true' ||
          isPinnedDescriptor(descriptor)
        if (
          isExplicitPinnedSection &&
          this.queryFirst(conversationSelectors, section) !== null
        ) {
          return true
        }
      }

      const renderedUnpinSelectors = [
        ...GENERIC_UNPIN_SELECTORS,
        ...unpinSelectors,
      ]
      const sidebar = this.getSidebarContainer()
      for (const link of this.queryAll(conversationSelectors)) {
        let current: Element | null = link
        for (let depth = 0; current !== null && depth < 7; depth += 1) {
          if (current === sidebar) {
            break
          }
          // Pin evidence must belong to this conversation row. Stop before a
          // collection ancestor can contribute a push-pin from a sibling row.
          if (
            current !== link &&
            (current.matches(CONVERSATION_COLLECTION_BOUNDARY_SELECTOR) ||
              this.queryAll(collectionConversationSelectors, current).length > 1)
          ) {
            break
          }
          if (
            current.getAttribute('data-pinned') === 'true' ||
            current.getAttribute('data-is-pinned') === 'true' ||
            this.queryFirst(renderedUnpinSelectors, current) !== null
          ) {
            return true
          }

          if (depth < 5) {
            const staticPinIcon = this.queryAll(
              [...PIN_ICON_CANDIDATES, ...inlinePinSelectors],
              current,
            )
              .find((icon) => {
                const descriptors = [
                  icon.getAttribute('data-icon'),
                  icon.getAttribute('fonticon'),
                  icon.getAttribute('data-mat-icon-name'),
                  icon.getAttribute('aria-label'),
                  icon.getAttribute('title'),
                  icon.getAttribute('class'),
                  this.readText(icon),
                  icon.textContent,
                ]
                  .filter((value): value is string => value !== null)
                  .map((value) => this.normalizeText(value))
                return (
                  (descriptors.some(isPinIconDescriptor) ||
                    descriptors.some(isPinnedDescriptor)) &&
                  icon.closest('button, [role="button"], [role^="menuitem"]') === null
                )
              })
            if (staticPinIcon !== undefined) {
              return true
            }
          }

          const descriptor = [
            current.getAttribute('data-testid'),
            current.getAttribute('data-test-id'),
            current.getAttribute('data-section'),
            current.getAttribute('data-state'),
            current.getAttribute('aria-label'),
            current.getAttribute('title'),
            current.getAttribute('data-icon'),
            current.getAttribute('class'),
          ]
            .filter((value): value is string => value !== null)
            .join(' ')
          if (isPinnedDescriptor(descriptor)) {
            return true
          }
          current = current.parentElement
        }
      }
      return false
    } catch {
      return false
    }
  }

  protected readDetachedText(
    element: Element,
    ignoredSelectors: readonly string[] = [],
  ): string {
    try {
      const clone = element.cloneNode(true)
      if (!(clone instanceof Element)) {
        return this.readText(element)
      }
      const selectors = [
        'button',
        'svg',
        'style',
        'script',
        '[aria-hidden="true"]',
        '[data-extension-ui="ai-chat-memory"]',
        ...ignoredSelectors,
      ]
      clone.querySelectorAll(selectors.join(',')).forEach((node) => node.remove())
      return this.readText(clone)
    } catch {
      return this.readText(element)
    }
  }
}
