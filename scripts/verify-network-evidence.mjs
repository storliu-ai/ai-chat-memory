import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { posix } from 'node:path'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../src/adapters/chatgpt/network-evidence.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
const api = {}
runInNewContext(code, { exports: api, URL })
const target = { mode: 'conversation', id: 'synthetic' }
const message = (id, role = 'assistant', text = `Synthetic ${id} visible content`) => ({ id, author: { role }, recipient: 'all', channel: role === 'assistant' ? 'final' : null, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', metadata: {}, end_turn: false, create_time: 123456, update_time: 123457 })
const [u1, a1, u2, a2] = [message('u1', 'user'), message('a1'), message('u2', 'user'), message('a2')]
const page = (nodes, previous, next, extra = {}) => JSON.stringify({ messages: nodes, page_info: { start_cursor: nodes[0].id, end_cursor: nodes.at(-1).id, has_previous_page: previous, has_next_page: next }, ...extra })
const visible = nodes => nodes.map(node => ({ role: node.author.role, content: node.content.parts.filter(part => typeof part === 'string').join('\n'), sourceMessageId: node.id }))
const evidence = () => new api.ChatGPTNetworkEvidence(target)
let task = evidence()
task.add(page([u2, a2], true, false, { conversation_id: 'synthetic', current_node: 'a2' }), 'initial')
assert.equal(task.complete, false)
assert.throws(() => task.verify(visible([u2, a2])), /缺少/)
task.add(page([u1, a1], false, true), 'messages', { before: 'u2' })
assert.equal(task.complete, true)
assert.deepEqual(Array.from(task.verify(visible([u1, a1, u2, a2])), entry => entry.sourceMessageId), ['u1', 'a1', 'u2', 'a2'])
assert.equal(task.verify(visible([u1, a1]))[1].content, a1.content.parts[0], 'Non-end-turn final fragments are retained')
assert.ok(task.verify(visible([u1, a1])).every(entry => entry.sentAt === undefined), 'Private payload times never become message times')
task.add(page([u1, a1], false, true), 'messages', { before: 'u2' })
assert.equal(task.verify(visible([u1, a1])).length, 4, 'Exact retries are idempotent')
assert.throws(() => task.add(page([u1, { ...a1, content: { content_type: 'text', parts: ['changed'] } }], false, true), 'messages', { before: 'u2' }), /发生变化/)
task = evidence()
task.add(page([u1, a1], false, true), 'messages', { before: 'wrong' })
task.add(page([u2, a2], true, false, { current_node: 'a2' }), 'initial')
assert.equal(task.complete, false, 'A wrong request cursor cannot bridge missing history')
task = evidence()
task.add(page([u1, a1, u2], false, true), 'messages', { before: 'u2' })
task.add(page([u2, a2], true, false, { current_node: 'a2' }), 'initial')
assert.equal(task.verify(visible([u1, a1, u2, a2])).length, 4, 'Overlaps are joined by native IDs, never completion order')
assert.throws(() => task.verify([{ ...visible([u1])[0], content: 'Unrelated visible input with conflicting content' }]), /不一致/)
assert.throws(() => task.add(page([u2, a2], true, false, { current_node: 'different-branch' }), 'initial'), /分支已变化/)
assert.throws(() => evidence().add(page([u1], false, false, { conversation_id: 'another', current_node: 'u1' }), 'initial'), /不属于/)
assert.throws(() => evidence().add(page([{ ...u1, content: { content_type: 'audio', parts: [] } }], false, false, { current_node: 'u1' }), 'initial'), /暂不支持/)
assert.throws(() => evidence().add(page([u1, { ...a1, status: 'in_progress' }], false, false, { current_node: 'a1' }), 'initial'), /尚未完成/)
assert.throws(() => evidence().add(page([u1, a1], false, false, { page_info: { start_cursor: 'bad', end_cursor: 'a1', has_previous_page: false, has_next_page: false }, current_node: 'a1' }), 'initial'), /边界/)

const tree = (nodes, current = nodes.at(-1).id) => {
  const mapping = { root: { id: 'root', children: [nodes[0].id] } }
  nodes.forEach((node, index) => { mapping[node.id] = { id: node.id, parent: index ? nodes[index - 1].id : 'root', children: index + 1 < nodes.length ? [nodes[index + 1].id] : [], message: node } })
  return { mapping, current_node: current }
}
const shareTask = value => { const instance = new api.ChatGPTNetworkEvidence({ mode: 'share', id: 'synthetic-share' }); instance.add(JSON.stringify(value), 'share'); return instance }
const hidden = { ...message('hidden'), metadata: { is_visually_hidden_from_conversation: true } }
const thought = { ...message('thought'), content: { content_type: 'thoughts' }, channel: null }
const tool = { ...message('tool'), author: { role: 'tool' }, status: 'in_progress' }
const branched = tree([u1, hidden, thought, tool, a1])
branched.mapping.root.children.push('alternative')
branched.mapping.alternative = { id: 'alternative', parent: 'root', children: [], message: { ...message('alternative'), status: 'in_progress' } }
task = shareTask(branched)
assert.deepEqual(Array.from(task.verify(visible([u1, a1])), entry => entry.sourceMessageId), ['u1', 'a1'], 'Only the selected branch is parsed; hidden, thoughts and tools are omitted')
assert.throws(() => shareTask({ ...branched, current_node: 'missing' }), /缺少当前/)
const cyclic = tree([u1, a1]); cyclic.mapping.root.parent = 'a1'; cyclic.mapping.a1.children.push('root')
assert.throws(() => shareTask(cyclic), /循环/)
const missing = tree([u1, a1]); delete missing.mapping.u1
assert.throws(() => shareTask(missing), /父子/)
const unknownOtherBranch = tree([u1, a1]); unknownOtherBranch.mapping.root.children.push('other'); unknownOtherBranch.mapping.other = { id: 'other', parent: 'root', children: [], message: { ...message('other'), content: { content_type: 'unknown' } } }
assert.equal(shareTask(unknownOtherBranch).verify(visible([u1, a1])).length, 2)

const image = { ...u1, content: { content_type: 'multimodal_text', parts: ['Synthetic visible upload', { content_type: 'image_asset_pointer', asset_pointer: 'not-a-rendered-url' }] } }
task = shareTask(tree([image, a1]))
assert.throws(() => task.verify(visible([image, a1])), /附件消息/)
const imageDOM = visible([image, a1]); imageDOM[0].attachmentNames = ['synthetic.png']
assert.equal(task.verify(imageDOM)[0].attachmentNames[0], 'synthetic.png')
assert.doesNotMatch(JSON.stringify(task.verify(imageDOM)), /asset_pointer|not-a-rendered-url|create_time|update_time/)
const long = message('long', 'user', 'First visible section. ' + 'Additional original input. '.repeat(200) + ' Last visible section.')
task = shareTask(tree([long, a1]))
const folded = [{ ...visible([long])[0], content: 'First visible section. … Last visible section.' }, ...visible([a1])]
assert.equal(task.verify(folded)[0].content, long.content.parts[0], 'A verified native ID retains full input rather than a folded DOM excerpt')
const fragment = message('a-fragment', 'assistant', 'A second visible answer fragment')
const entities = message('entities', 'assistant', 'Example entity["product", "Example Pointer X2", "device"] costs less. citesynthetic-source')
task = shareTask(tree([u1, entities]))
const renderedEntities = visible([u1, entities]); renderedEntities[1].content = 'Example Example Pointer X2 costs less.'
assert.equal(task.verify(renderedEntities).length, 2, 'Native entity labels are displayed text; citation references are presentation')
const jsxEntity = message('jsx-entity', 'assistant', 'Choose <Entity value="Example Pointer" category="product"/>. <Cite refs={["synthetic-ref"]}/>\n\n```jsx\n<Entity value="literal code"/>\n```')
task = shareTask(tree([u1, jsxEntity]))
const jsxDOM = visible([u1, jsxEntity]); jsxDOM[1].content = 'Choose Example Pointer.\n\n```jsx\n<Entity value="literal code"/>\n```'
assert.equal(task.verify(jsxDOM)[1].content, jsxDOM[1].content.replace('Pointer.\n', 'Pointer. \n'), 'JSX native labels become readable Markdown; code examples remain literal')
const unusualClose = message('unusual-close','assistant','Choose <Entity category="product" value="Example Pointer"/ > with confidence.')
task=shareTask(tree([u1,unusualClose]))
assert.equal(task.verify([{...visible([unusualClose])[0],content:'Choose Example Pointer with confidence.'}])[1].content,'Choose Example Pointer with confidence.')
const dil = {...message('dil','assistant','<box><text>Native layout source</text></box>'),metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:'**Synthetic displayed text**',code:'Never persist internal-code',constants:{private:'Never persist internal-constant'},appData:{private:'Never persist app-data'}}}}
task=shareTask(tree([u1,dil]))
assert.equal(task.verify([{...visible([dil])[0],content:'Synthetic displayed text'}])[1].content,'**Synthetic displayed text**')
assert.doesNotMatch(JSON.stringify(task.verify([{...visible([dil])[0],content:'Synthetic displayed text'}])),/Never persist|Native layout source/)
assert.throws(()=>shareTask(tree([u1,{...dil,metadata:{model_dil_v2:{fallbackMarkdownVersion:2,fallbackMarkdown:'Unknown version'}}}])),/版本无法识别/)
const visualWidget={...dil,content:{content_type:'text',parts:['<AsyncImage query="Synthetic illustration"/>']}}
task=shareTask(tree([u1,visualWidget]))
assert.equal(task.needsAttachmentScan,true,'Image widgets request a rendered candidate sweep without treating their query as a file URL')
assert.equal(task.verify([{...visible([dil])[0],content:'Synthetic displayed text'}]).length,2,'A widget without a declared binary attachment does not invent a mandatory attachment')
const imageInstruction='image_group{"query":["Synthetic keyboard"],"aspect_ratio":"1:1","layout":"carousel","num_per_query":1}'
const imageAnswer=message('image-answer','assistant',`Before image.\n\n${imageInstruction}\n\nAfter image.`)
for (const mode of ['conversation', 'share']) {
  task=new api.ChatGPTNetworkEvidence({mode,id:'synthetic'})
  if(mode==='share') task.add(JSON.stringify(tree([u1,imageAnswer])),'share')
  else task.add(page([u1,imageAnswer],false,false,{conversation_id:'synthetic',current_node:imageAnswer.id}),'initial')
  assert.equal(task.needsAttachmentScan,true,'Image instructions still require the rendered attachment sweep')
  const saved=task.verify([{...visible([imageAnswer])[0],content:'Before image.\n\nAfter image.'}])[1]
  assert.equal(saved.content,'Before image.\n\n\n\nAfter image.','Image query/layout metadata is never saved as answer text')
}
const literalImage=message('literal-image','user',imageInstruction)
assert.equal(shareTask(tree([literalImage,a1])).verify(visible([literalImage,a1]))[0].content,imageInstruction,'User literals remain intact')
for (const wrapper of [value=>`\`${value}\``,value=>`\`\`\`text\n${value}\n\`\`\``,value=>`~~~text\n${value}\n~~~`]) {
  const codeImage=message('code-image','assistant',wrapper(imageInstruction))
  assert.equal(shareTask(tree([u1,codeImage])).verify(visible([codeImage]))[1].content,codeImage.content.parts[0],'Code examples keep their exact source')
}
const fallbackImage={...imageAnswer,metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:imageAnswer.content.parts[0]}}}
assert.doesNotMatch(shareTask(tree([u1,fallbackImage])).verify([{...visible([imageAnswer])[0],content:'Before image.\n\nAfter image.'}])[1].content,/image_group|Synthetic keyboard/,'DIL fallback follows the same image cleanup')
const graph={charts_widget_v2:{content:{chartType:'line',title:'Synthetic price history',subtitle:'Recorded examples',xKey:'month',series:[{dataKey:'price',label:'Price',valuePrefix:'¥'}],data:[{month:'A',price:100},{month:'B',price:90}]}}}
const graphMessage=message('graph','assistant',`Before chart.\n\ngenui${JSON.stringify(graph)}\n\nAfter chart.`)
task=shareTask(tree([u1,graphMessage]))
const graphResult=task.verify([{...visible([graphMessage])[0],content:'Before chart.\n\nAfter chart.'}])[1].content
assert.match(graphResult,/Synthetic price history/)
assert.match(graphResult,/\| A \| ¥100 \|/)
assert.match(graphResult,/\| B \| ¥90 \|/)
assert.doesNotMatch(graphResult,/charts_widget_v2|dataKey|genui/,'Only readable chart data enters saved Markdown')
const chartLead='This synthetic graph compares the original recorded prices.'
const chartTail='The source values remain available for both recorded months.'
const dilGraph={...graphMessage,content:{content_type:'text',parts:['<box><Chart/></box>']},metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:graphMessage.content.parts[0].replace('Before chart.',chartLead).replace('After chart.',chartTail)}}}
const dilGraphResult=shareTask(tree([u1,dilGraph])).verify([{...visible([graphMessage])[0],content:`${chartLead}\n\nAdditional chart accessibility label.\n\n${chartTail}`}])[1]
assert.match(dilGraphResult.content,/\| A \| ¥100 \|/,'A known DIL chart retains its complete parsed data table when accessibility text adds labels')
assert.match(dilGraphResult.content,/\| B \| ¥90 \|/)
assert.equal(dilGraphResult.networkWidgetSource,undefined,'Recognizing ordinary layouts must not replace a supported chart table with abbreviated DOM text')
assert.throws(()=>shareTask(tree([u1,message('unknown-widget','assistant','genui{"unknown_widget":{}}')])),/暂不支持的可见组件/)
const literalWidget=message('literal-widget','user','Please discuss the literal text genui{"unknown_widget":{}}')
task=shareTask(tree([literalWidget,a1]))
assert.equal(task.verify(visible([literalWidget,a1]))[0].content,literalWidget.content.parts[0],'Literal user input is never treated as a generated widget')
const widgetLead='Use this calculator to compare the two synthetic configurations.'
const widgetTail='Static assumptions remain constant while the shown result changes.'
const interactive={...message('interactive','assistant','<Slider min={0} max={100} step={10}/>'),metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:`${widgetLead}\n\n滑块当前值不可用。范围:0至100步长:10\n\n${widgetTail}`,code:'Never persist executable widget code'}}}
task=shareTask(tree([u1,interactive]))
assert.equal(task.needsAttachmentScan,true,'Interactive components require a rendered scan even without attachments')
assert.throws(()=>task.verify(visible([u1])),/尚未完整显示的交互组件/)
const widgetDOM={role:'assistant',sourceMessageId:'interactive',content:`${widgetLead}\n\nSelected value: 40; displayed result: 80.\n\n${widgetTail}`}
const liveWidget=task.verify([...visible([u1]),widgetDOM])[1]
assert.equal(liveWidget.content,widgetDOM.content,'Known DIL controls preserve the values actually rendered in this document')
assert.equal(liveWidget.networkWidgetSource,interactive.metadata.model_dil_v2.fallbackMarkdown,'The static network display text survives alongside the reconstructed component')
assert.doesNotMatch(JSON.stringify(liveWidget),/executable widget code/)
assert.throws(()=>task.verify([{...widgetDOM,content:'A completely unrelated answer using the same claimed native identity.'}]),/可靠锚点/)
const lowercaseSlider={...interactive,content:{content_type:'text',parts:['<slider min={0} max={100} step={10}/>']},metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:`${widgetLead}\n\nCurrent **value** unavailable.\n\n${widgetTail}`}}}
task=shareTask(tree([u1,lowercaseSlider]))
assert.equal(task.needsAttachmentScan,true,'Native lowercase slider tags require rendered evidence even when placeholder wording changes')
assert.equal(task.verify([...visible([u1]),widgetDOM])[1].content,widgetDOM.content)
assert.throws(()=>task.verify(visible([u1])),/尚未完整显示的交互组件/)
const segmented={...interactive,id:'segmented',content:{content_type:'text',parts:['<segmented options={["Profile A", "Profile B"]}/>']},metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:`${widgetLead}\n\nProfile A / Profile B. 当前所选项不可用。\n\n${widgetTail}`,code:'Never persist executable segmented code',constants:{private:'Never persist segmented constants'},appData:{private:'Never persist selected state'}}}}
const segmentedDOM={...widgetDOM,sourceMessageId:'segmented',content:`${widgetLead}\n\nSelected profile A. Starting travel: 1.5 mm; rapid trigger: disabled.\n\n${widgetTail}`}
task=shareTask(tree([u1,segmented]))
assert.equal(task.needsAttachmentScan,true,'Native segmented controls require a complete rendered scan, including lowercase DIL tags')
const selectedProfile=task.verify([...visible([u1]),segmentedDOM])[1]
assert.equal(selectedProfile.content,segmentedDOM.content,'The selected profile parameters come from the actual rendered answer')
assert.equal(selectedProfile.networkWidgetSource,segmented.metadata.model_dil_v2.fallbackMarkdown,'The unavailable static selection remains separate from the saved rendered values')
assert.doesNotMatch(JSON.stringify(selectedProfile),/Never persist/)
assert.throws(()=>task.verify(visible([u1])),/尚未完整显示的交互组件/)
assert.throws(()=>task.verify([{...segmentedDOM,content:'Unrelated visible values for a different answer.'}]),/可靠锚点/)
assert.throws(()=>task.verify([{...segmentedDOM,sourceMessageId:'wrong-component'}]),/身份/)
const unknownControl={...segmented,content:{content_type:'text',parts:['<unknownSelectionControl/>']}}
assert.throws(()=>shareTask(tree([u1,unknownControl])).verify([segmentedDOM]),/暂不支持/,'Placeholder wording alone must not admit unknown controls')
for(const tag of ['radio','checkbox']){
  const choice={...segmented,content:{content_type:'text',parts:[`<${tag}/>`]}}
  assert.equal(shareTask(tree([u1,choice])).verify([segmentedDOM])[1].content,segmentedDOM.content,'Known choice controls preserve actual rendered state')
}
for(const tag of ['segmented-control','radio-group']){
  const group={...segmented,content:{content_type:'text',parts:[`<${tag}></${tag}>`]}}
  assert.equal(shareTask(tree([u1,group])).verify([segmentedDOM])[1].content,segmentedDOM.content,'Hyphenated native choice tags retain current values')
}
const cardLayout={...dil,id:'cards',content:{content_type:'text',parts:['<box><title>Ranking</title><row><text>{card.label}</text><text>{card.score}</text></row></box>']},metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:`${widgetLead}\n\nRanking\n\n${widgetTail}`,code:'Never persist card executable code',constants:{cards:'Never persist card constants'},appData:{private:'Never persist card state'}}}}
const cardDOM={role:'assistant',sourceMessageId:'cards',content:`${widgetLead}\n\nRanking\n\nExample A: score 9.1, price 320.\nExample B: score 8.4, price 250.\n\n${widgetTail}`}
task=shareTask(tree([u1,cardLayout]))
assert.equal(task.needsAttachmentScan,true,'Known DIL layouts require rendered evidence even when no image or input control is declared')
const savedCards=task.verify([cardDOM])[1]
assert.equal(savedCards.content,cardDOM.content,'Card values omitted from the declared fallback survive as rendered text')
assert.equal(savedCards.networkWidgetSource,cardLayout.metadata.model_dil_v2.fallbackMarkdown)
assert.doesNotMatch(JSON.stringify(savedCards),/Never persist/)
assert.throws(()=>task.verify(visible([u1])),/尚未完整显示/)
assert.throws(()=>task.verify([{...cardDOM,content:'Unrelated visible product values with no original static anchors.'}]),/可靠锚点/)
assert.throws(()=>task.verify([{...cardDOM,sourceMessageId:'wrong-cards'}]),/身份/)
const matchingCards={...cardDOM,content:cardLayout.metadata.model_dil_v2.fallbackMarkdown}
assert.equal(task.verify([matchingCards])[1].content,matchingCards.content,'Matching layouts retain their original network Markdown')
assert.equal(task.verify([matchingCards])[1].networkWidgetSource,undefined)
const hyphenatedCards={...cardLayout,content:{content_type:'text',parts:['<grid><grid-item><table><table-row><table-cell>{card.label}</table-cell></table-row></table></grid-item></grid>']}}
assert.equal(shareTask(tree([u1,hyphenatedCards])).verify([cardDOM])[1].content,cardDOM.content,'Native grid items and table rows/cells use their complete hyphenated names')
assert.throws(()=>shareTask(tree([u1,{...cardLayout,content:{content_type:'text',parts:['<grid-item-unknown/>']}}])),/暂不支持/,'A known component prefix never admits a different hyphenated component')
assert.throws(()=>shareTask(tree([u1,{...cardLayout,content:{content_type:'text',parts:['<box><unknownControl/></box>']}}])),/暂不支持/,'Known wrappers cannot admit unknown components')
const literalLayoutCode='Literal example:\n\n```jsx\n<UnknownControl><Segmented/></UnknownControl>\n```\n\n`<UnknownInline/>`'
const literalDIL={...dil,content:{content_type:'text',parts:[literalLayoutCode]},metadata:{model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:literalLayoutCode}}}
task=shareTask(tree([u1,literalDIL]))
assert.equal(task.needsAttachmentScan,false,'Literal component examples never become native layout or choice controls')
assert.equal(task.verify([{...visible([literalDIL])[0],content:literalLayoutCode}])[1].content,literalLayoutCode)
assert.ok(api.normalizeNetworkDisplayText('Latency <1ms; speed > 2m/s').includes('<1ms'), 'Comparison text is not mistaken for HTML')
assert.equal(api.normalizeNetworkDisplayText('| Key | Value |\n| :--- | ---: |\n| A-B | 10 |\n\n---\n\nEnd.'),api.normalizeNetworkDisplayText('Key\tValue\nA-B\t10\n\nEnd.'),'Only Markdown table alignment and thematic separators disappear during display comparison')
assert.equal(api.normalizeNetworkDisplayText('A-B; value -10'), 'A-B;value-10','Meaningful hyphens and signs remain part of the cross-check')
const lists = message('lists', 'assistant', '* First item\n* Second item\n\n1. Ordered first\n1. Ordered second')
task = shareTask(tree([u1, lists]))
const renderedLists = visible([u1, lists]); renderedLists[1].content = '- First item\n- Second item\n\n1. Ordered first\n2. Ordered second'
assert.equal(task.verify(renderedLists)[1].content, lists.content.parts[0], 'Rendered list markers may change while source Markdown is retained')
task = shareTask(tree([u1, a1, fragment]))
const combined = visible([u1, a1]); combined[1].content += '\n' + fragment.content.parts[0]
assert.equal(task.verify(combined).length, 3, 'A combined DOM answer verifies multiple native final fragments without merging stored messages')

