const IMAGE_SOURCE_UI = '[data-d-component="image"][class~="group/search-image"] > .pointer-events-none.absolute > a.button-link'

export const CHATGPT_SELECTORS = {
  TRANSCRIPT: [
    '[data-thread-find-target="conversation"]',
    '[data-chatgpt-conversation-selection-target="true"]',
    '[data-thread-user-message-navigation-content="true"]',
  ],
  CONVERSATION_ID: ['[data-chatgpt-selection-conversation-id]'],
  INACTIVE_REGION: '[data-app-shell-active-page="false"], [hidden], [inert], [aria-hidden="true"]',
  PAIRED_TURN: ['[data-turn-key]', '[data-content-search-turn-key]'],
  RENDERED_MESSAGE: [
    '[data-user-message-bubble="true"]',
    '[data-chatgpt-search-unit-key$=":user"]',
    '[data-content-search-unit-key$=":user"]',
    '[data-chatgpt-selection-message-id]',
    '[data-markdown-text-style="assistant-message"]',
    '[data-dil-source-message-id]',
    '[data-dil-message-id]',
  ],
  USER_BODY: '[data-user-message-bubble="true"]',
  USER_UNIT: '[data-chatgpt-search-unit-key$=":user"], [data-content-search-unit-key$=":user"]',
  MESSAGE_UNIT: '[data-chatgpt-search-unit-key], [data-content-search-unit-key]',
  ASSISTANT_UNIT: '[data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]',
  AGENT_TURN_START: '[data-chatgpt-agent-turn-start]',
  COMPLETED_TURN: '[data-talvt-turn-state="complete"]',
  BUSY_RESPONSE: '[aria-busy="true"], [role="progressbar"]',
  RESPONSE_ID: '[data-chatgpt-selection-message-id]',
  CONTENT_UI: `[data-d-component="popover-trigger"], [data-d-component="badge"][data-d-hoverable], [data-d-component="favicon"], ${IMAGE_SOURCE_UI}, button, svg, [hidden], [inert], [aria-hidden="true"]`,
  ATTACHMENT_UI: `[data-d-component="popover-trigger"], [data-d-component="badge"][data-d-hoverable], [data-d-component="favicon"], ${IMAGE_SOURCE_UI}`,
  CHAT_CONTAINER: [
    'main [data-scroll-root]:has(section[data-testid^="conversation-turn-"])',
    'main [class*="overflow-y-auto"]:has(section[data-testid^="conversation-turn-"])',
    'main [class*="overflow-y-scroll"]:has(section[data-testid^="conversation-turn-"])',
    'main [class*="overflow-auto"]:has(section[data-testid^="conversation-turn-"])',
    'main [class*="react-scroll-to-bottom"]',
    'main',
    '[role="main"]',
  ],
  MESSAGE_TURN: [
    '[data-turn-key]',
    '[data-content-search-turn-key]',
    'section[data-testid^="conversation-turn-"][data-turn-id-container]',
    'section[data-testid^="conversation-turn-"]',
    'article[data-testid^="conversation-turn-"]',
    '[data-testid^="conversation-turn-"]',
  ],
  ROLE_MESSAGE: ['[data-message-author-role]'],
  USER_MESSAGE: [
    '[data-message-author-role="user"] [class*="whitespace-pre-wrap"]',
    '[data-message-author-role="user"]',
  ],
  ASSISTANT_MESSAGE: [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
  ],
  MESSAGE_CONTENT: [
    '[data-markdown-text-style="assistant-message"]',
    '[data-dil-source-message-id]',
    '[data-dil-message-id]',
    '.markdown',
    '[class*="whitespace-pre-wrap"]',
    '[class*="break-words"]',
  ],
  MESSAGE_TIME_MENU_TRIGGER: [
    'button[aria-haspopup="menu"][aria-label="更多操作"]',
    'button[aria-haspopup="menu"][aria-label*="more actions" i]',
  ],
  MESSAGE_TIME_MENU: [
    '[role="menu"][data-radix-menu-content][data-state="open"]',
  ],
  MESSAGE_TIME_LABEL: [
    ':scope > [role="menuitem"].__menu-label .truncate',
    ':scope > [role="menuitem"].__menu-label',
  ],
  CODE_BLOCK: ['pre'],
  CODE_CONTENT: ['pre code', 'code'],
  TITLE: [
    '[data-testid="conversation-title"]',
    'main h1',
    'h1[data-testid*="title"]',
  ],
  ACCOUNT_IDENTIFIER: [
    '[data-testid="accounts-profile-button"]',
    '[data-testid="profile-button"]',
  ],
  ACCOUNT_EMAIL: ['[data-email]'],
  ACCOUNT_PROFILE_TRIGGER: [
    '[data-testid="accounts-profile-button"]',
    '[data-testid="profile-button"]',
  ],
  ACCOUNT_DISPLAY_LABEL: [
    '[data-marquee-text]',
    '[class~="truncate"][class*="data-marquee-text"]',
    '[class~="truncate"]',
  ],
  ACCOUNT_DISPLAY_LABEL_FALLBACK: [
    '[class~="truncate"][class*="data-marquee-text"]',
  ],
  ACCOUNT_OVERLAY_TRIGGER: [
    'button[aria-haspopup="menu"][aria-label*="profile" i]',
    'button[aria-haspopup="menu"][aria-label*="account" i]',
    'button[aria-haspopup="menu"][aria-label*="个人资料"]',
    'button[aria-haspopup="menu"][aria-label*="账号"]',
    'button[aria-haspopup="menu"][aria-label*="账户"]',
  ],
  ACCOUNT_OVERLAY_ROW: '[class~="sidebar-item"]',
  ACCOUNT_OVERLAY_NAME: '[class~="truncate"][class~="text-default"]',
  ATTACHMENT: [
    '[class~="group/resource-card"]:has(> button[class~="peer/resource-card"])',
    'a[download]',
    '[data-testid*="attachment"]',
    '[data-testid*="file"]',
    '[data-file-name]',
    '[data-filename]',
    '[data-download-url]',
    'a[href*="oaiusercontent.com/"]',
    'a[href*="/backend-api/files/"]',
    'a[href*="/backend-api/estuary/"]',
    '[data-url*="oaiusercontent.com/"]',
    '[data-url*="/backend-api/files/"]',
    '[data-url*="/backend-api/estuary/"]',
    'a[href^="sandbox:"]',
    'a[href^="blob:"]',
  ],
  CONVERSATION_LINK: [
    'a[href^="/c/"]',
    'a[href^="https://chatgpt.com/c/"]',
  ],
  SIDEBAR: [
    '[data-testid*="sidebar" i]',
    'nav[aria-label*="chat" i]',
    'aside',
    'nav',
  ],
  PINNED_SECTION: [
    '[data-testid*="pinned-conversation" i]',
    '[data-testid*="pinned" i]',
    '[data-testid="pinned-conversations"]',
    '[data-section="pinned"]',
    '[aria-label="Pinned"]',
    '[aria-label*="pinned" i]',
    '[aria-label="已置顶"]',
    '[aria-label="置顶对话"]',
  ],
} as const

