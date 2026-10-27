import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
if (!existsSync(join(root, '.git'))) {
  console.log('Git hooks are not active: run git init, then npm run setup:git-hooks.')
} else {
  const current = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' })
  if (current.status !== 0 && current.status !== 1) throw new Error('Unable to inspect the repository hook configuration')
  if (current.stdout.trim() && current.stdout.trim() !== '.githooks') {
    throw new Error('A different hooksPath is already configured; integrate the publication check into it before committing')
  }
  chmodSync(join(root, '.githooks/pre-commit'), 0o755)
  const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root })
  if (result.status !== 0) throw new Error('Unable to enable the repository publication hook')
  console.log('Repository pre-commit hook enabled. No global Git settings were changed.')
}
