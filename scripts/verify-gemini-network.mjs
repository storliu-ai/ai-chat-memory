import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { verificationModule } from './load-verification-module.mjs'

const { renderGeminiAnswer, matchesGeminiDisplay } = verificationModule('src/adapters/gemini/network-presentation.ts')
const { GeminiNetworkEvidence, decodeGeminiRpc } = verificationModule('src/adapters/gemini/network-evidence.ts')
const urls = verificationModule('src/adapters/gemini/capture-urls.ts')
const cid = 'aaaaaaaaaaaaaaaa', sid = 'bbbbbbbbbbbbbbbb'
const wire = (payload, rpc = 'hNvQHb') => {
  const line = JSON.stringify([['wrb.fr', rpc, JSON.stringify(payload)]])
  return ")]}'\n\n" + (line.length + 2) + '\n' + line + '\n\n'
}
const turn = (id, parent = null, answer = `Answer ${id} 中文`) => [
  [`c_${cid}`, `r_${id.repeat(8)}`], parent ? [`c_${cid}`, `r_${parent.repeat(8)}`, `rc_${parent.repeat(8)}`] : [],
  [[`Question ${id}`]], [[[`rc_${id.repeat(8)}`, [answer]]], null, null, `rc_${id.repeat(8)}`], [1_700_000_000, 0],
]
const first = turn('a'), second = turn('b', 'a')
const make = () => new GeminiNetworkEvidence({ mode: 'conversation', id: cid })
const evidence = make()
evidence.add(wire([[second], 'opaque-cursor']), 'initial')
assert.equal(evidence.complete, false, 'A newer page is not a complete history')
evidence.add(wire([[first], null]), 'initial')
assert.equal(evidence.complete, true)
const rendered = [first, second].flatMap(item => [{role:'user',content:item[2][0][0]}, {role:'assistant',content:item[3][0][0][1][0]}])
const proofs = [first,second].map((item,index)=>({messageIndex:index*2+1,...renderGeminiAnswer(item[3][0][0][1][0]).evidence}))
const verified = evidence.verify(rendered, true, proofs)
const consecutive = payload => {
  const main = JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify(payload)]])
  const metadata = JSON.stringify([['di',1]])
  return ")]}'\n\n"+(main.length+2)+'\n'+main+'\n'+(metadata.length+2)+'\n'+metadata+'\n'
}
assert.equal(decodeGeminiRpc(consecutive([[first],null]),'hNvQHb')[1],null,'Real responses put the next length immediately after each JSON line')
assert.throws(()=>decodeGeminiRpc(consecutive([[first],null]).slice(0,-1),'hNvQHb'),'The final frame still requires its terminator')
assert.equal(verified.length, 4)
assert.ok(verified.every(message => message.sentAt === undefined), 'Private response numeric values are never source times')
assert.equal(verified[2].sourceMessageId, 'r_bbbbbbbb:user')
assert.equal(evidence.matchesSource({messages:rendered.slice(2),networkEvidence:[{...proofs[1],messageIndex:1}]}, true), true)
assert.equal(evidence.matchesSource({messages:rendered.slice(0,2),networkEvidence:[proofs[0]]},false,true),false,'A shared ancestor alone cannot bind a potentially divergent share branch')
assert.equal(evidence.matchesSource({messages:rendered.slice(2),networkEvidence:[{...proofs[1],messageIndex:1}]},false,true),true,'The share head must match one unique pair currently rendered in the source')
assert.throws(()=>evidence.verify(rendered,true,[]))
assert.throws(()=>evidence.verify(rendered.slice(2),true,proofs))
assert.throws(()=>evidence.verify([{...rendered[0],content:'Changed'},...rendered.slice(1)],true,proofs))
for (const mutated of [body=>body.slice(0,-4), body=>body.replace(/\n\d+\n/, '\n1\n'), body=>body+'broken', body=>body.replace('hNvQHb','otherRpc')]) assert.throws(()=>decodeGeminiRpc(mutated(wire([[first],null])),'hNvQHb'))
const invalidJson = '["Synthetic private marker" broken]'
assert.throws(()=>decodeGeminiRpc(")]}'\n\n"+(invalidJson.length+2)+'\n'+invalidJson+'\n\n','hNvQHb'),error=>!error.message.includes('Synthetic private marker'),'JSON errors cannot leak response fragments into persisted task status')
const missing = make(); missing.add(wire([[second],null]),'initial'); assert.equal(missing.complete,false)
const fork = make(); fork.add(wire([[first,second,turn('c','a')],null]),'initial'); assert.equal(fork.complete,false)
const conflicting = structuredClone(second); conflicting[1][2]='rc_dddddddd'
const wrongParent = make(); wrongParent.add(wire([[first,conflicting],null]),'initial'); assert.equal(wrongParent.complete,false)
const wrongCid = structuredClone(first); wrongCid[0][0]='c_cccccccccccccccc'
assert.throws(()=>make().add(wire([[wrongCid],null]),'initial'))
const duplicate = structuredClone(first); duplicate[3][0].push(duplicate[3][0][0])
assert.throws(()=>make().add(wire([[duplicate],null]),'initial'))
const share = new GeminiNetworkEvidence({mode:'share',id:sid,sourceId:cid})
share.add(wire([[null,[first,second],null,sid]],'ujx1Bf'),'share'); assert.equal(share.complete,true)
assert.throws(()=>new GeminiNetworkEvidence({mode:'share',id:cid,sourceId:cid}).add(wire([[null,[first],null,sid]],'ujx1Bf'),'share'))

