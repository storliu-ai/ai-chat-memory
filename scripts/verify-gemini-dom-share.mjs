import assert from 'node:assert/strict'
import {parseHTML} from 'linkedom'
import {verificationModule} from './load-verification-module.mjs'

const cid='a'.repeat(16),sid='b'.repeat(16)
const sourceUrl=`https://gemini.google.com/app/${cid}`,shareUrl=`https://gemini.google.com/share/${sid}`
const turn=index=>`<share-turn-viewer><user-query><user-query-content id="user-query-content-${index}"><div class="query-text">Synthetic unique question ${index} with enough context for binding.</div></user-query-content></user-query><model-response><div class="presented-response-container"><p>Synthetic answer ${index}.</p><code-block><div class="code-block-decoration"><span>JS</span></div><pre><code>  const value = ${index};\n</code></pre></code-block><div class="only-show-to-message-actions"><code>Hidden copy ${index}</code></div><elicitations><div class="elicitations-container"><div class="elicitations-message">Choose another action</div><button class="elicitation-item"><div class="elicitation-label">Suggestion</div></button></div></elicitations></div></model-response></share-turn-viewer>`
const {document,window}=parseHTML(`<html><head><title>Synthetic share</title></head><body><main>${turn(0)}${turn(1)}</main></body></html>`)
const globals={document,location:{href:shareUrl},Element:window.Element,HTMLElement:window.HTMLElement,HTMLTimeElement:class{},HTMLImageElement:window.HTMLImageElement,HTMLAnchorElement:window.HTMLAnchorElement,CSS:{escape:value=>value}}
const {GeminiShareAdapter}=verificationModule('src/adapters/gemini/gemini-share-adapter.ts',globals)
const {mergeGeminiDomShare,portableGeminiDomCapture,retainGeminiDomShareText}=verificationModule('src/adapters/gemini/dom-share.ts')
const adapter=new GeminiShareAdapter(),captured=adapter.extractDomShareConversation()
assert.equal(captured.messages.length,4)
assert.equal(captured.messages[1].sourceOrder,1)
assert.ok(captured.messages[1].content.includes('```js\n  const value = 0;\n```'))
assert.ok(!/Hidden copy|Choose another action|Suggestion/.test(captured.messages[1].content))
assert.ok(!adapter.getMessages()[1].content.includes('Hidden copy'),'Current DOM text omits hidden copy controls too')
assert.ok(captured.domMessageAliases[1].some(alias=>alias.includes('Hidden copy')),'Old text can be matched transiently without archiving hidden UI in new messages')
assert.ok(document.querySelector('elicitations'),'Extraction never mutates the host')
const portable=portableGeminiDomCapture(captured)
assert.ok(portable.messages.every(message=>message.sourceOrder===undefined&&message.sourceTurnId===undefined&&message.sourceMessageId===undefined))
const legacy=portable.messages.slice(2).map((message,index)=>({...message,content:captured.domMessageAliases[index+2][0],sentAt:index?123456000:undefined}))
const retained=retainGeminiDomShareText({messages:portable.messages},legacy,[captured])
assert.equal(retained.messages[3].content,legacy[1].content)
assert.equal(retained.messages[3].sentAt,legacy[1].sentAt)
assert.throws(()=>retainGeminiDomShareText({messages:portable.messages},[{role:'user',content:'Unrelated question'},{role:'assistant',content:'Unrelated answer'}],[captured]))
const newest=[{role:'user',content:'Synthetic new question after the share snapshot.'},{role:'assistant',content:'Synthetic new answer retained from the original conversation.'}]
const newerSource={...portable,messages:[...portable.messages.slice(2),...newest],domMessageAliases:[...captured.domMessageAliases.slice(2),...newest.map(message=>[message.content])],domWindowContiguous:true,attachmentCandidates:[{kind:'file',name:'newest.txt',sourceUrl:null,messageIndex:3}]}
const combined=mergeGeminiDomShare(newerSource,portable)
assert.equal(combined.messages.length,6,'An old full share and a continuous newer source window retain both ends')
assert.equal(combined.messages[5].content,newest[1].content)
assert.equal(combined.attachmentCandidates[0].messageIndex,5)
assert.throws(()=>mergeGeminiDomShare({...newerSource,domWindowContiguous:false},portable),'A sparse source window cannot append an unverified tail')
const previousNetwork=portable.messages.map((message,index)=>index%2?{...message,content:captured.domMessageAliases[index].find(alias=>alias.includes('```js')&&alias.includes('Suggestion')),contentSource:'network'}:message)
const networkRetained=retainGeminiDomShareText({messages:portable.messages},previousNetwork,[captured])
assert.equal(networkRetained.messages[1].content,previousNetwork[1].content,'Existing network Markdown with visible suggestion labels is retained through code-exact DOM aliases')

