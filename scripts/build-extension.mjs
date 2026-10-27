import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const stage = join(root, '.dist-build')
const destination = join(root, 'dist')
const markerName = 'runtime-ready.json'
const packageData = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const buildId = `${packageData.version}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
const buildEnvironment = {
  ...process.env,
  AI_CHAT_MEMORY_BUILD_ID: buildId,
  AI_CHAT_MEMORY_OUT_DIR: stage,
  AI_CHAT_MEMORY_DIST_DIR: stage,
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: buildEnvironment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${basename(script)} exited with status ${result.status ?? 'unknown'}`)
  }
}

function collectFiles(directory) {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name)
    return statSync(absolute).isDirectory() ? collectFiles(absolute) : [absolute]
  })
}

function collectDirectories(directory) {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name)
    return statSync(absolute).isDirectory()
      ? [absolute, ...collectDirectories(absolute)]
      : []
  })
}

function copyAtomically(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.next-${buildId}`
  try {
    copyFileSync(source, temporary)
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function publishVerifiedBuild() {
  mkdirSync(destination, { recursive: true })
  const stageFiles = collectFiles(stage)
  const stageRelativeFiles = new Set(
    stageFiles.map((file) => relative(stage, file)),
  )

  // Removing only the readiness marker makes every already-running build fail
  // closed while entry files are replaced. The dist directory itself remains
  // present throughout publication.
  rmSync(join(destination, markerName), { force: true })

  for (const source of stageFiles) {
    const relativePath = relative(stage, source)
    if (relativePath !== markerName) {
      copyAtomically(source, join(destination, relativePath))
    }
  }

  for (const existing of collectFiles(destination)) {
    const relativePath = relative(destination, existing)
    if (relativePath !== markerName && !stageRelativeFiles.has(relativePath)) {
      rmSync(existing, { force: true })
    }
  }
  for (const directory of collectDirectories(destination).sort(
    (left, right) => right.length - left.length,
  )) {
    if (readdirSync(directory).length === 0) {
      rmdirSync(directory)
    }
  }

  copyAtomically(join(stage, markerName), join(destination, markerName))
}

rmSync(stage, { recursive: true, force: true })

try {
  runNode(join(root, 'scripts', 'verify-secrets.mjs'))
  runNode(join(root, 'node_modules/typescript/bin/tsc'), ['-b', '--pretty', 'false'])
  runNode(join(root, 'node_modules/vite/bin/vite.js'), ['build', '--config', 'vite.config.ts'])
  runNode(join(root, 'node_modules/vite/bin/vite.js'), ['build', '--config', 'vite.content.config.ts'])
  runNode(join(root, 'node_modules/vite/bin/vite.js'), ['build', '--config', 'vite.background.config.ts'])

  runNode(join(root, 'scripts', 'prepare-license-materials.mjs'))

  writeFileSync(join(stage, markerName), `${JSON.stringify({
    buildId,
    version: packageData.version,
    builtAt: new Date().toISOString(),
  })}\n`)

  for (const verification of [
    'verify-repository-policy.mjs',
    'verify-publication-safety.mjs',
    'verify-privacy-policy.mjs',
    'verify-license.mjs',
    'verify-dist.mjs',
    'verify-pinned-capture.mjs',
    'verify-chatgpt-current-dom.mjs',
    'verify-chatgpt-semantic-dom.mjs',
    'verify-chatgpt-complete-capture.mjs',
    'verify-complete-capture-lifecycle.mjs',
    'verify-share-capture.mjs',
    'verify-conversation-capture-modes.mjs',
    'verify-network-capture.mjs',
    'verify-network-evidence.mjs',
    'verify-gemini-capture.mjs',
    'verify-chatgpt-message-time.mjs',
    'verify-manager-colors.mjs',
    'verify-library-filters.mjs',
    'verify-conversation-export.mjs',
    'verify-live-sync.mjs',
    'verify-manual-save-reconciliation.mjs',
    'verify-capture-integrity.mjs',
    'verify-conversation-window-merge.mjs',
    'verify-floating-panel.mjs',
    'verify-exclusions.mjs',
    'verify-shared-delete.mjs',
    'verify-attachments-and-account.mjs',
    'verify-image-recapture.mjs',
    'verify-local-attachments.mjs',
    'verify-text-preview.mjs',
    'verify-message-presentation.mjs',
  ]) {
    runNode(join(root, 'scripts', verification))
  }

  publishVerifiedBuild()
  console.log(`published verified extension build ${buildId} without deleting dist/`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
