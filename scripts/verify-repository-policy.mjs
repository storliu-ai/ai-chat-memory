import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const restrictedBrand = /hub[\s_-]*studio/i
const textFile = /\.(?:[cm]?[jt]sx?|json|html|css|svg|md|ya?ml|toml)$/i
const privatePlan = /(?:^|[._-])plans?(?:[._-]|$)/i

if (existsSync(join(root, '.git'))) {
  const tracked = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(tracked.status, 0, 'Unable to inspect Git publication inputs')
  if (tracked.stdout) {
    const ignored = spawnSync('git', ['-C', root, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin', '-z'], {
      input: tracked.stdout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })
    assert.ok(ignored.status === 0 || ignored.status === 1, 'Unable to check tracked files against ignore rules')
    assert.deepEqual(ignored.stdout.split('\0').filter(Boolean), [],
      'Ignored local files must not be tracked or staged in Git; remove them from the index while retaining local copies')
  }
}

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), `Publication input must not be a symbolic link: ${relative(root, path)}`)
    return entry.isDirectory() ? collect(path) : [path]
  })
}

const files = ['src', 'scripts', 'public'].flatMap((directory) => collect(join(root, directory)))
files.push(...readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && textFile.test(entry.name) && !privatePlan.test(entry.name))
  .map((entry) => join(root, entry.name)))

const configuredDist = process.env.AI_CHAT_MEMORY_DIST_DIR
if (configuredDist) {
  const dist = isAbsolute(configuredDist) ? configuredDist : resolve(root, configuredDist)
  files.push(...collect(dist))
}

const violations = []
for (const path of files) {
  const name = relative(root, path)
  if (restrictedBrand.test(name)) violations.push(`${name}: restricted filename`)
  if (!textFile.test(path)) continue
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (restrictedBrand.test(line)) violations.push(`${name}:${index + 1}: restricted environment branding`)
  })
}
assert.deepEqual(violations, [], 'Source, comments, public documentation and build output must use generic environment names')

for (const name of ['README.md', 'README.en.md']) {
  const readme = readFileSync(join(root, name), 'utf8')
  assert.doesNotMatch(readme, /\]\((?:\.\/)?(?:docs?\/|plans?\/|IMPLEMENTATION_PLAN\.md)/i,
    'Public READMEs must not link to ignored internal documents')
}

console.log('repository publication verification passed: Git exclusions, generic environment names and public documentation links')
