import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectCommitIdentity, inspectIndex, inspectPublicationBytes, inspectText, inspectWorktree, reportFindings } from './publication-safety.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'ai-chat-memory-publication-test-'))
const token = ['gh', 'p_', 'A'.repeat(36)].join('')
const privateHeader = ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'].join('')
const publicKey = ['ssh-', 'ed25519 ', 'A'.repeat(60)].join('')
const personalEmail = ['private-reader', '@', 'mail', '.com'].join('')
const brand = ['hub', 'studio'].join('')

function git(args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'Synthetic Git fixture operation failed')
  return result.stdout
}
function write(path, content) {
  writeFileSync(join(directory, path), content)
}
function has(findings, rule) {
  assert.ok(findings.some((finding) => finding.rule === rule), 'Missing publication guard: ' + rule)
}

try {
  for (const [value, rule] of [[token, 'github-token'], [privateHeader, 'private-key'], [publicKey, 'ssh-public-key'], [personalEmail, 'personal-email'], [brand, 'restricted-brand']]) {
    has(inspectText('src/example.ts', value), rule)
  }
  const nativeUrl = 'https://chatgpt.com/share/' + ['12345678', '1234', '4123', '8123', '123456789012'].join('-')
  has(inspectText('scripts/verify-example.mjs', nativeUrl), 'conversation-link')
  assert.deepEqual(inspectText('scripts/verify-example.mjs', 'https://chatgpt.com/c/conversation-fixture reader@example.com'), [])
  has(inspectText('README.md', 'https://chatgpt.com/c/conversation-fixture'), 'conversation-link')
  has(inspectPublicationBytes('src/ignored.key', Buffer.from('Synthetic file')), 'private-file')
  has(inspectPublicationBytes('src/untracked.ts', Buffer.from(token)), 'github-token')

  // The scanner also works before git init, without publishing a local repository.
  write('.gitignore', '*.key\n')
  write('example.ts', token)
  has(inspectWorktree(directory), 'github-token')
  write('example.ts', '// Synthetic source\n')
  assert.deepEqual(inspectWorktree(directory), [])

  git(['init', '--quiet', '--template='])
  has(inspectCommitIdentity(directory), 'configure-local-public-name-and-github-noreply-email')
  git(['config', '--local', 'user.name', 'Synthetic Reviewer'])
  git(['config', '--local', 'user.email', ['12345+synthetic-reviewer', '@', 'users.noreply.github.com'].join('')])
  assert.deepEqual(inspectCommitIdentity(directory), [])
  git(['add', '.gitignore', 'example.ts'])
  assert.deepEqual(inspectIndex(directory), [])
  write('example.ts', token)
  git(['add', 'example.ts'])
  write('example.ts', '// Worktree cleaned after staging\n')
  const staged = inspectIndex(directory)
  has(staged, 'github-token')
  assert.ok(!JSON.stringify(staged).includes(token), 'Findings must not retain secret values')
  let output = ''
  const previousError = console.error
  try {
    console.error = (value) => { output += value }
    assert.equal(reportFindings(staged), false)
  } finally {
    console.error = previousError
  }
  assert.ok(!output.includes(token), 'Logs must not disclose secrets')

  mkdirSync(join(directory, 'scripts'))
  mkdirSync(join(directory, '.githooks'))
  for (const path of ['scripts/publication-safety.mjs', 'scripts/verify-secrets.mjs', 'scripts/setup-git-hooks.mjs', '.githooks/pre-commit']) {
    copyFileSync(join(root, path), join(directory, path))
  }
  const install = spawnSync(process.execPath, ['scripts/setup-git-hooks.mjs'], { cwd: directory, encoding: 'utf8' })
  assert.equal(install.status, 0)
  assert.equal(git(['config', '--local', '--get', 'core.hooksPath']).trim(), '.githooks')
  const commit = spawnSync('git', ['-C', directory, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic guard verification'], { encoding: 'utf8' })
  assert.notEqual(commit.status, 0, 'The installed hook must block a contaminated index')
  assert.match(commit.stderr, /github-token/)
  assert.ok(!commit.stderr.includes(token))
  assert.equal(git(['rev-list', '--all']).trim(), '', 'The rejected commit must not create history')

  git(['add', 'example.ts'])
  write('private.key', 'Synthetic file')
  git(['add', '-f', 'private.key'])
  has(inspectIndex(directory), 'private-file')
  has(inspectIndex(directory), 'ignored-git-entry')
  git(['rm', '--cached', 'private.key'])
  write('export.json', JSON.stringify({ messages: [{ content: 'Synthetic private export' }] }))
  git(['add', 'export.json'])
  has(inspectIndex(directory), 'conversation-or-session-export')
  git(['rm', '--cached', 'export.json'])
  git(['add', 'scripts', '.githooks'])
  assert.deepEqual(inspectIndex(directory), [])
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic clean source verification'])
  assert.ok(readFileSync(join(directory, 'private.key'), 'utf8'), 'Local ignored evidence must be preserved')
  console.log('publication guard verification passed: staged blobs, force-added keys, exports, hook rejection and redacted output')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
