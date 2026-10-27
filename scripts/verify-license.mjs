import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { collectSourceFiles, GPL_TEXT_SHA256, LEGAL_FILES, PROJECT_LICENSE, RUNTIME_PACKAGES, SOURCE_ARCHIVE, SOURCE_MANIFEST } from './license-files.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
assert.equal(pkg.license, PROJECT_LICENSE)
assert.equal(lock.packages[''].license, PROJECT_LICENSE)
assert.equal(digest(readFileSync(join(root, 'LICENSE'))), GPL_TEXT_SHA256, 'Preserve the complete canonical GPLv3 text')

const runtime = new Set(Object.keys(pkg.dependencies))
for (const name of runtime) {
  assert.ok(RUNTIME_PACKAGES.includes(name), 'Review new runtime dependency licensing: ' + name)
  const dependency = JSON.parse(read('node_modules/' + name + '/package.json'))
  for (const child of Object.keys(dependency.dependencies ?? {})) runtime.add(child)
}
assert.deepEqual([...runtime].sort(), [...RUNTIME_PACKAGES].sort(), 'Review changes to the bundled dependency closure')
const notices = read('THIRD_PARTY_NOTICES')
for (const name of RUNTIME_PACKAGES) {
  const dependency = JSON.parse(read('node_modules/' + name + '/package.json'))
  assert.equal(dependency.license, 'MIT', 'Review changed dependency terms: ' + name)
  assert.ok(notices.includes(name + ' ' + dependency.version), 'Update dependency notice version: ' + name)
  assert.ok(notices.includes(read('node_modules/' + name + '/LICENSE').trim()), 'Preserve dependency license text: ' + name)
}
for (const name of ['README.md', 'README.en.md', 'COPYRIGHT']) {
  assert.match(read(name), /GPL-3\.0-only/)
  assert.doesNotMatch(read(name), /商业使用须事先联系作者|Commercial use requires prior contact with the author/,
    'Remove the earlier commercial-approval restriction')
}

const { document } = parseHTML(read('public/license.html'))
assert.ok(document.querySelector('section[lang="zh-CN"]'))
assert.ok(document.querySelector('section[lang="en"]'))
assert.equal(document.querySelectorAll('script, iframe, img, form').length, 0)
const links = [...document.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')).filter((href) => !href.startsWith('#'))
assert.deepEqual([...new Set(links)].sort(), [...LEGAL_FILES, SOURCE_ARCHIVE].sort())
assert.match(read('src/panel/pages/SettingsPage.tsx'), /href=\{chrome\.runtime\.getURL\('license\.html'\)\}/)

const configuredDist = process.env.AI_CHAT_MEMORY_DIST_DIR ?? (process.argv.includes('--dist') ? 'dist' : null)
if (configuredDist) {
  const dist = isAbsolute(configuredDist) ? configuredDist : resolve(root, configuredDist)
  for (const path of [...LEGAL_FILES, 'license.html']) {
    const source = path === 'license.html' ? 'public/license.html' : path
    assert.equal(readFileSync(join(dist, path), 'utf8'), read(source), 'Stale or missing license material: ' + path)
  }
  const archive = join(dist, SOURCE_ARCHIVE)
  assert.ok(existsSync(archive), 'The distributed binary needs its source snapshot')
  function unzip(args) {
    const result = spawnSync('unzip', args, { encoding: null, maxBuffer: 32 * 1024 * 1024 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'Unable to validate distributed source')
    return result.stdout
  }
  const metadata = JSON.parse(unzip(['-p', archive, SOURCE_MANIFEST]).toString('utf8'))
  const ready = JSON.parse(readFileSync(join(dist, 'runtime-ready.json'), 'utf8'))
  assert.equal(metadata.version, pkg.version)
  assert.equal(metadata.buildId, ready.buildId, 'Source snapshot must belong to this build')
  const entries = unzip(['-Z1', archive]).toString('utf8').trim().split(/\r?\n/).filter((path) => !path.endsWith('/'))
  const files = collectSourceFiles(root)
  assert.deepEqual([...entries].sort(), [...files, SOURCE_MANIFEST].sort(),
    'Source archive must include the reviewed inputs and exclude private data')
  assert.deepEqual(metadata.files.map((entry) => entry.path).sort(), files)
  for (const entry of metadata.files) {
    assert.equal(digest(unzip(['-p', archive, entry.path])), entry.sha256, 'Corrupt source member: ' + entry.path)
    assert.equal(digest(readFileSync(join(root, entry.path))), entry.sha256, 'Source changed since the snapshot: ' + entry.path)
  }
}

console.log('license verification passed: GPLv3-only, dependency notices, offline access and matching source snapshot')