function getConversationHrefSelectors(conversationId: string): readonly string[] {
  const escapedId = CSS.escape(conversationId)
  return [
    `a[href="/c/${escapedId}"]`,
    `a[href^="/c/${escapedId}?"]`,
    `a[href^="/c/${escapedId}#"]`,
    `a[href="https://chatgpt.com/c/${escapedId}"]`,
    `a[href^="https://chatgpt.com/c/${escapedId}?"]`,
    `a[href^="https://chatgpt.com/c/${escapedId}#"]`,
  ]
}

export function getConversationLinkSelectors(conversationId: string): readonly string[] {
  const hrefSelectors = getConversationHrefSelectors(conversationId)
  return [
    ...hrefSelectors.map((selector) => `${selector}[aria-current="page"]`),
    ...hrefSelectors.map((selector) => `${selector}[data-active]`),
    ...hrefSelectors,
  ]
}

export function getPinnedConversationEvidenceSelectors(
  conversationId: string,
): readonly string[] {
  return getConversationHrefSelectors(conversationId).flatMap((href) => [
    `${href}[data-pinned="true"]`,
    `[data-pinned="true"] ${href}`,
    `[data-is-pinned="true"] ${href}`,
    `[data-testid="pinned-conversations"] ${href}`,
    `[data-section="pinned"] ${href}`,
    `[aria-label*="已置顶"] ${href}`,
    `[aria-label*="置顶对话"] ${href}`,
    `${href} [aria-label*="unpin" i]`,
    `${href} [aria-label*="取消置顶"]`,
  ])
}

export const CHATGPT_UNPIN_SELECTORS = [
  '[data-testid*="unpin" i]',
  '[aria-label*="unpin" i]',
  '[title*="unpin" i]',
  '[aria-label*="取消置顶"]',
  '[title*="取消置顶"]',
  '[aria-label*="取消固定"]',
  '[title*="取消固定"]',
] as const
