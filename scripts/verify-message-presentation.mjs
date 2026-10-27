import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { DOMParser as TestDOMParser } from 'linkedom'

// linkedom's XML mode does not assign SVG namespaces; model the browser XML
// namespace only for this fixture parser, while retaining explicit overrides.
class DOMParser {
  parseFromString(source, type) {
    const document=new TestDOMParser().parseFromString(source,type)
    for(const node of [document.documentElement,...document.querySelectorAll('*')]) {
      Object.defineProperty(node,'namespaceURI',{value:node.getAttribute('xmlns') ?? 'http://www.w3.org/2000/svg',configurable:true})
    }
    return document
  }
}
const api={}
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/panel/message-presentation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText,{exports:api,DOMParser})
const parse=content=>api.parseMessagePresentation(content,true)
const token='image_group{"query":["Synthetic illustration"],"layout":"carousel"}'
assert.equal(parse(`Before ${token} after`)[0].value,'Before  after','Existing records hide component instructions without mutating storage')
assert.equal(api.parseMessagePresentation(token,false)[0].value,token,'User input and other platforms remain literal')
const svg='<svg viewBox="0 0 320 105" width="100%" xmlns="http://www.w3.org/2000/svg"><rect x="24" y="65" width="35" height="13" rx="3" fill="#85909A"/><path d="M42 65 Q160 99 278 65" fill="none" stroke="#449D83" stroke-width="6"/><text x="178" y="28" font-size="12" fill="currentColor">按压力</text><text x="160" y="102" text-anchor="middle" opacity=".65">示意：相对更明显的形变</text></svg>'
const result=parse(`说明\n${svg}\n结束`)
assert.equal(result.length,3)
assert.equal(result[1].type,'diagram')
assert.match(decodeURIComponent(result[1].value),/M42 65 Q160 99 278 65/,'Paths and labels survive as an inert image document')
assert.match(result[1].label,/按压力.*示意/)
for(const payload of ['<script>alert(1)</script>','<image href="https://example.test/pixel"/>','<foreignObject><div>active</div></foreignObject>','<rect onclick="alert(1)"/>','<path fill="url(https://example.test/pixel)"/>','<use href="#reference"/>','<animate attributeName="x"/>','<g style="background:url(https://example.test/pixel)"/>']) {
  const value=parse(svg.replace('<rect',`${payload}<rect`))[0]
  assert.equal(value.type,'text','Unsupported or active SVG fails to readable labels')
  assert.doesNotMatch(value.value,/alert|https:|<script|<svg/)
  assert.match(value.value,/按压力/)
}
for(const source of [svg,token]) {
  assert.equal(parse('`'+source+'`')[0].value,'`'+source+'`','Inline examples stay literal')
  for(const fence of ['```','~~~']) {
    const value=parse(`${fence}text\n${source}\n${fence}`)[0]
    assert.equal(value.type,'code')
    assert.equal(value.value,source,'Fenced examples retain their complete source')
  }
}
for (const fence of ['```', '~~~']) {
  for (const language of ['svg', 'SVG', 'xml', 'html', '']) {
    const content = `${fence}${language}\n${svg}\n${fence}`
    assert.equal(parse(content)[0].type, 'diagram', 'Standalone assistant SVG fences preview as images')
    assert.equal(api.parseMessagePresentation(content, false)[0].type, 'code', 'User fences remain code')
    assert.equal(parse(content.replace('<rect', '<script>alert(1)</script><rect'))[0].type, 'text', 'Fenced SVG uses the same resource-free validation')
  }
  assert.equal(parse(`${fence}svg\nExample: ${svg}\n${fence}`)[0].type, 'code', 'Mixed examples stay code')
}
assert.equal(api.parseMessagePresentation(svg,false)[0].value,svg)
assert.equal(parse(token).length,0)
console.log('message presentation verification passed: legacy image directives, static SVG diagrams, inert resource-free image previews and literal code/user input')
