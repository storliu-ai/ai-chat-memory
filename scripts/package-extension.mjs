import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = join(root, 'dist')
const packageData = readJson(join(root, 'package.json'), 'package.json')
const version = packageData.version
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/
const archivePattern = /^ai-chat-memory-(\d+)\.(\d+)\.(\d+)\.zip$/

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read valid ${label}: ${error.message}`)
  }
}

function parseVersion(value, label) {
  const match = versionPattern.exec(value)
  if (match === null) {
    throw new Error(`${label} must use an x.y.z version; received ${String(value)}`)
  }
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return 0
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
}

function listVersionedArchives() {
  return readdirSync(root).flatMap((name) => {
    const match = archivePattern.exec(name)
    return match === null
      ? []
      : [{ name, version: match.slice(1).map(Number) }]
  })
}

if (typeof version !== 'string') {
  throw new Error('package.json version must be a string')
}

const currentVersion = parseVersion(version, 'package.json')
const archiveName = `ai-chat-memory-${version}.zip`
const finalArchive = join(root, archiveName)
const stagedArchive = `${finalArchive}.next-${process.pid}`

if (!existsSync(dist)) {
  throw new Error('dist/ does not exist; run npm run build first')
}

const manifest = readJson(join(dist, 'manifest.json'), 'dist/manifest.json')
const runtimeReady = readJson(
  join(dist, 'runtime-ready.json'),
  'dist/runtime-ready.json',
)

if (manifest.version !== version || runtimeReady.version !== version) {
  throw new Error(
    `Refusing to package mismatched versions: package=${version}, manifest=${String(manifest.version)}, runtime=${String(runtimeReady.version)}`,
  )
}
if (
  typeof runtimeReady.buildId !== 'string'
  || !runtimeReady.buildId.startsWith(`${version}-`)
) {
  throw new Error('dist/runtime-ready.json does not identify this verified build')
}

const newerArchive = listVersionedArchives().find(
  (archive) => compareVersions(archive.version, currentVersion) > 0,
)
if (newerArchive !== undefined) {
  throw new Error(
    `Refusing to replace newer package ${newerArchive.name} with version ${version}`,
  )
}

run(process.execPath, [join(root, 'scripts', 'verify-license.mjs'), '--dist'], root)

const temporaryDirectory = mkdtempSync(
  join(tmpdir(), 'ai-chat-memory-package-'),
)
const temporaryArchive = join(temporaryDirectory, archiveName)

try {
  run(
    'zip',
    ['-qr', temporaryArchive, '.', '-x', '*.DS_Store', '__MACOSX/*'],
    dist,
  )
  run('unzip', ['-tq', temporaryArchive], root)

  copyFileSync(temporaryArchive, stagedArchive)
  renameSync(stagedArchive, finalArchive)

  for (const archive of listVersionedArchives()) {
    if (archive.name !== archiveName) {
      rmSync(join(root, archive.name))
      console.log(`removed superseded package ${archive.name}`)
    }
  }

  console.log(`created and verified ${basename(finalArchive)}`)
} finally {
  rmSync(stagedArchive, { force: true })
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
