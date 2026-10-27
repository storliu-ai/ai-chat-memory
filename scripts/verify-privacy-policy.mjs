import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (name) => readFileSync(join(root, name), 'utf8')
const html = read('public/privacy.html')
const { document } = parseHTML(html)
const normalize = (value) => value.replace(/\s+/g, '')
const markdownText = read('PRIVACY.md')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

assert.equal(normalize(document.querySelector('[data-policy-content]')?.textContent ?? ''), normalize(markdownText),
  'The packaged policy and public Markdown must disclose the same information')
assert.ok(document.querySelector('section[lang="zh-CN"]'), 'Chinese privacy policy is required')
assert.ok(document.querySelector('section[lang="en"]'), 'English privacy policy is required')
assert.equal(document.querySelectorAll('script, iframe, form, img, link[rel="stylesheet"]').length, 0,
  'The offline privacy policy must not execute scripts or load external resources')

for (const name of ['README.md', 'README.en.md']) {
  assert.match(read(name), /\]\(PRIVACY\.md\)/, 'Both language guides must link to the privacy policy')
}
assert.match(read('README.md'), /\]\(README\.en\.md\)/)
assert.match(read('README.en.md'), /\]\(README\.md\)/)
assert.match(read('src/panel/pages/SettingsPage.tsx'), /href=\{chrome\.runtime\.getURL\('privacy\.html'\)\}/,
  'Settings must offer the bundled policy without opening a remote website')

const configuredDist = process.env.AI_CHAT_MEMORY_DIST_DIR
if (configuredDist) {
  const dist = isAbsolute(configuredDist) ? configuredDist : resolve(root, configuredDist)
  assert.equal(readFileSync(join(dist, 'privacy.html'), 'utf8'), html,
    'Distribution must include the complete offline policy')
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  assert.ok(!(manifest.web_accessible_resources ?? []).some((entry) =>
    entry.resources.some((resource) => resource === 'privacy.html' || resource === '*' || resource === '*.html')),
  'Host websites must not gain access to the extension policy page')
}

console.log('privacy policy verification passed: bilingual text parity, language navigation, local Settings access and offline distribution')