const markup = '<Sequence>\n<Step title="First">\nText **shown**\n```js\n  const x = 1;\n```\n</Step>\n</Sequence>\n{/* Hidden reasoning */}\n<ElicitationsGroup message="Choose"><Elicitation label="Option" query="private action" /></ElicitationsGroup><FollowUp label="Next" query="hidden action" />'
const presentation = renderGeminiAnswer(markup)
assert.ok(presentation.markdown.includes('Option'))
assert.ok(!/Hidden reasoning|private action|hidden action|<Step/.test(presentation.markdown))
assert.equal(presentation.evidence.blocks[0].content,'  const x = 1;')
const literal = renderGeminiAnswer('```jsx\n<Unknown secret="literal" />\n```')
assert.ok(literal.markdown.includes('<Unknown'))
for (const invalid of ['<Unknown />','<Step title="No parent">x</Step>','<Sequence>missing','<FollowUp label={run()} />','<FollowUp label="x" onClick="run" />']) assert.throws(()=>renderGeminiAnswer(invalid))
const changedCode = structuredClone(presentation.evidence); changedCode.blocks[0].content='const x = 1;'
assert.equal(matchesGeminiDisplay(presentation.evidence,changedCode),false,'Meaningful code indentation remains exact')
const withoutSuggestions = renderGeminiAnswer(markup,true)
assert.ok(!/Option|Choose|Next/.test(withoutSuggestions.markdown))
assert.ok(withoutSuggestions.markdown.includes('const x = 1;'))
const optional = make(); optional.add(wire([[turn('a',null,markup)],null]),'initial')
const optionalMessages = [{role:'user',content:'Question a'},{role:'assistant',content:'Rendered body'}]
const omitted = optional.verify(optionalMessages,true,[{messageIndex:1,...withoutSuggestions.evidence}])
assert.equal(omitted[1].content,withoutSuggestions.markdown,'Only the presentation actually rendered on this document is archived')
const partialSuggestions = structuredClone(presentation.evidence); partialSuggestions.displayText=partialSuggestions.displayText.replace('Option','')
assert.throws(()=>optional.verify(optionalMessages,true,[{messageIndex:1,...partialSuggestions}]),'Partial missing suggestion text cannot bypass the full display check')
assert.ok(renderGeminiAnswer('<ElicitationsGroup message="Choose">Important body<Elicitation label="Option" /></ElicitationsGroup>',true).markdown.includes('Important body'),'A group with ordinary body text is never treated as an optional action-only group')

