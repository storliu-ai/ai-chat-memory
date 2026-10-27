export const DEEPSEEK_SELECTORS = {
  CHAT_CONTAINER: [
    '[class~="ds-virtual-list"]',
    '[class*="ds-virtual-list"]',
    'main',
    '[role="main"]',
    '#root',
  ],
  MESSAGE_ITEM: ['[data-virtual-list-item-key]'],
  ASSISTANT_MESSAGE: [
    '.ds-assistant-message-main-content',
    '.ds-markdown',
  ],
  USER_MESSAGE: [
    '[data-role="user"]',
    '[data-message-author-role="user"]',
    '[class*="user-message"]',
  ],
  TITLE: [
    '[data-testid="conversation-title"]',
    '[class*="chat-title"]',
    'main h1',
  ],
  ACCOUNT_IDENTIFIER: [
    '[data-email]',
    '[class*="avatar"] [title]',
    'button[aria-label*="account" i]',
    'button[aria-label*="profile" i]',
    'button[aria-label*="账号"]',
    'button[aria-label*="账户"]',
  ],
  SIDEBAR: ['aside', 'nav', '[class*="sider"]', '[class*="sidebar"]'],
  PINNED_SECTION: [
    '[data-testid*="pinned-conversation" i]',
    '[data-section="pinned"]',
    '[class~="pinned"]',
    '[class*="pinned-conversation" i]',
    '[aria-label*="置顶对话"]',
    '[aria-label*="置頂對話"]',
  ],
  UNPIN_ACTION: [
    '[data-testid*="unpin" i]',
    '[aria-label*="unpin" i]',
    '[aria-label*="取消置顶"]',
    '[aria-label*="取消置頂"]',
    '[title*="取消置顶"]',
    '[title*="取消置頂"]',
    '[aria-label*="取消固定"]',
    '[title*="取消固定"]',
  ],
  ATTACHMENT: [
    '[class*="attachment"]',
    '[class*="file-card"]',
    'a[download]',
  ],
} as const

export function getConversationLinkSelectors(conversationId: string): readonly string[] {
  const escapedId = CSS.escape(conversationId)
  return [
    `a[href="/a/chat/s/${escapedId}"][aria-current="page"]`,
    `a[href="/a/chat/s/${escapedId}"]`,
    `a[href*="/a/chat/s/${escapedId}"]`,
  ]
}
