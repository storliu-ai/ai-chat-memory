import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, dependencies = {}, globals = {}, append = '') {
  const code = ts.transpileModule(source(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  runInNewContext(code + append, { exports, atob, TextDecoder, ...globals, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`)
    return dependencies[name]
  } }, { filename: path })
  return exports
}
const models = load('src/shared/models.ts')
const attachments = load('src/shared/attachments.ts', { './models': models })
const preview = load('src/panel/text-attachment-preview.ts', { '../shared/attachments': attachments })
const textAttachment = (name, bytes, mimeType = 'application/octet-stream') => ({ id: 'a'.repeat(64), kind: 'file', name, mimeType, size: bytes.length, status: 'saved', dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` })
const originalText = '# Markdown title\r\n\r\n  保留中文、缩进和换行\n\tTabs\n```js\nconst value = 42;\n```\n<script>window.injected = true</script>\n![remote](https://example.test/image.png)\n'
const fixture = textAttachment('fixture.MD', Buffer.from(originalText))
const before = JSON.stringify(fixture)
assert.equal(preview.getTextAttachmentFormat(fixture), 'markdown')
assert.equal(preview.getTextAttachmentFormat({ ...fixture, name: 'fixture.markdown' }), 'markdown')
assert.equal(preview.getTextAttachmentFormat({ ...fixture, name: 'fixture.TXT' }), 'text')
assert.equal(preview.canPreviewTextAttachment(fixture), true)
assert.equal(preview.decodeTextAttachment(preview.readTextAttachmentBytes(fixture), 'auto'), originalText)
assert.equal(JSON.stringify(fixture), before, 'Preview never mutates saved file bytes or metadata')
for (const name of ['fixture.doc', 'fixture.docx', 'fixture.xlsx', 'fixture.pdf', 'fixture.md.docx', 'fixture.bin']) assert.equal(preview.canPreviewTextAttachment({ ...fixture, name }), false)
for (const status of ['unavailable', 'confirmation-required', 'not-saved', 'too-large']) assert.equal(preview.canPreviewTextAttachment({ ...fixture, status }), false)
assert.equal(preview.canPreviewTextAttachment({ ...fixture, dataUrl: undefined }), false)
assert.equal(preview.canPreviewTextAttachment({ ...fixture, kind: 'image' }), false)
for (const bad of [{ ...fixture, status: 'unavailable' }, { ...fixture, size: fixture.size + 1 }, { ...fixture, mimeType: 'text/plain' }, { ...fixture, dataUrl: 'https://example.test/remote-file' }, { ...fixture, dataUrl: 'data:text/plain;base64,invalid!' }]) assert.throws(() => preview.readTextAttachmentBytes(bad))
const utf8Bom = textAttachment('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文')]))
assert.equal(preview.decodeTextAttachment(preview.readTextAttachmentBytes(utf8Bom), 'auto'), '中文')
const utf16LE = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\nUTF-16', 'utf16le')])
assert.equal(preview.decodeTextAttachment(preview.readTextAttachmentBytes(textAttachment('le.txt', utf16LE)), 'auto'), '中文\nUTF-16')
const utf16BE = Buffer.from(utf16LE); utf16BE.swap16()
assert.equal(preview.decodeTextAttachment(preview.readTextAttachmentBytes(textAttachment('be.txt', utf16BE)), 'auto'), '中文\nUTF-16')
const gbk = preview.readTextAttachmentBytes(textAttachment('legacy.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])))
assert.equal(preview.decodeTextAttachment(gbk, 'gb18030'), '中文')
const hugeText = 'x'.repeat(preview.MAX_TEXT_PREVIEW_CHARACTERS - 1) + '😀' + '\nTail kept for copy/download'
const truncated = preview.truncateTextPreview(hugeText)
assert.equal(truncated.truncated, true)
assert.equal(truncated.text.length, preview.MAX_TEXT_PREVIEW_CHARACTERS - 1, 'Do not split a surrogate pair at the preview boundary')
assert.equal(preview.truncateTextPreview(originalText).text, originalText)

const dialogDependencies = { '../text-attachment-preview': preview }
const actual = load('src/panel/components/TextAttachmentPreviewDialog.tsx', { ...dialogDependencies, react: React, 'react/jsx-runtime': jsxRuntime })
const markup = renderToStaticMarkup(React.createElement(actual.TextAttachmentPreviewDialog, { attachment: fixture, onClose() {}, onDownload() {} }))
assert.match(markup, /Markdown 源码/)
assert.match(markup, /&lt;script&gt;window.injected = true&lt;\/script&gt;/)
assert.doesNotMatch(markup, /<script|<img|<iframe|<h1/)
assert.match(markup, /自动换行/)
assert.match(markup, /GB18030 \/ GBK/)

// Exercise the actual dialog controls with deterministic hook and DOM substitutes.
function dialogHarness(attachment, clipboardFailure = false) {
  const slots = [], effects = [], cleanups = []
  let index = 0, dirty = true, tree, keydown, closes = 0, downloads = 0, restored = 0
  const copied = []
  const previousFocus = { isConnected: true, focus: () => { restored++ } }
  const document = { activeElement: previousFocus, addEventListener: (_name, handler) => { keydown = handler }, removeEventListener: () => { keydown = null } }
  const controls = [0, 1, 2].map(() => ({ focus() { document.activeElement = this } }))
  const dialog = { querySelectorAll: () => controls, contains: node => controls.includes(node) }
  let refNumber = 0
  const hooks = {
    useState(initial) { const at = index++; if (!(at in slots)) slots[at] = initial; return [slots[at], value => { slots[at] = value; dirty = true }] },
    useId: () => `fixture-${index++}`,
    useRef() { const at = index++; return slots[at] ??= { current: refNumber++ === 0 ? dialog : controls[0] } },
    useMemo(callback) { return callback() },
    useEffect(callback, deps) { const at = index++; if (!slots[at] || deps.some((value, i) => value !== slots[at][i])) { slots[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = callback() }) } },
  }
  const jsx = (type, props) => ({ type, props })
  const component = load('src/panel/components/TextAttachmentPreviewDialog.tsx', { ...dialogDependencies, react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx } }, {
    document, HTMLElement: { [Symbol.hasInstance]: node => node === previousFocus },
    navigator: { clipboard: { writeText: async text => { if (clipboardFailure) throw new Error('clipboard unavailable'); copied.push(text) } } },
  })
  const onClose = () => { closes++ }, onDownload = () => { downloads++ }
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object' ? [] : [node, ...nodes(node.props?.children)]
  const render = () => { index = 0; dirty = false; tree = component.TextAttachmentPreviewDialog({ attachment, onClose, onDownload }); for (const effect of effects.splice(0)) effect() }
  const flush = async () => { for (let round = 0; round < 10; round++) { if (dirty) render(); await Promise.resolve() } }
  return { flush, copied, nodes: () => nodes(tree), click: label => nodes(tree).find(node => node.type === 'button' && node.props.children === label).props.onClick(),
    setEncoding: value => nodes(tree).find(node => node.type === 'select').props.onChange({ target: { value } }),
    setWrap: checked => nodes(tree).find(node => node.type === 'input').props.onChange({ target: { checked } }),
    key: (key, shiftKey = false) => { let prevented = false; keydown({ key, shiftKey, preventDefault() { prevented = true } }); return prevented },
    controls, document, get closes() { return closes }, get downloads() { return downloads }, get restored() { return restored },
    cleanup: () => cleanups.forEach(callback => callback?.()) }
}
const dialog = dialogHarness(textAttachment('big.txt', Buffer.from(hugeText)))
await dialog.flush()
assert.equal(dialog.document.activeElement, dialog.controls[0])
assert.equal(dialog.nodes().find(node => node.type === 'pre').props.children, truncated.text)
await dialog.click('复制全文'); await dialog.flush()
assert.equal(dialog.copied[0], hugeText, 'Copy uses the entire file, including text beyond the preview limit')
assert.ok(dialog.nodes().some(node => node.props?.role === 'status' && node.props.children === '已复制全文'))
dialog.click('下载原文件'); assert.equal(dialog.downloads, 1)
dialog.setWrap(false); await dialog.flush()
assert.equal(dialog.nodes().find(node => node.type === 'pre').props.className, 'text-preview-content')
dialog.document.activeElement = dialog.controls.at(-1)
assert.equal(dialog.key('Tab'), true)
assert.equal(dialog.document.activeElement, dialog.controls[0])
assert.equal(dialog.key('Tab', true), true)
assert.equal(dialog.document.activeElement, dialog.controls.at(-1))
dialog.document.activeElement = dialog.controls[1]
assert.equal(dialog.key('Tab'), false, 'Middle controls remain reachable through normal keyboard navigation')
assert.equal(dialog.key('Escape'), true); assert.equal(dialog.closes, 1)
dialog.cleanup(); assert.equal(dialog.restored, 1)
const legacy = dialogHarness(textAttachment('legacy.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])))
await legacy.flush(); legacy.setEncoding('gb18030'); await legacy.flush()
assert.equal(legacy.nodes().find(node => node.type === 'pre').props.children, '中文')
const clipboardError = dialogHarness(fixture, true)
await clipboardError.flush(); clipboardError.click('复制全文'); await clipboardError.flush()
assert.ok(clipboardError.nodes().some(node => node.props?.role === 'status' && /复制失败/.test(node.props.children)))
const corrupt = dialogHarness({ ...fixture, size: 1 })
await corrupt.flush()
assert.ok(corrupt.nodes().some(node => node.props?.role === 'alert'))
assert.equal(corrupt.nodes().find(node => node.type === 'button' && node.props.children === '复制全文').props.disabled, true)

const jsx = (type, props) => ({ type, props })
let chosen
const page = load('src/panel/pages/ConversationDetailPage.tsx', {
  react: { useRef: () => ({ current: null }) }, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../shared/models': models,
  '../../shared/extension-events': {}, '../../shared/attachments': attachments, '../text-attachment-preview': preview,
  '../components/ConfirmDialog': {}, '../components/ConversationExportDialog': {}, '../components/ImagePreviewDialog': {}, '../components/TextAttachmentPreviewDialog': {}, '../components/MessageContent': {},
  '../services/panel-api': {}, '../attachment-placement': {}, '../local-attachment-file': {},
}, {}, '\nexports.testCard = StoredAttachmentCard;')
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object' ? [] : [node, ...nodes(node.props?.children)]
const props = { attachment: fixture, settings: models.DEFAULT_SETTINGS, saveImages: true, onPreview: attachment => { chosen = attachment } }
nodes(page.testCard(props)).find(node => node.props?.['aria-label'] === '预览 fixture.MD').props.onClick()
assert.equal(chosen, fixture)
assert.ok(nodes(page.testCard(props)).some(node => node.type === 'button' && node.props.children === '下载'))
for (const attachment of [{ ...fixture, name: 'file.docx' }, { ...fixture, name: 'file.xlsx' }, { ...fixture, status: 'unavailable', dataUrl: undefined }]) assert.equal(nodes(page.testCard({ ...props, attachment })).some(node => node.props?.children === '预览'), false)
assert.doesNotMatch(source('src/panel/text-attachment-preview.ts') + source('src/panel/components/TextAttachmentPreviewDialog.tsx'), /\bfetch\s*\(|dangerouslySetInnerHTML|<iframe/)
console.log('text attachment preview verification passed: offline TXT/MD source, encodings, exact whitespace, literal markup, bounded preview/full copy and keyboard controls')