const {document,window} = parseHTML('<html><body><model-response><div class="presented-response-container"><h3>First</h3><p>Text <strong>shown</strong></p><code-block><div class="code-block-decoration"><span>JS</span></div><pre><code>  const x = 1;\n</code></pre></code-block><div class="only-show-to-message-actions">Hidden copy</div><div>Choose</div><button class="elicitation-item"><span class="elicitation-label">Option</span></button><div>Next</div></div></model-response></body></html>')
const {readGeminiDisplayEvidence} = verificationModule('src/adapters/gemini/rendered-evidence.ts',{document})
assert.equal(matchesGeminiDisplay(presentation.evidence,readGeminiDisplayEvidence(document.querySelector('model-response'))),true)
assert.ok(document.querySelector('.only-show-to-message-actions'),'Evidence extraction never mutates the host DOM')
const safety = verificationModule('src/adapters/gemini/capture-page-state.ts',{document,Element:window.Element,HTMLTextAreaElement:window.HTMLTextAreaElement,getComputedStyle:()=>({visibility:'visible',display:'block'})})
assert.ok(safety.getGeminiCaptureBlockers().includes('unknown'))
function composerSafety(html) {
  const {document,window} = parseHTML(`<html><body>${html}</body></html>`)
  window.Element.prototype.getClientRects = () => [1]
  const api = verificationModule('src/adapters/gemini/capture-page-state.ts',{document,Element:window.Element,HTMLTextAreaElement:window.HTMLTextAreaElement,getComputedStyle:()=>({visibility:'visible',display:'block'})})
  return {document,...api}
}
const empty = '<input-area-v2><div class="input-area"><rich-textarea><div role="textbox" contenteditable="true"><p><br></p></div><div class="ql-clipboard" contenteditable="true"></div></rich-textarea></div></input-area-v2>'
assert.equal(composerSafety(empty).getGeminiCaptureBlockers().length,0,'Quill clipboard is not an ambiguous second composer')
assert.ok(composerSafety(empty.replace('<p><br></p>','Draft')).getGeminiCaptureBlockers().includes('draft'))
assert.ok(composerSafety(empty.replace('</input-area-v2>','<user-query-file-preview>pending</user-query-file-preview></input-area-v2>')).getGeminiCaptureBlockers().includes('attachment'),'Attachments outside the inner input-area remain in the native composer scope')
assert.ok(composerSafety(empty+'<button aria-label="Stop response">stop</button>').getGeminiCaptureBlockers().includes('generating'))
assert.ok(composerSafety(empty+'<user-query><textarea>editing</textarea></user-query>').getGeminiCaptureBlockers().includes('editing'))

assert.equal(urls.getGeminiSourceId(`https://gemini.google.com/u/2/app/${cid}`),cid)
assert.equal(urls.getGeminiAccountContext(`https://gemini.google.com/u/2/app/${cid}`),'google-slot:2')
assert.equal(urls.normalizeGeminiShareUrl(`https://gemini.google.com/share/${sid}?tracking=ignored`),`https://gemini.google.com/share/${sid}`)
assert.equal(urls.normalizeGeminiShareUrl(`https://gemini.google.com.evil.example/share/${sid}`),null)
assert.equal(urls.matchGeminiCaptureEndpoint('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',{mode:'conversation',id:cid}),'initial')
assert.equal(urls.matchGeminiCaptureEndpoint('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&rpcids=other',{mode:'conversation',id:cid}),null)
console.log('Gemini network verification passed: framed JSON, native parent/selection graph, terminal history, share binding, exact display/code evidence, hidden actions, source times and URL boundaries')

// Exercise the real transport, including a multibyte character split across
// buffered and streamed chunks and the frontend's intentional cancellation.
function bus() {
  const listeners = new Set()
  return {addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener),emit:(...args)=>{for(const listener of [...listeners])listener(...args)}}
}
async function streamed({cancelled = true, prefixFailure = false, splitInvalid = false, unrelated = false, fallbackBody = false} = {}) {
  const events = bus(), detach = bus(), received = [], failures = [], commands = []
  const body = wire([[first],null]), bytes = new TextEncoder().encode(body)
  const split = bytes.findIndex(value=>value>127)+1
  let deliverPrefix
  const prefix = new Promise(resolve=>{deliverPrefix=resolve})
  const chrome = {debugger:{onEvent:events,onDetach:detach,attach:async()=>{},detach:async()=>{},sendCommand:async(_tab,method)=>{
    commands.push(method)
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'old'}}}
    if(method==='Network.streamResourceContent') {await prefix;if(prefixFailure)throw Error('unsupported');return {bufferedData:Buffer.from(bytes.subarray(0,split)).toString('base64')}}
    if(method==='Network.getResponseBody' && fallbackBody)return {body}
    return {}
  }}}
  const {NetworkDebugSession} = verificationModule('src/background/network-debug-session.ts',{chrome})
  const session = new NetworkDebugSession(7,{platform:'gemini',mode:'conversation',id:cid},{response:body=>received.push(body),failure:message=>failures.push(message),navigation:()=>true})
  await session.connect()
  const emit = (method,data)=>events.emit({tabId:7},method,data)
  emit('Page.frameNavigated',{frame:{id:'main',loaderId:'new',url:`https://gemini.google.com/app/${cid}`}})
  const url='https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb'
  emit('Network.requestWillBeSent',{requestId:'r',frameId:unrelated?'other':'main',loaderId:'new',type:'Fetch',request:{url,method:'POST',get headers(){throw Error('Never read headers')},get postData(){throw Error('Never read request body')}}})
  emit('Network.responseReceived',{requestId:'r',frameId:'main',loaderId:'new',response:{url,status:200,mimeType:'application/json'}})
  emit('Network.dataReceived',{requestId:'r',data:Buffer.from(splitInvalid ? [255] : bytes.subarray(split)).toString('base64')})
  emit(cancelled?'Network.loadingFailed':'Network.loadingFinished',cancelled?{requestId:'r',canceled:true,errorText:'net::ERR_ABORTED'}:{requestId:'r'})
  assert.equal(received.length,0,'Prefix must be prepended even when its promise resolves after completion')
  deliverPrefix()
  for(let tick=0;tick<40;tick++)await Promise.resolve()
  if(prefixFailure && !fallbackBody || splitInvalid) assert.equal(failures.length,1)
  else if(unrelated) assert.equal(received.length,0)
  else { assert.equal(received[0],body);assert.equal(decodeGeminiRpc(received[0],'hNvQHb')[1],null) }
  assert.ok(commands.every(command=>['Page.enable','Page.getFrameTree','Network.enable','Network.streamResourceContent','Network.getResponseBody'].includes(command)))
  assert.equal(session.pendingCount,0)
  await session.disconnect()
}
await streamed()
await streamed({cancelled:false})
await streamed({prefixFailure:true})
await streamed({prefixFailure:true,fallbackBody:true})
await streamed({splitInvalid:true})
await streamed({unrelated:true})
console.log('Gemini stream verification passed: delayed buffered prefix, split UTF-8, intentional cancellation, unsupported commands and exact-frame filtering')