assert.deepEqual({ ...api.readChatGPTPaginationRequest('https://chatgpt.com/backend-api/conversations/synthetic/messages?before=u1&limit=50') }, { before: 'u1' })
assert.throws(() => api.readChatGPTPaginationRequest('https://chatgpt.com/path?before=u1&after=a2'), /歧义/)
assert.throws(() => api.readChatGPTPaginationRequest('https://chatgpt.com/path?cursor=u1&direction=unknown'), /方向/)
task.clear()
assert.equal(task.complete, false)

// Real persistence/merge logic with an in-memory database boundary. No profile
// data is read; source times, attachments and user metadata must survive.
let row = null
let writes = 0
const put = async value => { writes += 1; row = structuredClone(value); return row }
const modules = new Map([
  ['src/db/conversations.ts', { getConversation: async () => row, putConversation: put, getAllConversations: async () => row ? [row] : [], getConversationsBySource: async () => row ? [row] : [] }],
  ['src/db/conversation-exclusions.ts', { putConversationWithExclusionPolicy: put, getConversationExclusions: async () => [], deleteConversationWithExclusionPolicy: assert.fail }],
  ['src/services/account-service.ts', { ensureConversationAccount: async () => undefined }],
  ['src/services/chatgpt-account-migration.ts', { CHATGPT_ACCOUNT_ID: 'unknown' }],
])
function load(path) {
  if (modules.has(path)) return modules.get(path)
  const exports = {}
  modules.set(path, exports)
  const source = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
  runInNewContext(source, { exports, crypto: webcrypto, TextEncoder, URL, require: name => load(posix.normalize(posix.join(posix.dirname(path), name)) + '.ts') })
  return exports
}
const service = load('src/services/conversation-service.ts')
const shareHelpers = load('src/shared/share-capture.ts')
const markdownIncoming = visible([u1, a1]).map(entry => ({ ...entry, content: `**${entry.content}**` }))
assert.equal(shareHelpers.findShareAnchor(visible([u1, a1]), markdownIncoming), null, 'DOM sharing keeps its exact text gate')
assert.ok(shareHelpers.findShareAnchor(visible([u1, a1]), markdownIncoming, true), 'Only a verified network authority can bind the unique pair by native IDs')
assert.equal(shareHelpers.findShareAnchor(visible([u1, a1]), markdownIncoming.map(entry => ({ ...entry, sourceMessageId: 'other-' + entry.sourceMessageId })), true), null)
const hashes = load('src/utils/hash.ts')
const id = await hashes.createConversationId('chatgpt', 'unknown', 'synthetic')
const savedAttachment = { id: 'f'.repeat(64), name: 'synthetic.txt', kind: 'file', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,eA==', status: 'saved', messageIndex: 1, sourceTurnId: 'old-answer-turn' }
row = { id, platform: 'chatgpt', accountId: 'unknown', conversationId: 'synthetic', title: 'Local title', url: 'https://chatgpt.com/c/synthetic', messages: [
  { role: 'user', content: 'Previous folded input', sourceMessageId: 'u1', sourceTurnId: 'old-user-turn' },
  { role: 'assistant', content: a1.content.parts[0], sourceMessageId: 'a1', sourceTurnId: 'old-answer-turn', sentAt: 123456000, sentAtPrecision: 'minute', attachmentNames: ['synthetic.txt'] },
], contentHash: '0'.repeat(64), createdAt: 123, updatedAt: 456, important: true, pinned: true, imageAttachmentPermission: false, fileAttachmentPermission: true, attachments: [savedAttachment] }
const payload = { platform: 'chatgpt', accountId: 'unknown', conversationId: 'synthetic', accountLabel: 'Unknown', accountSource: 'unknown', title: 'Updated DOM title', url: 'https://chatgpt.com/c/synthetic', messages: visible([u1, a1]), pinned: true, contentHash: 'a'.repeat(64) }
await assert.rejects(() => service.saveVerifiedNetworkConversation(payload, async () => false), /授权已撤销/)
assert.equal(writes, 0)
let authorizationChecks = 0
await assert.rejects(() => service.saveVerifiedNetworkConversation(payload, async () => ++authorizationChecks === 1), /授权已撤销/)
assert.equal(writes, 0, 'Authorization is checked again after asynchronous preparation')
const result = await service.saveVerifiedNetworkConversation(payload, async () => true)
assert.equal(result.conversation.important, true)
assert.equal(result.conversation.fileAttachmentPermission, true)
assert.equal(result.conversation.imageAttachmentPermission, false)
assert.equal(result.conversation.createdAt, 123)
assert.equal(result.conversation.messages[0].content, u1.content.parts[0], 'Verified full source replaces a folded local preview')
assert.equal(result.conversation.messages[1].sentAt, 123456000)
assert.equal(result.conversation.messages[1].sentAtPrecision, 'minute')
assert.equal(result.conversation.messages[0].sentAt, undefined)
assert.equal(result.conversation.attachments[0].dataUrl, savedAttachment.dataUrl)
assert.equal(result.conversation.messages[0].contentSource,'network')
const shortDOM = {...payload,messages:payload.messages.map(entry=>({...entry,content:'Short rendered preview'}))}
await service.saveConversation(shortDOM,'automatic')
assert.equal(row.messages[0].content,u1.content.parts[0],'Passive DOM observations cannot shorten verified network input')
assert.equal(row.messages[1].content,a1.content.parts[0],'Passive DOM observations cannot replace the verified answer Markdown')
const reconciliation = load('src/shared/conversation-reconciliation.ts')
const verifiedFragments = [
  {role:'user',content:'Full source question',sourceMessageId:'question',contentSource:'network'},
  {role:'assistant',content:'First source fragment',sourceMessageId:'fragment-1',contentSource:'network'},
  {role:'assistant',content:'Second source fragment',sourceMessageId:'fragment-2',contentSource:'network'},
]
const appendedDOM = [
  {role:'user',content:'Folded question',sourceMessageId:'question'},
  {role:'assistant',content:'First source fragment\nSecond source fragment',sourceMessageId:'fragment-1'},
  {role:'user',content:'New native question',sourceMessageId:'new-question'},
  {role:'assistant',content:'New native reply',sourceMessageId:'new-reply'},
]
const passive = reconciliation.mergeVerifiedNetworkUpdates(verifiedFragments,appendedDOM)
assert.equal(passive.messages.length,5,'Sparse rendered roots append new messages without flattening verified fragments')
assert.equal(passive.messages[1].content,'First source fragment')
assert.equal(reconciliation.mergeVerifiedNetworkUpdates(verifiedFragments,[appendedDOM[0],{...appendedDOM[1],sourceMessageId:'different-branch'}]).status,'conflict','A new response branch cannot be inferred as a tail extension')
const sharedResult = await service.saveVerifiedNetworkConversation({ ...payload, supplementOnly: true, messages: markdownIncoming }, async () => true)
assert.equal(sharedResult.conversation.messages[1].content, a1.content.parts[0], 'A verified shared snapshot preserves the newer local text despite Markdown differences')
const bodyBeforeAttachments = JSON.stringify(row.messages)
row.important = false
const supplemented = await service.supplementVerifiedNetworkAttachments(id, [{ ...savedAttachment, status: 'unavailable', dataUrl: undefined }], async () => true)
assert.equal(supplemented.important, false, 'Attachment completion rereads the latest manual metadata')
assert.equal(supplemented.attachments[0].dataUrl, savedAttachment.dataUrl, 'A failed copy never overwrites an existing local attachment')
assert.equal(JSON.stringify(supplemented.messages), bodyBeforeAttachments, 'The attachment stage does not resubmit or replace body text')
await service.saveConversation({...payload,captureSnapshotComplete:true},'manual')
assert.equal(row.messages[0].contentSource,undefined,'An explicitly selected complete DOM save can replace network provenance')
row = null
await assert.rejects(() => service.supplementVerifiedNetworkAttachments(id, [], async () => true), /已删除/)
assert.equal(row, null, 'An attachment completion cannot resurrect a deleted conversation')

const pendingIssue = { reason: 'Synthetic display mismatch', source: 'network' }
await assert.rejects(() => service.savePendingNetworkConversation(payload, pendingIssue, async () => false), /授权已撤销/)
assert.equal(row, null)
const pending = await service.savePendingNetworkConversation({ ...payload, messages: markdownIncoming }, pendingIssue, async () => true)
assert.deepEqual({ ...pending.conversation.pendingCapture }, pendingIssue)
assert.ok(row.messages.every(message => message.contentSource === undefined))
const pendingReason = row.pendingCapture.reason
await service.saveConversation({ ...payload, messages: [payload.messages[0]] }, 'automatic')
assert.equal(row.pendingCapture.reason, pendingReason, 'A passive partial update must not clear the warning')
row.important = true; row.imageAttachmentPermission = false; row.fileAttachmentPermission = true
row.attachments = [savedAttachment]
await service.saveVerifiedNetworkConversation({ ...payload, supplementOnly: true }, async () => true)
assert.equal(row.pendingCapture, undefined, 'A verified share covering all pending messages clears the warning')
assert.equal(row.messages[1].content, a1.content.parts[0], 'A complete recapture replaces questionable provisional text')
assert.equal(row.important, true); assert.equal(row.fileAttachmentPermission, true)
assert.equal(row.attachments[0].dataUrl, savedAttachment.dataUrl)
const healthy = JSON.stringify(row)
const protectedResult = await service.savePendingNetworkConversation({ ...payload, messages: markdownIncoming }, pendingIssue, async () => true)
assert.equal(protectedResult.changed, false)
assert.equal(JSON.stringify(row), healthy, 'An exceptional candidate cannot downgrade or overwrite an existing healthy copy')
row.pendingCapture = pendingIssue
const extra = { role: 'user', sourceMessageId: 'later', content: 'A later pending message absent from the older share' }
row.messages.push(extra)
await service.saveVerifiedNetworkConversation({ ...payload, supplementOnly: true }, async () => true)
assert.equal(row.pendingCapture.reason, pendingReason, 'An older share that omits pending messages cannot claim completeness')
await service.saveConversation({ ...payload, messages: [...payload.messages, extra], supplementOnly: true, captureSnapshotComplete: true, supplementVerifiedMessageIds: ['u1', 'a1'] }, 'manual')
assert.equal(row.pendingCapture.reason, pendingReason, 'Merging an originating window into an older DOM share cannot turn it into scanned coverage')
await service.saveConversation({ ...payload, captureSnapshotComplete: true }, 'manual')
assert.equal(row.pendingCapture, undefined, 'A complete current-page DOM recapture clears pending state')

const management = load('src/services/data-management-service.ts')
row.pendingCapture = pendingIssue
row.contentHash = await hashes.createContentHash(row.title, row.messages, row.attachments)
const imported = await management.validateConversation(row, 0)
assert.equal(imported.pendingCapture.reason, pendingReason, 'Backup/shared-directory validation retains the pending status')
await assert.rejects(() => management.validateConversation({ ...row, pendingCapture: { reason: 'x', source: 'unknown' } }, 0), /invalid structure/)

const geminiId = await hashes.createConversationId('gemini', 'synthetic-account', 'aaaaaaaaaaaaaaaa')
const legacyAssistant = {role:'assistant',content:'Rendered legacy answer',sourceTurnId:'dom-turn',sentAt:123456000,sentAtPrecision:'minute',attachmentNames:['synthetic.txt']}
row = {id:geminiId,platform:'gemini',accountId:'synthetic-account',conversationId:'aaaaaaaaaaaaaaaa',title:'Gemini local',url:'https://gemini.google.com/app/'+'a'.repeat(16),messages:[{role:'user',content:'Question'},legacyAssistant],attachments:[{...savedAttachment,sourceTurnId:'dom-turn'}],important:true,fileAttachmentPermission:true,imageAttachmentPermission:false,createdAt:123,updatedAt:456,contentHash:'0'.repeat(64)}
const geminiPayload = {...payload,platform:'gemini',accountId:'synthetic-account',conversationId:'aaaaaaaaaaaaaaaa',url:row.url,messages:[{role:'user',content:'Older question',sourceMessageId:'r_aaaaaaaa:user'},{role:'assistant',content:'Older answer',sourceMessageId:'rc_aaaaaaaa'},{role:'user',content:'Question',sourceMessageId:'r_bbbbbbbb:user'},{role:'assistant',content:'**Rendered legacy answer**',sourceTurnId:'r_bbbbbbbb',sourceMessageId:'rc_bbbbbbbb'}]}
await service.saveVerifiedNetworkConversation(geminiPayload,async()=>true,[{previous:legacyAssistant,sourceMessageId:'rc_bbbbbbbb'}])
assert.equal(row.messages[3].sentAt,legacyAssistant.sentAt,'A verified legacy binding retains actual source times')
assert.equal(row.attachments[0].messageIndex,3,'Legacy attachments follow the verified native message when older history is prepended')
assert.equal(row.attachments[0].dataUrl,savedAttachment.dataUrl)
assert.equal(row.attachments[0].sourceTurnId,'r_bbbbbbbb','Verified legacy attachment aliases follow the native turn')
await service.supplementVerifiedNetworkAttachments(geminiId,[{...savedAttachment,id:'e'.repeat(64),messageIndex:3,sourceTurnId:'r_bbbbbbbb',status:'unavailable',dataUrl:undefined}],async()=>true)
assert.equal(row.attachments.length,1,'A failed recopy must not duplicate a migrated attachment under a new ID')
assert.equal(row.attachments[0].dataUrl,savedAttachment.dataUrl)
assert.equal(row.important,true);assert.equal(row.fileAttachmentPermission,true)

const domPair = [{role:'user',content:'Existing DOM question'},{role:'assistant',content:'Existing DOM answer'}]
row = {...row,messages:domPair,attachments:[{...savedAttachment,sourceTurnId:undefined}],contentHash:'0'.repeat(64)}
const fullDom = {...geminiPayload,messages:[{role:'user',content:'Older DOM question'},{role:'assistant',content:'Older DOM answer'},...domPair],captureSnapshotComplete:true}
await service.saveConversation(fullDom,'manual')
assert.equal(row.attachments[0].messageIndex,3,'A current-page DOM sweep that prepends history repositions a legacy attachment by unique full text')
assert.equal(row.attachments[0].dataUrl,savedAttachment.dataUrl)
assert.ok(row.messages.every(message=>message.contentSource!=='network'),'DOM saving never grants network provenance')
row = {...row,messages:domPair,attachments:[{...savedAttachment,sourceTurnId:undefined}],contentHash:'0'.repeat(64)}
const beforeAmbiguous = JSON.stringify(row)
await assert.rejects(()=>service.saveConversation({...fullDom,messages:[...domPair,...domPair]},'manual'),/附件无法/)
assert.equal(JSON.stringify(row),beforeAmbiguous,'Ambiguous attachment positions preserve the existing complete record')
let domAuthorityChecks=0
await assert.rejects(()=>service.saveConversation({...fullDom,supplementOnly:true},'manual',async()=>++domAuthorityChecks===1),/授权已撤销/)
assert.equal(JSON.stringify(row),beforeAmbiguous,'A revoked DOM-share authority cannot write text or attachments')

console.log('network evidence verification passed: cursor chains, overlaps/retries/order, branch trees/cycles, visible fragments, source times, folded inputs, attachments, save authority and lossless persistence')
