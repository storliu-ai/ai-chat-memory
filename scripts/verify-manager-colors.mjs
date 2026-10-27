import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

function transpile(relativePath) {
  return ts.transpileModule(readSource(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText
}

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

const displayColorsUrl = dataModule(transpile('src/shared/display-colors.ts'))
const displayColors = await import(displayColorsUrl)
const colorJavaScript = transpile('src/panel/conversation-colors.ts').replace(
  /(['"])\.\.\/shared\/display-colors\1/,
  `'${displayColorsUrl}'`,
)
const colors = await import(dataModule(colorJavaScript))

assert.equal(
  displayColors.DISPLAY_COLOR_OPTIONS.length,
  16,
  'The Manager must offer exactly 16 manual colors',
)
assert.equal(
  new Set(displayColors.DISPLAY_COLOR_OPTIONS.map(({ id }) => id)).size,
  16,
  'Every manual color token must be unique',
)

assert.deepEqual(
  colors.getManagerConversationColorStyle(undefined, undefined),
  {},
  'Unassigned accounts and environments must not be recolored',
)

const accountOnly = colors.getManagerConversationColorStyle('rose', undefined)
assert.ok(accountOnly['--manager-account-tag-background'])
assert.equal(accountOnly['--manager-environment-background'], undefined)

const environmentOnly = colors.getManagerConversationColorStyle(undefined, 'blue')
assert.ok(environmentOnly['--manager-environment-background'])
assert.equal(environmentOnly['--manager-account-tag-background'], undefined)

assert.notEqual(
  colors.getManagerConversationColorStyle('rose', undefined)[
    '--manager-account-tag-background'
  ],
  colors.getManagerConversationColorStyle('blue', undefined)[
    '--manager-account-tag-background'
  ],
  'Different selected tokens must produce different account tag colors',
)

const cardSource = readSource('src/panel/components/ConversationCard.tsx')
assert.match(
  cardSource,
  /getManagerConversationColorStyle\(\s*accountColor,\s*environmentColor,?\s*\)/,
)
assert.match(cardSource, /account-color-tag-colored/)
assert.doesNotMatch(
  cardSource,
  /getManagerConversationColorStyle\(conversation\)/,
  'Cards must not derive colors automatically from conversation identities',
)

const listSource = readSource('src/panel/components/ConversationList.tsx')
assert.match(listSource, /accountColors\[conversation\.accountId\]/)
assert.match(
  listSource,
  /environmentColorsEnabled\s*\?\s*environmentColors\[conversation\.sourceEnvironmentId\]/,
)
assert.doesNotMatch(
  listSource,
  /accountColors\[conversation\.platform\]/,
  'Account colors must not be assigned by platform',
)

const conversationsPage = readSource('src/panel/pages/ConversationsPage.tsx')
assert.match(
  conversationsPage,
  /directory\?\.visibleEnvironmentIds\.length \?\? 0\) > 0/,
  'Environment backgrounds must stay off when only the local environment is shown',
)

const settingsSource = readSource('src/panel/components/DisplayColorSettings.tsx')
assert.match(settingsSource, /16 种颜色仅用于 Manager 视觉归类/)
assert.match(settingsSource, /选择相同颜色不会合并数据/)
assert.match(settingsSource, /未指定/)

const styles = readSource('src/panel/styles.css')
assert.match(
  styles,
  /:root\[data-surface="manager"\] \.conversation-card\s*\{[\s\S]*?background: var\(--manager-environment-background/,
)
assert.match(
  styles,
  /:root\[data-surface="manager"\] \.account-color-tag-colored\s*\{[\s\S]*?background: var\(--manager-account-tag-background/,
)

console.log('manual Manager account and environment color verification passed')