async function coordinatorHarness(mode = 'conversation') {
  const writes = [], timers = new Map(), statuses = new Map()
  let session, stateToken = 'source-before', account = 'google-account-0', saved = null, timerId = 0
  const sourceUrl = `https://gemini.google.com/app/${cid}`, sharedUrl = `https://gemini.google.com/share/${sid}`
  const capture = {platform:'gemini',conversationId:cid,url:sourceUrl,title:'Synthetic Gemini',accountIdentifier:account,accountLabel:'Synthetic account',messages:structuredClone(rendered),networkEvidence:structuredClone(proofs)}
  const source = () => ({...capture,accountIdentifier:account})
  const context = () => ({platform:'gemini',accountContext:'google-slot:0',contentScriptBuildId:'test',url:sourceUrl,conversationId:cid,documentToken:stateToken,branchRevision:0,blockers:[]})
  class Debug {
    pendingCount = 0
    constructor(tabId,target,callbacks) {this.tabId=tabId;this.target=target;this.callbacks=callbacks;session=this}
    async connect() {}
    async disconnect() {this.closed=true}
  }
  const chrome = {runtime:{getURL:path=>'chrome-extension://test/'+path,sendMessage:async()=>{}},tabs:{query:async()=>[],create:async()=>({id:2}),remove:async()=>{},update:async(_id,options)=>{if(options.url)assert.equal(session.callbacks.navigation(options.url,false),true)},sendMessage:async(_id,request)=>{
    if(request.type==='AI_CHAT_MEMORY_NETWORK_PAGE_PROBE')return context()
    if(request.type==='AI_CHAT_MEMORY_NETWORK_PAGE_CONTEXT')return request.documentToken===stateToken?source():null
    if(request.type==='AI_CHAT_MEMORY_NETWORK_PAGE_REFRESH') {assert.equal(session.callbacks.navigation(sourceUrl,false),true);stateToken='source-after';return {accepted:true}}
    return undefined
  }}}
  const coordinator = verificationModule('src/background/network-capture-coordinator.ts',{chrome,setTimeout:callback=>{timers.set(++timerId,callback);return timerId},clearTimeout:id=>timers.delete(id)}, {
    './network-debug-session':{NetworkDebugSession:Debug,detachInterruptedNetworkSession:async()=>{}},
    './share-capture-coordinator':{hasActiveShareCapture:()=>false},
    './runtime-readiness':{getCaptureReadiness:async()=>({ready:true})},
    '../shared/build-id':{EXTENSION_BUILD_ID:'test'},
    '../db/settings':{getSettings:async()=>({saveImages:false,fileSavePolicy:'never',attachmentMaxSizeMb:10})},
    '../db/network-capture-jobs':{readNetworkCaptureJobs:async()=>[],putNetworkCaptureJob:async status=>statuses.set(status.originTabId,structuredClone(status)),deleteNetworkCaptureJob:async id=>statuses.delete(id)},
    '../utils/hash':{createAccountId:async(_platform,identifier)=>identifier==='google-account-0'?'expected-account':'different-account',createContentHash:async()=> 'a'.repeat(64)},
    '../services/conversation-service':{
      getSavedConversationBySource:async(platform,sourceId,accountId)=>{assert.equal(platform,'gemini');assert.equal(sourceId,cid);assert.equal(accountId,'expected-account');return saved},
      saveVerifiedNetworkConversation:async(payload,authorize)=>{assert.equal(await authorize(),true);writes.push(payload);saved={...payload,id:'local',messages:payload.messages,attachments:[],fileAttachmentPermission:false,imageAttachmentPermission:false};return {conversation:saved,changed:true}},
      supplementVerifiedNetworkAttachments:async(_id,attachments,authorize)=>{assert.equal(await authorize(),true);assert.equal(attachments.length,0);return saved},
      updateConversationFileAttachmentPermission:async()=>saved,updateConversationImageAttachmentPermission:async()=>saved,
      savePendingNetworkConversation:assert.fail,
    },
  })
  const panel = {tab:{id:1},url:'chrome-extension://test/panel.html'}
  const content = (tabId=1) => ({tab:{id:tabId},frameId:0,documentId:tabId===1?'source-document':'share-document',url:tabId===1?sourceUrl:sharedUrl})
  const request = (action,extra={},sender=panel)=>coordinator.handleNetworkCapture({type:'NETWORK_CAPTURE',platform:'gemini',contentScriptBuildId:'test',conversationId:cid,action,...extra},sender)
  const started = await request('start',{method:'network',operation:'save',mode,shareUrl:sharedUrl})
  for(let tick=0;tick<100;tick++)await Promise.resolve()
  assert.equal(coordinator.isNetworkSavePaused('gemini',cid),true)
  assert.equal(coordinator.isNetworkSavePaused('chatgpt',cid),false,'Gemini must not occupy the ChatGPT source-ID namespace')
  const token=mode==='share'?'share-token':stateToken
  await request('claim',{documentToken:token},content(mode==='share'?2:1))
  session.callbacks.response(mode==='share'?wire([[null,[first,second],null,sid]],'ujx1Bf'):wire([[second,first],null]),mode==='share'?'share':'initial',100,{})
  for(let tick=0;tick<40;tick++)await Promise.resolve()
  const submit = (action,extra={})=>request(action,{jobId:started.status.id,documentToken:token,...extra},content(mode==='share'?2:1))
  return {coordinator,writes,request,submit,started,setAccount:value=>{account=value},capture:{...capture,...(mode==='share'?{url:sharedUrl,conversationId:sid}:{})},statuses}
}
for(const mode of ['conversation','share']) {
  const test = await coordinatorHarness(mode)
  const committed = await test.submit('commit',{capture:test.capture})
  assert.equal(committed.status.phase,'attachments')
  assert.equal(committed.savedConversationId,'local','Mirroring and notifications receive the exact saved account record')
  assert.equal(test.writes.length,1)
  assert.equal(test.writes[0].platform,'gemini');assert.equal(test.writes[0].accountId,'expected-account')
  assert.equal(test.writes[0].messages.length,4)
  assert.equal(test.writes[0].supplementOnly,mode==='share'?true:undefined)
  await test.submit('attachments',{attachments:[]})
  assert.equal(test.coordinator.isNetworkSavePaused('gemini',cid),false)
}
const changedAccount = await coordinatorHarness()
changedAccount.setAccount('google-account-1')
await assert.rejects(()=>changedAccount.submit('commit',{capture:changedAccount.capture}),/独立核对/)
assert.equal(changedAccount.writes.length,0)
await changedAccount.request('cancel',{jobId:changedAccount.started.status.id})
const changedDisplay = await coordinatorHarness()
changedDisplay.capture.networkEvidence[0].blocks.push({language:'js',content:'unseen'})
await assert.rejects(()=>changedDisplay.submit('commit',{capture:changedDisplay.capture}))
assert.equal(changedDisplay.writes.length,0)
await changedDisplay.submit('error',{capture:changedDisplay.capture,error:'Synthetic display mismatch'})
assert.equal(changedDisplay.statuses.get(1).phase,'failed','Gemini cannot enter exceptional candidate confirmation')
console.log('Gemini coordinator verification passed: current/share save, originating account, platform locks, display mismatch, cancellation, separate attachments and no exceptional-save bypass')