async function harness({gap=false,older=false}={}) {
  let identifier='google-account-0',revision=0,token='source-token'
  const records=new Map(),closed=[],opened=[]
  const sourceCapture={...portable,conversationId:cid,url:sourceUrl,accountIdentifier:identifier,accountLabel:'Synthetic source account',messages:portable.messages.slice(2),domMessageAliases:captured.domMessageAliases.slice(2)}
  const accountId=await verificationModule('src/utils/hash.ts').createAccountId('gemini',identifier)
  const saved={platform:'gemini',accountId,conversationId:cid,messages:legacy}
  const chrome={runtime:{getURL:path=>'chrome-extension://test/'+path},tabs:{create:async options=>{opened.push(options);return{id:2}},update:async()=>{},remove:async id=>closed.push(id),sendMessage:async(_id,request)=>{
    if(request.type==='AI_CHAT_MEMORY_SHARE_SOURCE_CONTEXT')return {platform:'gemini',conversationId:cid,url:sourceUrl,contentScriptBuildId:'test',...(request.includeCapture?{capture:{...sourceCapture,accountIdentifier:identifier}}:{})}
    if(request.type==='AI_CHAT_MEMORY_NETWORK_PAGE_PROBE')return {platform:'gemini',conversationId:cid,url:sourceUrl,contentScriptBuildId:'test',accountContext:'google-slot:0',documentToken:token,branchRevision:revision,blockers:[]}
    return {jobId:request.jobId}
  }}}
  const api=verificationModule('src/background/share-capture-coordinator.ts',{chrome},{
    '../shared/build-id':{EXTENSION_BUILD_ID:'test'},
    '../db/share-capture-jobs':{readShareCaptureJobs:async()=>[],putShareCaptureJob:async status=>records.set(status.originTabId,structuredClone(status)),deleteShareCaptureJob:async id=>records.delete(id)},
    '../services/conversation-service':{getSavedConversationBySource:async(platform,id,selectedAccount)=>{assert.equal(platform,'gemini');assert.equal(id,cid);assert.equal(selectedAccount,accountId);return saved}},
  })
  const sender={tab:{id:1},frameId:0,documentId:'source-doc',url:sourceUrl}
  const start=await api.handleShareCapture({action:'start',platform:'gemini',conversationId:cid,shareUrl,sourceMessages:sourceCapture.messages},sender)
  assert.equal(opened[0].active,false)
  assert.equal(api.hasActiveShareCapture(cid,'gemini'),true);assert.equal(api.hasActiveShareCapture(cid,'chatgpt'),false)
  const sharedSender={tab:{id:2},frameId:0,documentId:'share-doc',url:shareUrl}
  await api.handleShareCapture({action:'claim',platform:'gemini'},sharedSender)
  const snapshot=structuredClone({...captured,captureComplete:true})
  if(gap)snapshot.messages[2].sourceOrder=8
  if(older){snapshot.messages=snapshot.messages.slice(0,2);snapshot.domMessageAliases=snapshot.domMessageAliases.slice(0,2)}
  await api.handleShareCapture({action:'finish',platform:'gemini',jobId:start.status.id,capture:snapshot},sharedSender)
  return {api,sender,records,closed,accountId,changeAccount:()=>{identifier='google-account-1'},changeBranch:()=>{revision++},reload:()=>{token='different-document'},appendTurn:()=>{sourceCapture.messages=[...sourceCapture.messages,...newest]}}
}
const valid=await harness()
assert.equal(valid.records.get(1).phase,'ready')
assert.equal(await valid.api.isShareSaveAuthorized(valid.sender,cid,'gemini',valid.accountId),true)
const prepared=await valid.api.prepareShareSavePayload(valid.sender,{platform:'gemini',accountId:valid.accountId,conversationId:cid,title:'Synthetic',messages:portable.messages})
assert.equal(prepared.messages[3].content,legacy[1].content);assert.equal(prepared.messages[3].sentAt,legacy[1].sentAt)
assert.equal(prepared.url,sourceUrl);assert.equal(prepared.accountLabel,'Synthetic source account')
await assert.rejects(()=>valid.api.prepareShareSavePayload(valid.sender,{platform:'gemini',accountId:valid.accountId,conversationId:cid,title:'Synthetic',messages:[...portable.messages.slice(0,3),{role:'assistant',content:'Injected text'}]}),/不属于/)
valid.changeAccount();assert.equal(await valid.api.isShareSaveAuthorized(valid.sender,cid,'gemini',valid.accountId),false)
await valid.api.cancelShareCaptureJobs(cid,'gemini');assert.deepEqual(valid.closed,[2])
const changed=await harness();changed.changeBranch();assert.equal(await changed.api.isShareSaveAuthorized(changed.sender,cid,'gemini',changed.accountId),false)
const reloaded=await harness();reloaded.reload();assert.equal(await reloaded.api.isShareSaveAuthorized(reloaded.sender,cid,'gemini',reloaded.accountId),false)
const newSubmission=await harness();newSubmission.appendTurn();assert.equal(await newSubmission.api.isShareSaveAuthorized(newSubmission.sender,cid,'gemini',newSubmission.accountId),false,'A new source turn during capture revokes the old task even if no native click event was observed')
assert.equal((await harness({gap:true})).records.get(1).phase,'failed')
assert.equal((await harness({older:true})).records.get(1).phase,'failed','A common ancestor cannot authorize a divergent share')
assert.ok(!JSON.stringify([...valid.records.values()]).includes('Synthetic unique question'))

