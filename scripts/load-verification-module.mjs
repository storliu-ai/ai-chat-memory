import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Load real local TypeScript modules with one shared browser test environment. */
export function verificationModule(path, globals = {}, overrides = {}) {
  const cache = new Map()
  function load(file) {
    assert.ok(file.startsWith(resolve(root, 'src') + '/'))
    if (cache.has(file)) return cache.get(file)
    const exports = {}
    cache.set(file, exports)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
    runInNewContext(code, { exports, URL, TextEncoder, TextDecoder, atob, crypto: webcrypto, setTimeout, clearTimeout, ...globals, require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      assert.ok(name.startsWith('.'), `Unexpected external dependency ${name}`)
      return load(resolve(dirname(file), name + '.ts'))
    } }, { filename: file })
    return exports
  }
  return load(resolve(root, path))
}
