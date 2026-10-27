import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (path) => readFileSync(join(root, path), 'utf8')
const toDataModule = (source) => {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}

globalThis.CSS = { escape: (value) => value }

const selectorSource = readSource('src/adapters/chatgpt/selectors.ts')
const selectors = await import(toDataModule(selectorSource))

for (const selector of [
  '[data-download-url]',
  'a[href*="oaiusercontent.com/"]',
  'a[href*="/backend-api/files/"]',
  'a[href*="/backend-api/estuary/"]',
]) {
  assert.equal(
    selectors.CHATGPT_SELECTORS.ATTACHMENT.includes(selector),
    true,
    `Current ChatGPT file selector is missing: ${selector}`,
  )
}
assert.equal(
  selectors.CHATGPT_SELECTORS.ACCOUNT_DISPLAY_LABEL_FALLBACK.includes(
    '[class~="truncate"][class*="data-marquee-text"]',
  ),
  true,
  'The current truncate/marquee account-name node must remain supported',
)
assert.equal(
  selectors.CHATGPT_SELECTORS.CONVERSATION_LINK.includes('a[href^="/c/"]'),
  true,
  'ChatGPT pin-row boundaries need all rendered conversation links',
)
assert.equal(
  selectors.CHATGPT_SELECTORS.MESSAGE_TURN.includes(
    'section[data-testid^="conversation-turn-"][data-turn-id-container]',
  ),
  true,
  'Current section-based ChatGPT turns must be recognized explicitly',
)
assert.equal(
  selectors.CHATGPT_SELECTORS.CHAT_CONTAINER.includes(
    'main [class*="overflow-y-auto"]:has(section[data-testid^="conversation-turn-"])',
  ),
  true,
  'The current section-based ChatGPT scroll root must outrank the main-page fallback',
)

const currentConversationSelectors = selectors.getConversationLinkSelectors('conversation-1')
assert.equal(
  currentConversationSelectors.includes('a[href^="/c/conversation-1?"]'),
  true,
  'Conversation rows with URL query parameters must still match',
)
assert.equal(
  currentConversationSelectors.includes(
    'a[href^="https://chatgpt.com/c/conversation-1?"]',
  ),
  true,
  'Absolute ChatGPT conversation links must still match',
)
assert.equal(
  selectors.getPinnedConversationEvidenceSelectors('conversation-1').some(
    (selector) => selector.includes('/c/conversation-1?'),
  ),
  true,
  'Pinned evidence must use the same query-aware conversation identity',
)

const accountLabels = await import(toDataModule(
  readSource('src/shared/account-labels.ts'),
))
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('Lion'), 'Lion')

const adapterSource = readSource('src/adapters/chatgpt/chatgpt-adapter.ts')
assert.match(adapterSource, /ACCOUNT_PROFILE_TRIGGER/)
assert.match(adapterSource, /ACCOUNT_DISPLAY_LABEL_FALLBACK/)
assert.match(adapterSource, /data-turn-id/)
assert.match(adapterSource, /data-message-id/)
assert.match(adapterSource, /readRenderedTurnOrder/)
assert.match(adapterSource, /element\.closest\('main, a\[href\^="\/c\/"\]/)
assert.match(adapterSource, /sidebar\.contains\(element\)/)
assert.match(
  adapterSource,
  /CHATGPT_UNPIN_SELECTORS,\s*\[\],\s*CHATGPT_SELECTORS\.CONVERSATION_LINK/,
  'Pinned evidence must stop at the current ChatGPT conversation row',
)
const readRoleElementIndex = adapterSource.indexOf('private readRoleElement(')
const attachmentNamesIndex = adapterSource.indexOf(
  'const attachmentNames = this.getAttachmentNames(attachmentRoot)',
  readRoleElementIndex,
)
const emptyMessageCheckIndex = adapterSource.indexOf(
  "if (content === '' && attachmentNames.length === 0)",
  readRoleElementIndex,
)
assert.ok(
  attachmentNamesIndex > readRoleElementIndex &&
    emptyMessageCheckIndex > attachmentNamesIndex,
  'A file-only ChatGPT turn must survive message extraction',
)

const baseAdapterSource = readSource('src/adapters/base-adapter.ts')
assert.match(baseAdapterSource, /collectionConversationSelectors/)
assert.match(
  baseAdapterSource,
  /this\.queryAll\(collectionConversationSelectors, current\)\.length > 1/,
)
assert.doesNotMatch(
  baseAdapterSource,
  /this\.queryAll\(conversationSelectors, current\)\.length > 1/,
  'A current-ID selector cannot detect sibling conversation rows',
)

const attachmentCandidateSource = readSource(
  'src/adapters/attachment-candidates.ts',
)
assert.match(
  attachmentCandidateSource,
  /\['data-download-url', 'data-url', 'href'\]/,
  'A rendered HTTPS download URL must win over an unusable sandbox href',
)
assert.match(attachmentCandidateSource, /\['filename', 'file_name', 'name'\]/)

const observerSource = readSource('src/content/conversation-observer.ts')
const pinnedGateIndex = observerSource.indexOf('if (pinnedOnly && !pinnedEvidence)')
const policyDecisionIndex = observerSource.indexOf(
  'canAutomaticallyCaptureConversation(',
  pinnedGateIndex,
)
const savingStatusIndex = observerSource.indexOf(
  "this.setSyncStatus('saving')",
  policyDecisionIndex,
)
const saveRequestIndex = observerSource.indexOf(
  'type: RUNTIME_MESSAGE_TYPE.SAVE_CONVERSATION',
  savingStatusIndex,
)
assert.ok(pinnedGateIndex >= 0 && policyDecisionIndex > pinnedGateIndex)
assert.ok(
  savingStatusIndex > policyDecisionIndex && saveRequestIndex > savingStatusIndex,
  'An unpinned first-time conversation must not report that it is being saved',
)

console.log('current ChatGPT DOM regression verification passed')