async function currentScan({missing=null,cancel=false,remount=false,busy=false}={}) {
  let position=1800,root,main,reads=0,cancelled=false,replaced=false
  const messages=Array.from({length:24},(_,index)=>({role:index%2?'assistant':'user',content:`Synthetic full visible message ${index} for natural DOM scrolling.`,sourceOrder:index}))
  class Element {
    parentElement=null;isConnected=true;clientHeight=240;scrollHeight=2400
    get scrollTop(){return this===root?position:0}
    set scrollTop(value){if(this===root)position=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight))}
    contains(element){return this===element||this===main}
    querySelectorAll(selector){return selector==='*'?[]:turns()}
    querySelector(){return turns()[0]??null}
    getBoundingClientRect(){return{top:0,bottom:240,height:240}}
  }
  const make=()=>{root=new Element();main=new Element();main.parentElement=root};make()
  const visible=()=>{const first=Math.floor(position/100);return messages.filter(message=>message.sourceOrder!==missing&&message.sourceOrder>=first&&message.sourceOrder<=first+4)}
  const turns=()=>visible().map(message=>({parentElement:main,getBoundingClientRect:()=>({top:message.sourceOrder*100-position,bottom:(message.sourceOrder+1)*100-position,height:100})}))
  const pageWindow={innerHeight:240,scrollY:0,getComputedStyle:element=>({overflowY:element===root?'auto':'visible'}),setTimeout:callback=>setTimeout(callback,1),clearTimeout,requestAnimationFrame:callback=>setTimeout(callback,1)}
  const {GeminiAdapter}=verificationModule('src/adapters/gemini/gemini-adapter.ts',{Element,window:pageWindow,document:{body:null,documentElement:{scrollHeight:240},scrollingElement:null,querySelectorAll:()=>busy?[{closest:()=>null,getClientRects:()=>[1]}]:[]},getComputedStyle:()=>({visibility:'visible',display:'block'}),MutationObserver:class{observe(){}disconnect(){}}})
  const instance=new GeminiAdapter();instance.getConversationId=()=>cid;instance.getConversationContainer=()=>main
  instance.extractConversation=()=>{reads++;if(cancel&&reads>3)cancelled=true;if(remount&&!replaced&&reads>6){root.isConnected=false;main.isConnected=false;make();replaced=true}return {platform:'gemini',conversationId:cid,title:'Synthetic current conversation',url:sourceUrl,accountIdentifier:'google-account-0',accountLabel:'Synthetic account',messages:visible(),attachmentCandidates:visible().some(message=>message.sourceOrder===19)?[{name:'synthetic.txt',kind:'file',sourceUrl:null,messageIndex:visible().findIndex(message=>message.sourceOrder===19)}]:[]}}
  return instance.collectConversation(()=>{},()=>cancelled)
}
const complete=await currentScan()
assert.equal(complete.captureComplete,true);assert.equal(complete.messages.length,24)
assert.equal(new Set(complete.messages.map(message=>message.sourceOrder)).size,24)
assert.ok(complete.attachmentCandidates.some(candidate=>candidate.name==='synthetic.txt'&&candidate.messageIndex===19),'A file discovered in a later virtual window follows its message after the full sweep')
assert.notEqual((await currentScan({missing:10})).captureComplete,true)
assert.notEqual((await currentScan({cancel:true}))?.captureComplete,true)
assert.equal((await currentScan({remount:true})).captureComplete,true)
await assert.rejects(()=>currentScan({busy:true}),/生成或编辑/,'A generating answer cannot be reported as a complete current-page DOM archive')
console.log('Gemini DOM verification passed: extraction/code/hidden UI, source account/document/branch, legacy retention, gaps/cancellation, full current scrolling and replaced roots')
