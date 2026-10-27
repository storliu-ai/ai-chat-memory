import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

const panelMessages = readSource('src/shared/panel-messages.ts')
assert.match(panelMessages, /CONVERSATION_LIVE_STATE_CHANGED/)
assert.match(panelMessages, /REQUEST_LIVE_STATE/)
assert.match(panelMessages, /interface HostConversationLiveState/)
assert.match(panelMessages, /isConversationLiveStateChangedMessage/)
assert.match(panelMessages, /recentMessages\.length <= 2/)

const observer = readSource('src/content/conversation-observer.ts')
assert.match(observer, /new MutationObserver/)
assert.match(observer, /getCurrentConversationLiveState/)
assert.match(observer, /syncStatus = 'pending'/)
assert.match(observer, /setSyncStatus\('saving'\)/)
assert.match(observer, /setSyncStatus\('synced'\)/)
assert.match(observer, /pinnedEvidence: this\.hasCurrentPinnedEvidence\(\)/)

const floatingPanel = readSource('src/content/floating-panel.ts')
assert.match(floatingPanel, /LIVE_STATE_THROTTLE_MS/)
assert.match(floatingPanel, /notifyConversationStateChanged/)
assert.match(floatingPanel, /getConversationLiveState/)

const currentPanel = readSource('src/panel/pages/CurrentConversationPanel.tsx')
assert.match(currentPanel, /STUCK_SYNC_RECOVERY_MS = 10_000/)
assert.match(currentPanel, /isConversationUpdatedExtensionEvent/)
assert.match(currentPanel, /subscribeHostConversationLiveState/)
assert.match(currentPanel, /requestHostConversationLiveState/)
assert.match(currentPanel, /currentSyncStatus === 'pending'.*currentSyncStatus === 'saving'/s)
assert.match(currentPanel, /setTimeout\(\(\) => \{.*requestHostConversationLiveState\(\).*STUCK_SYNC_RECOVERY_MS/s)
assert.match(currentPanel, /网页最近内容/)
assert.match(currentPanel, /首次自动收录需要网站置顶，也可手动采集/)
assert.match(currentPanel, /controller-identity/)
assert.match(currentPanel, /controller-compact-permissions/)
assert.match(currentPanel, /controller-action-bar/)
assert.doesNotMatch(
  currentPanel,
  /controller-live-title|messageCountSummary/,
  'The live state card must not repeat the conversation title and total count',
)
assert.doesNotMatch(
  currentPanel,
  /setInterval\(/,
  'The overlay must not continuously poll IndexedDB',
)

console.log('live conversation sync verification passed')
