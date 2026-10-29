import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (path) => readFileSync(join(root, path), 'utf8')

const databaseSource = readSource('src/db/database.ts')
assert.match(databaseSource, /DATABASE_VERSION = 3/)
assert.match(databaseSource, /CONVERSATION_EXCLUSIONS: 'conversationExclusions'/)

const exclusionSource = readSource('src/db/conversation-exclusions.ts')
assert.match(exclusionSource, /deleteConversationWithExclusionPolicy/)
assert.match(exclusionSource, /putConversationWithExclusionPolicy/)
assert.match(exclusionSource, /conversation\.pinned === true/)
assert.match(exclusionSource, /exclusionStore\.delete\(id\)/)
assert.match(
  exclusionSource,
  /exclusion !== undefined \|\| legacyExclusion !== undefined && existing === undefined/,
)
assert.match(exclusionSource, /saveMode === 'manual'/)
assert.match(
  exclusionSource,
  /STORE_NAME\.CONVERSATIONS, STORE_NAME\.CONVERSATION_EXCLUSIONS/,
)

const observerSource = readSource('src/content/conversation-observer.ts')
assert.match(
  observerSource,
  /const saveMode = trigger === 'manual' \? 'manual' : 'automatic'/,
)
assert.match(observerSource, /saveMode,\s*conversation:/)
assert.match(observerSource, /UPDATE_CONVERSATION_PINNED/)
assert.match(observerSource, /isUnpinActionTarget/)

const serviceWorkerSource = readSource('src/background/service-worker.ts')
assert.match(serviceWorkerSource, /request\.saveMode \?\? 'automatic'/)
assert.match(serviceWorkerSource, /GET_CONVERSATION_EXCLUSIONS/)
assert.match(serviceWorkerSource, /REMOVE_CONVERSATION_EXCLUSION/)
assert.match(serviceWorkerSource, /UPDATE_CONVERSATION_PINNED/)

const dataManagementSource = readSource('src/services/data-management-service.ts')
assert.match(
  dataManagementSource,
  /objectStore\(STORE_NAME\.CONVERSATION_EXCLUSIONS\)\.clear\(\)/,
)
assert.match(dataManagementSource, /exclusionStore\.delete\(id\)/)

const settingsSource = readSource('src/panel/pages/SettingsPage.tsx')
assert.match(settingsSource, /自动保存排除列表/)
assert.match(settingsSource, /解除排除/)

console.log('conversation exclusion verification passed')
