import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectCommitIdentity, inspectIndex, inspectWorktree, reportFindings } from './publication-safety.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
try {
  const stagedOnly = process.argv.includes('--staged')
  if (stagedOnly && !existsSync(join(root, '.git'))) throw new Error('Initialize the Git repository before checking staged files')
  const findings = stagedOnly ? [...inspectIndex(root), ...inspectCommitIdentity(root)] : [
    ...inspectWorktree(root),
    ...(existsSync(join(root, '.git')) ? inspectIndex(root) : []),
  ]
  if (!reportFindings(findings)) process.exitCode = 1
  else console.log(`publication safety passed: ${stagedOnly ? 'Git index' : 'public working-tree files and available Git index'}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
