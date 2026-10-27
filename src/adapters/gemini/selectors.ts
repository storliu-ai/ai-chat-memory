export const GEMINI_SELECTORS = {
  CHAT_CONTAINER: [
    'div#chat-history.chat-history-scroll-container',
    'div#chat-history',
    'infinite-scroller[data-test-id="chat-history-container"]',
    'chat-window-content > div.chat-history-scroll-container',
    'infinite-scroller.chat-history',
    'main .chat-history',
    'main infinite-scroller',
    '.chat-history',
    'infinite-scroller',
    'main [role="feed"]',
    'chat-window-content',
    'chat-window',
    'main',
    '[role="main"]',
  ],
  CONVERSATION_TURN: [
    '.conversation-container',
    '[class~="conversation-container"]',
    '.conversation-turn',
    '[data-test-id="conversation-turn"]',
    'share-turn-viewer',
  ],
  MESSAGE: [
    'user-query',
    'user-query-content',
    '.user-query',
    '.question-block',
    'model-response',
    'dual-model-response',
    'response-selection-panel',
    'response-container',
    '.model-response-container',
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
  ],
  USER_MESSAGE: [
    'user-query .query-text',
    'user-query .query-content',
    'user-query [class*="query-text"]',
    'user-query-content .query-text',
    'user-query-content .query-content',
    'user-query-content',
    '.user-query .query-text',
    '.user-query .query-content',
    '.user-query',
    '.question-block',
    'user-query message-content',
    '[data-message-author-role="user"] message-content',
    '[data-message-author-role="user"]',
    'user-query',
  ],
  ASSISTANT_MESSAGE: [
    '.presented-response-container structured-content-container > div.container',
    '.presented-response-container',
    'response-container structured-content-container > div.container',
    'structured-content-container > div.container',
    '.response-container-content',
    'model-response .model-response-text .markdown',
    'model-response .response-content message-content .markdown',
    'message-content .markdown.markdown-main-panel',
    'message-content .markdown',
    'model-response message-content',
    'model-response .markdown',
    'message-content',
    'structured-content-container',
    '[data-message-author-role="assistant"] message-content',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
    'model-response',
  ],
  TITLE: [
    'main [data-test-id="conversation-title"]',
    'main [data-testid="conversation-title"]',
    '[role="main"] [data-test-id="conversation-title"]',
    '[role="main"] [data-testid="conversation-title"]',
    'main h1',
  ],
  ACCOUNT_IDENTIFIER: [
    'a[href*="accounts.google.com/AccountChooser"]',
    'a[href*="accounts.google.com"][aria-label]',
    'a[aria-label*="Google Account" i]',
    'button[aria-label*="Google Account" i]',
    'a[aria-label*="Google 账号"]',
    'button[aria-label*="Google 账号"]',
    'a[aria-label*="Google 帳戶"]',
    'img[data-email]',
    '[data-email]',
  ],
  SIDEBAR: [
    'expandable-section[data-test-id="chats-expandable-section"]',
    'expandable-section[storagekey="chats"]',
    'side-navigation-v2',
    'gem-sidenav',
    'bard-sidenav',
    'mat-sidenav',
    'nav',
    'aside',
  ],
  SIDEBAR_SHELL: [
    'side-navigation-v2',
    'gem-sidenav',
    'bard-sidenav',
    'mat-sidenav',
    'nav',
    'aside',
  ],
  PINNED_SECTION: [
    'pinned-conversations',
    '[data-test-id*="pinned-conversation" i]',
    '[data-testid*="pinned-conversation" i]',
    '[data-section="pinned"]',
    '[class*="pinned-conversation" i]',
  ],
  UNPIN_ACTION: [
    '[data-test-id*="unpin" i]',
    '[data-testid*="unpin" i]',
    '[aria-label*="unpin" i]',
    '[aria-label*="取消置顶"]',
    '[aria-label*="取消置頂"]',
    '[aria-label*="取消固定"]',
    '[title*="取消固定"]',
    '[data-icon="keep_off"]',
  ],
  INLINE_PIN_INDICATOR: [
    ':scope > .mat-mdc-list-item-meta > span.trailing-icon-container mat-icon[data-mat-icon-name="push_pin"]',
    ':scope > .mat-mdc-list-item-meta > span.trailing-icon-container mat-icon[fonticon="push_pin"]',
    ':scope > a > .mat-mdc-list-item-meta > span.trailing-icon-container mat-icon[data-mat-icon-name="push_pin"]',
    ':scope > a > .mat-mdc-list-item-meta > span.trailing-icon-container mat-icon[fonticon="push_pin"]',
    ':scope > div:nth-of-type(2) > span mat-icon[data-mat-icon-name="push_pin"]',
    ':scope > div:nth-of-type(2) > span mat-icon[fonticon="push_pin"]',
    ':scope > a > div:nth-of-type(2) > span mat-icon[data-mat-icon-name="push_pin"]',
    ':scope > a > div:nth-of-type(2) > span mat-icon[fonticon="push_pin"]',
  ],
  ATTACHMENT: [
    '[data-test-id*="attachment"]',
    '[data-testid*="attachment"]',
    'img[data-test-id="uploaded-img"]',
    'user-query-file-preview',
    'user-query-file-carousel',
    '[class*="file-preview"]',
    '[class*="attachment"]',
  ],
  // Gemini's current prompt node carries the only rendered numeric position
  // that is present in the supplied DOM (`user-query-content-N`). Keep this
  // selector in the adapter so shared capture code never learns host markup.
  MESSAGE_ORDER: [
    'user-query-content[id^="user-query-content-"]',
    '[id^="user-query-content-"]',
  ],
} as const

