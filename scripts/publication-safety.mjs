import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const privatePath = /(?:^|\/)(?:\.ssh|\.aws|\.codex|\.agents|\.idea|node_modules|dist|dist-ssr|\.dist-build|docs?|plans?|captures|recordings|conversation-exports|browser-data|logs|test-results|playwright-report)(?:\/|$)|(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.netrc|credentials\.json|secrets\.json|IMPLEMENTATION_PLAN\.md|[^/]*_PLAN\.md|[^/]*-plan\.md)$|\.(?:pem|key|pub|p12|pfx|jks|keystore|har|sqlite3?|db(?:-wal|-shm)?|dump|pcapng?|zip|log)(?:$|\.next-)|\.local(?:$|\.)|(?:^|\/)\.env(?:$|\.)(?!example$|sample$)/i
const restrictedBrand = /hub[\s_-]*studio/i
const rules = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['ssh-public-key', /\b(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/]{40,}={0,3}/g],
  ['pgp-key', /-----BEGIN PGP (?:PRIVATE|PUBLIC) KEY BLOCK-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['provider-token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/g],
  ['personal-home-path', /(?:\/(?:Users|home)\/[^/\s<>]+\/|[A-Z]:\\Users\\[^\\\s<>]+\\)/gi],
]

function fixtureId(id) {
  return /^(?:synthetic(?:-[a-z0-9-]+)?|conversation-[a-z0-9-]+|native-fixture|other-conversation|source|different|pending|remote-1|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb)$/.test(id)
}

export function inspectText(path, text) {
  const findings = []
  const fixture = /^scripts\/verify-[^/]+\.mjs$/.test(path)
  text.split(/\r?\n/).forEach((line, index) => {
    const report = (rule) => findings.push({ path, line: index + 1, rule })
    if (restrictedBrand.test(line)) report('restricted-brand')
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0
      if (pattern.test(line)) report(rule)
    }
    for (const match of line.matchAll(/(?<![:/\w])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
      if (!/(?:^|\.)(?:example\.(?:com|org|net)|test|invalid)$/i.test(match[1])) report('personal-email')
    }
    for (const match of line.matchAll(/https:\/\/(?:chatgpt\.com\/(?:c|share)\/|gemini\.google\.com\/app\/|chat\.deepseek\.com\/a\/chat\/s\/)([A-Za-z0-9-]+)/g)) {
      if (!(fixture && fixtureId(match[1]))) report('conversation-link')
    }
    for (const match of line.matchAll(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|client[_-]?secret|secret[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi)) {
      if (!/^(?:example|fixture|synthetic|placeholder|your[-_]|\$\{)/i.test(match[1])) report('hardcoded-credential')
    }
    for (const match of line.matchAll(/https?:\/\/([^\s/"'<>]+)@/g)) {
      if (!(fixture && /^(?:user:pass|user:secret)$/.test(match[1]))) report('url-credentials')
    }
    if (/\b(?:accessToken|refreshToken|sessionToken|session_token)\b["']?\s*:\s*["'][^"']{8,}["']/.test(line)) report('session-data')
  })
  return findings
}

function git(root, args, options = {}) {
  const result = spawnSync('git', ['-C', root, '-c', 'core.excludesFile=/dev/null', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
  })
  if (result.error || result.status !== 0) throw new Error('Unable to inspect Git publication inputs')
  return result.stdout
}

export function inspectPublicationBytes(path, bytes) {
  if (privatePath.test(path)) return [{ path, rule: 'private-file' }]
  if (restrictedBrand.test(path)) return [{ path, rule: 'restricted-filename' }]
  if (bytes.includes(0)) {
    // Only the reviewed extension icons may be binary publication inputs.
    if (/^public\/icons\/icon-(?:16|32|48|128)\.png$/.test(path)) return []
    return [{ path, rule: 'unreviewed-binary' }]
  }
  const text = bytes.toString('utf8')
  const findings = inspectText(path, text)
  if (/\.json$/i.test(path)) {
    try {
      const value = JSON.parse(text)
      const records = Array.isArray(value) ? value : [value]
      if (records.some((record) => record && typeof record === 'object' &&
        ['messages', 'conversations', 'mapping', 'accessToken', 'sessionToken'].some((key) => key in record))) {
        findings.push({ path, rule: 'conversation-or-session-export' })
      }
    } catch {
      // Source configuration files may use JSON with comments.
    }
  }
  return findings
}

export function inspectIndex(root) {
  const entries = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)
  const paths = []
  const findings = []
  for (const entry of entries) {
    const [metadata, path] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)]
    const [mode, oid, stage] = metadata.split(' ')
    paths.push(path)
    if (stage !== '0' || !['100644', '100755'].includes(mode)) {
      findings.push({ path, rule: 'unreviewed-git-entry' })
      continue
    }
    // Read the staged blob, never its possibly different working-tree file.
    const bytes = git(root, ['cat-file', 'blob', oid], { encoding: null })
    findings.push(...inspectPublicationBytes(path, bytes))
  }
  if (paths.length) {
    const result = spawnSync('git', ['-C', root, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin', '-z'], {
      input: paths.join('\0') + '\0', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    if (![0, 1].includes(result.status)) throw new Error('Unable to check Git exclusions')
    for (const path of result.stdout.split('\0').filter(Boolean)) findings.push({ path, rule: 'ignored-git-entry' })
  }
  return findings
}

export function inspectCommitIdentity(root) {
  // Public identity must be chosen for this repository rather than inherited
  // silently from another account's global configuration.
  const name = spawnSync('git', ['-C', root, 'config', '--local', '--get', 'user.name'], { encoding: 'utf8' })
  const email = spawnSync('git', ['-C', root, 'config', '--local', '--get', 'user.email'], { encoding: 'utf8' })
  if (name.status !== 0 || !name.stdout.trim() || email.status !== 0 || !/^[^\s@<>]+@users\.noreply\.github\.com$/.test(email.stdout.trim())) {
    return [{ path: 'Git commit metadata', rule: 'configure-local-public-name-and-github-noreply-email' }]
  }
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = spawnSync('git', ['-C', root, 'var', variable], { encoding: 'utf8' })
    const expected = `${name.stdout.trim()} <${email.stdout.trim()}> `
    if (result.status !== 0 || !result.stdout.startsWith(expected)) {
      return [{ path: 'Git commit metadata', rule: 'identity-override-requires-review' }]
    }
  }
  return []
}

export function inspectWorktree(root) {
  let temporary
  try {
    const gitArgs = []
    if (!existsSync(join(root, '.git'))) {
      temporary = mkdtempSync(join(tmpdir(), 'ai-chat-memory-audit-'))
      git(temporary, ['init', '--quiet', '--template='])
      gitArgs.push('--git-dir=' + join(temporary, '.git'), '--work-tree=' + root)
    }
    const paths = git(root, [...gitArgs, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .split('\0').filter(Boolean)
    return [...new Set(paths)].flatMap((path) => {
      const absolute = join(root, path)
      if (!existsSync(absolute)) return [{ path, rule: 'missing-publication-input' }]
      if (!lstatSync(absolute).isFile()) return [{ path, rule: 'unreviewed-file-type' }]
      return inspectPublicationBytes(path, readFileSync(absolute))
    })
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}

export function reportFindings(findings) {
  if (!findings.length) return true
  console.error('Publication blocked. Review these locations locally; values are intentionally omitted:')
  for (const { path, line, rule } of findings) console.error(`${JSON.stringify(path)}${line ? ':' + line : ''}: ${rule}`)
  return false
}
