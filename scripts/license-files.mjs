import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const PROJECT_LICENSE = 'GPL-3.0-only'
export const GPL_TEXT_SHA256 = 'fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0'
export const LEGAL_FILES = ['LICENSE', 'COPYRIGHT', 'THIRD_PARTY_NOTICES', 'SOURCES.md']
export const SOURCE_ARCHIVE = 'corresponding-source.zip'
export const SOURCE_MANIFEST = 'SOURCE_MANIFEST.json'
export const RUNTIME_PACKAGES = ['react', 'react-dom', 'scheduler']

const ROOT_FILES = [
  ...LEGAL_FILES, '.gitignore', '.githooks/pre-commit', 'AGENTS.md', 'ARCHITECTURE.md',
  'README.md', 'README.en.md', 'PRIVACY.md', 'package.json', 'package-lock.json',
  'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'COMMERCIAL-LICENSE.md',
  'eslint.config.js', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'vite.config.ts', 'vite.content.config.ts', 'vite.background.config.ts',
  'index.html', 'panel.html', 'manager.html', 'storage.html', 'image-reader.html',
]

export function collectSourceFiles(root) {
  function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.') || /\.local(?:$|\.)/i.test(entry.name)) return []
      const path = join(directory, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Source snapshots must not follow symbolic links')
      return entry.isDirectory() ? walk(path) : [relative(root, path).split(sep).join('/')]
    })
  }
  for (const file of ROOT_FILES) assert.ok(existsSync(join(root, file)), 'Missing source input: ' + file)
  const files = [
    ...ROOT_FILES,
    ...['src', 'scripts', 'public', ...RUNTIME_PACKAGES.map((name) => 'node_modules/' + name)]
      .flatMap((directory) => walk(join(root, directory))),
  ]
  return [...new Set(files)].sort()
}
