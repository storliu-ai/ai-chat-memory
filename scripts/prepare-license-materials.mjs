import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectSourceFiles, LEGAL_FILES, SOURCE_ARCHIVE, SOURCE_MANIFEST } from './license-files.mjs'
import { inspectPublicationBytes, reportFindings } from './publication-safety.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const configuredDist = process.env.AI_CHAT_MEMORY_DIST_DIR
if (!configuredDist) throw new Error('License preparation requires the build staging directory')
const dist = isAbsolute(configuredDist) ? configuredDist : resolve(root, configuredDist)
const snapshot = mkdtempSync(join(tmpdir(), 'ai-chat-memory-source-'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + ' failed while preparing source materials')
}

try {
  const sourceFiles = collectSourceFiles(root)
  const findings = sourceFiles.filter((path) => !path.startsWith('node_modules/'))
    .flatMap((path) => inspectPublicationBytes(path, readFileSync(join(root, path))))
  if (!reportFindings(findings)) throw new Error('Unsafe source snapshot inputs; no archive was created')
  const files = sourceFiles.map((path) => {
    const destination = join(snapshot, path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(root, path), destination)
    return { path, sha256: createHash('sha256').update(readFileSync(destination)).digest('hex') }
  })
  writeFileSync(join(snapshot, SOURCE_MANIFEST), JSON.stringify({
    version: pkg.version, buildId: process.env.AI_CHAT_MEMORY_BUILD_ID, files,
  }, null, 2) + '\n')
  for (const path of LEGAL_FILES) copyFileSync(join(root, path), join(dist, path))
  const archive = join(dist, SOURCE_ARCHIVE)
  run('zip', ['-qr', archive, '.'], snapshot)
  run('unzip', ['-tq', archive], root)
  console.log('prepared GPL license materials and source snapshot: ' + files.length + ' files')
} finally {
  rmSync(snapshot, { recursive: true, force: true })
}