const GEMINI_CONVERSATION_TITLE_DESCENDANTS = [
  // Current Gemini DOM, relative to either the matched anchor or its row:
  // gem-nav-list-item > a > span > span > span > span
  '> span > span > span > span',
  '> a > span > span > span > span',
  '.conversation-title',
  '[data-test-id="conversation-title"]',
  '[data-testid="conversation-title"]',
  '[class*="conversation-title" i]',
  '.gds-label-l',
] as const

const GENERIC_GEMINI_CONVERSATION_TITLE = /^(?:(?:google\s+)?gemini|new\s+(?:chat|conversation)|新(?:对话|對話|聊天)|(?:chat|conversation)\s+with\s+(?:google\s+)?gemini|(?:与|與)\s*(?:google\s+)?gemini\s*(?:对话|對話|聊天))$/i
const GEMINI_ACCOUNT_LABEL_TITLE = /^(?:google\s+)?(?:account|账号|帳戶)\s*[:：]/i

export interface GeminiConversationRootMetrics {
  turnCount: number
  messageCount: number
}

export function isBetterGeminiConversationRoot(
  candidate: GeminiConversationRootMetrics,
  current: GeminiConversationRootMetrics | null,
): boolean {
  return (
    current === null ||
    candidate.turnCount > current.turnCount ||
    (candidate.turnCount === current.turnCount &&
      candidate.messageCount > current.messageCount)
  )
}

export function getConversationLinkSelectors(conversationId: string): readonly string[] {
  const escapedId = CSS.escape(conversationId)
  const escapedJslogId = CSS.escape(`c_${conversationId}`)
  const conversationAnchorRoots = [
    'gem-nav-list-item[data-test-id="conversation"] > a',
    'conversations-list gem-nav-list-item > a',
    'pinned-conversations gem-nav-list-item > a',
    'a.conversation',
    '.conversation > a',
  ] as const
  const hrefMatchers = [
    `[href="/app/${escapedId}"]`,
    `[href$="/app/${escapedId}"]`,
    `[href*="/app/${escapedId}?"]`,
    `[href*="/app/${escapedId}#"]`,
  ] as const
  const conversationAnchors = hrefMatchers.flatMap((hrefMatcher) =>
    conversationAnchorRoots.map((root) => `${root}${hrefMatcher}`),
  )
  return [
    ...conversationAnchors.map((selector) => `${selector}[aria-current="page"]`),
    ...conversationAnchors,
    `gem-nav-list-item[data-test-id="conversation"][jslog*="${escapedJslogId}"]`,
    `gem-nav-list-item[data-test-id="conversation"]:has([jslog*="${escapedJslogId}"])`,
    `.conversation[jslog*="${escapedJslogId}"]`,
    `.conversation:has([jslog*="${escapedJslogId}"])`,
    `[data-conversation-id="${escapedId}"]`,
  ]
}

export function parseGeminiConversationIdFromJslog(value: string): string | null {
  const match =
    /\["c_([^"\]]+)/.exec(value) ??
    /(?:^|["'[\s])c_([A-Za-z0-9_-]+)/.exec(value)
  return match?.[1] ?? null
}

/** Parse Gemini's rendered prompt position without trusting arbitrary IDs. */
export function parseGeminiRenderedMessageOrder(value: string | null): number | null {
  const match = /^user-query-content-(\d+)$/.exec(value?.trim() ?? '')
  if (match === null) {
    return null
  }
  const order = Number(match[1])
  return Number.isSafeInteger(order) && order >= 0 ? order : null
}

export function getConversationTitleSelectors(conversationId: string): readonly string[] {
  const rowSelectors = getConversationLinkSelectors(conversationId)
  return [
    ...rowSelectors.flatMap((selector) =>
      GEMINI_CONVERSATION_TITLE_DESCENDANTS.map(
        (titleSelector) => `${selector} ${titleSelector}`,
      ),
    ),
    // Pinned rows do not always render the title-specific class used by the
    // ordinary history list. The matching row remains a safe final source
    // because it is already bound to the current conversation ID.
    ...rowSelectors,
  ]
}

export function isUsefulGeminiConversationTitle(value: string): boolean {
  const normalized = value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    normalized !== '' &&
    !GENERIC_GEMINI_CONVERSATION_TITLE.test(normalized) &&
    !GEMINI_ACCOUNT_LABEL_TITLE.test(normalized)
  )
}
