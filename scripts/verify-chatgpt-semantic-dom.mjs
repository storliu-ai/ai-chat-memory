import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { runInNewContext } from 'node:vm'
import { setTimeout as schedule, clearTimeout as cancel } from 'node:timers'
import { parseHTML } from 'linkedom'
import ts from 'typescript'

// Synthetic fixtures retain semantic structure, never copied user transcripts.
function harness(html, href, clock = null) {
  const { window, document } = parseHTML(html)
  // linkedom orders siblings but not nodes under different parents. Supply
  // the DOM-standard element ordering used by browsers, including wrappers.
  window.Element.prototype.compareDocumentPosition = function (other) {
    if (this === other) return 0
    if (this.contains(other)) return 20
    if (other.contains(this)) return 10
    const nodes = Array.from(this.ownerDocument.querySelectorAll('*'))
    const left = nodes.indexOf(this)
    const right = nodes.indexOf(other)
    return left < 0 || right < 0 ? 1 : left < right ? 4 : 2
  }
  const location = { href, origin: 'https://chatgpt.com' }
  const modules = new Map()
  const globals = {
    Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement, HTMLButtonElement: window.HTMLButtonElement,
    HTMLTimeElement: window.HTMLTimeElement ?? class {},
    MutationObserver: class { observe() {} disconnect() {} },
    document, window, location, URL, CSS: { escape: (value) => value },
    setTimeout: schedule, clearTimeout: cancel,
    ...(clock ? { Date: class extends Date { static now() { return clock.now } } } : {}),
  }
  window.innerHeight = 300
  window.setTimeout = (callback, ms) => schedule(() => { if (clock) clock.now += ms; callback() }, 1)
  window.clearTimeout = cancel
  window.requestAnimationFrame = (callback) => schedule(callback, 1)
  window.getComputedStyle = () => ({ overflowY: 'visible', flexDirection: 'column' })
  Object.defineProperty(document, 'scrollingElement', { value: null })
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 300 })
  function load(path) {
    if (modules.has(path)) return modules.get(path)
    const exports = {}
    modules.set(path, exports)
    const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    }).outputText
    runInNewContext(code, { ...globals, exports, require(name) {
      return load(`${posix.normalize(posix.join(posix.dirname(path), name))}.ts`)
    } }, { filename: path })
    return exports
  }
  return { document, window, location, load }
}

const paragraph = (text) => `<p data-d-component="text">${text}</p>`
function turn(index, { blank = false, rich = false, prefix = '', searchIndex = index, thoughtOnly = false } = {}) {
  const userId = `${prefix}user-${index}`
  const answerId = `${prefix}answer-${index}`
  const answer = blank ? '' : rich ? `
    ${paragraph('Answer with <span data-d-default-strong>emphasis</span>.')}
    <ul data-d-component="list"><li>${paragraph('First item')}</li><li>${paragraph('Second item')}</li><li><span data-d-component="popover-trigger">Citation-only list item</span></li></ul>
    <blockquote>${paragraph('Quotation')}</blockquote>
    <table><tbody><tr><th>${paragraph('Key')}</th><th>${paragraph('Value')}</th></tr><tr><td>${paragraph('A')}</td><td>${paragraph('B')}</td></tr></tbody></table>
    <pre><code class="language-js">let answer = 42;<span data-d-component="badge" data-d-hoverable>Code source UI</span></code></pre>
    <span data-d-component="popover-trigger">Citation UI<img src="https://example.test/favicon-large.png" width="64" height="64"></span>
    <span data-d-component="badge" data-d-hoverable>Detached citation UI</span><span data-d-component="badge">Visible badge text</span>
  ` : paragraph(`Unique final answer for question ${index}, with enough content to verify.`)
  return `<div data-turn-key="${userId}"><div data-content-search-turn-key="fallback-turn-${searchIndex}">
    <div data-talvt-turn-state="complete">
      <h4 class="sr-only">You said:</h4>
      <div data-chatgpt-search-unit-key="fallback-turn-${searchIndex}:0:user" data-chatgpt-search-message-ids="${userId}">
        <div data-content-search-unit-key="fallback-turn-${searchIndex}:0:user">
          <div data-user-message-bubble="true"><div dir="auto">Unique question ${index}, with enough content to verify.</div></div>
        </div><button>Copy question</button>
      </div>
      <div><button aria-expanded="true">Thought for 1m</button><div class="markdown">Expanded private thought UI</div></div>
      ${thoughtOnly ? `<div><span data-chatgpt-agent-turn-start></span><div><div data-fixture-activity-header>
        <button type="button"></button><span><span>Thought for 1m 44s</span></span>
      </div></div></div>` : `<div data-chatgpt-search-unit-key="fallback-turn-${searchIndex}:2:assistant" data-chatgpt-search-message-ids="${answerId} ${answerId}">
        <h4 data-conversation-role="assistant">ChatGPT said:</h4>
        <div data-chatgpt-selection-conversation-id="conversation-a" data-chatgpt-selection-message-id="${answerId}">
          <div data-markdown-text-style="assistant-message"><div data-dil-source-message-id="${answerId}">
            <div hidden>Hidden UI</div><div data-dil-message-id="${answerId}" dir="auto">${answer}</div>
          </div></div>
        </div><button aria-haspopup="menu" aria-label="更多操作">More</button>
      </div>`}
    </div>
  </div></div>`
}
const transcript = (turns, id = 'conversation-a') => `<div data-thread-user-message-navigation-content="true"><div data-thread-find-target="conversation">${turns}</div></div>`.replaceAll('data-chatgpt-selection-conversation-id="conversation-a"', `data-chatgpt-selection-conversation-id="${id}"`)
const html = `<html><body>
  <section data-app-shell-active-page="false"><main>${transcript(turn(9, { prefix: 'foreign-' }), 'other-conversation')}</main></section>
  <section data-app-shell-active-page="true"><main>${transcript(turn(0, { rich: true }) + turn(1))}</main></section>
</body></html>`
const native = harness(html, 'https://chatgpt.com/c/conversation-a')
const adapter = new (native.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)()
const original = adapter.extractConversation()
assert.equal(original.messages.length, 4)
assert.deepEqual(Array.from(original.messages, (m) => m.sourceMessageId), ['user-0', 'answer-0', 'user-1', 'answer-1'])
assert.ok(original.messages.every((m) => m.sourceOrder === undefined), 'Page-local search numbering is not native conversation order')
assert.match(original.messages[1].content, /- First item\n- Second item/)
assert.match(original.messages[1].content, /> Quotation/)
assert.match(original.messages[1].content, /Key\tValue\nA\tB/)
assert.match(original.messages[1].content, /```js\nlet answer = 42;\n```/)
assert.doesNotMatch(original.messages[1].content, /Thought|Citation UI|Detached citation UI|Code source UI|Citation-only|ChatGPT said|Hidden UI|More/)
assert.doesNotMatch(original.messages[1].content, /^-\s*$/m, 'Removing native citation UI must not leave an empty list marker in the saved display')
assert.match(original.messages[1].content,/Visible badge text/)
assert.equal(original.attachmentCandidates, undefined, 'Citation favicons must not become saved attachments')
assert.ok(adapter.getConversationObservationContainer().matches('main'))

const legacyDIL = harness(`<html><body><main>
  <section data-testid="conversation-turn-0" data-turn="user"><div data-message-author-role="user" data-message-id="legacy-user"><p>Fixture original question.</p></div></section>
  <section data-testid="conversation-turn-1" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="legacy-answer"><div class="markdown">
    <p data-d-component="text">Fixture visible answer. <span data-d-component="popover-trigger" role="button"><span data-d-component="box"><span data-d-component="badge">Fixture Source</span></span></span></p>
    <p data-d-component="text">Keep the <a href="https://example.test/article">ordinary body link</a>.</p>
  </div></div></section>
</main></body></html>`, 'https://chatgpt.com/c/conversation-a')
const legacyDILCapture = new (legacyDIL.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)().extractConversation()
assert.equal(legacyDILCapture.messages.length,2)
assert.match(legacyDILCapture.messages[1].content,/Fixture visible answer/)
assert.match(legacyDILCapture.messages[1].content,/ordinary body link/)
assert.doesNotMatch(legacyDILCapture.messages[1].content,/Fixture Source/,'Legacy DIL roots exclude native citation badges just like search roots')

const imageCredit = harness(`<html><body><main>${transcript(turn(0).replace(
  paragraph('Unique final answer for question 0, with enough content to verify.'),
  `${paragraph('Answer with an illustrated reference.')}
  <div data-d-component="image" class="group/search-image">
    <img src="https://example.test/reference.png" alt="Reference illustration" width="640" height="480">
    <div class="pointer-events-none absolute"><a class="button-link" href="https://overlay-source.example.test/article"><span>overlay-source.example.test</span><img src="https://example.test/source-favicon.png" width="64" height="64"></a></div>
    <figcaption>Keep this image description.</figcaption>
    <a href="https://example.test/ordinary-image-link">Keep this ordinary image link.</a>
  </div>
  ${paragraph('Keep this ordinary body link: <a href="https://overlay-source.example.test/article">overlay-source.example.test</a>.')}
  <div class="pointer-events-none absolute"><a class="button-link" href="https://example.test/body">Keep this body link outside images.</a></div>`
))}</main></body></html>`, 'https://chatgpt.com/c/conversation-a')
const creditedCapture = new (imageCredit.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)().extractConversation()
assert.equal((creditedCapture.messages[1].content.match(/overlay-source\.example\.test/g) ?? []).length, 1, 'Only the native image-source overlay disappears; an identical domain in body text remains')
assert.match(creditedCapture.messages[1].content,/Keep this image description/)
assert.match(creditedCapture.messages[1].content,/Keep this ordinary image link/)
assert.match(creditedCapture.messages[1].content,/Keep this body link outside images/)
assert.equal(creditedCapture.attachmentCandidates.length,1,'Removing the source overlay preserves the real illustration and excludes its source favicon')
assert.equal(creditedCapture.attachmentCandidates[0].sourceUrl,'https://example.test/reference.png')

// Native overlay profile rows keep the name beside the empty menu button.
const profileRow = (name = 'Fixture Account', plan = 'Plus') => `<aside><div class="sidebar-item">
  <div><div><button class="absolute inset-0" aria-haspopup="menu" aria-label="Open profile"></button>
    <div class="pointer-events-none"><img alt="Profile picture" src="https://example.test/avatar.png">
      <div><span class="truncate text-default"><span class="truncate">${name}</span></span></div>
      <div><span class="truncate text-secondary">${plan}</span><button><span class="truncate">Upgrade plan</span></button></div>
    </div>
  </div></div>
</div></aside>`
const profile = harness(`<html><body>${profileRow()}<main>${transcript(turn(0))}</main></body></html>`, 'https://chatgpt.com/c/conversation-a')
const profileAdapter = new (profile.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)()
assert.equal(profileAdapter.getAccountLabel(), 'Fixture Account')
assert.equal(profileAdapter.extractConversation().accountIdentifier, 'Fixture Account')
profile.document.querySelector('.text-secondary').textContent = 'Free'
assert.equal(profileAdapter.getAccountLabel(), 'Fixture Account', 'Subscription and upgrade labels are never account names')
for (const invalid of [
  profileRow('Plus'), profileRow().replace('<img ', '<span ').replace('avatar.png">', 'avatar.png"></span>'),
  `<main>${profileRow()}</main>`, `<div hidden>${profileRow()}</div>`,
  profileRow().replace('<div class="pointer-events-none">', '<div class="pointer-events-none"><a href="/c/other">Other conversation</a>'),
  profileRow().replace('<div><span class="truncate text-default">', '<div><span class="truncate text-default">Different name</span><span class="truncate text-default">'),
]) {
  const test = harness(`<html><body>${invalid}</body></html>`, 'https://chatgpt.com/c/conversation-a')
  assert.equal(new (test.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)().getAccountLabel(), 'Unknown', 'Missing, hidden or ambiguous profile evidence fails closed')
}

// Resource cards have an empty preview button and a titled filename sibling.
// The type is adjacent text, so textContent alone would append it to the name.
const resourceCard = (name, url = '') => `<span class="group/resource-card relative">
  <button class="peer/resource-card absolute inset-0" type="button" aria-label="Preview file"></button>
  <span class="pointer-events-none"><span><span class="truncate" title="${name}">${name.replace('very long', '…')}</span><span>TXT</span></span></span>
  ${url ? `<a href="${url}">Download file</a>` : ''}
</span>`
function fileTurn({ fileOnly = false, downloadable = false } = {}) {
  return turn(0).replace('<div data-content-search-unit-key="fallback-turn-0:0:user">',
    `${resourceCard('very long upload name.txt', downloadable ? 'https://chatgpt.com/backend-api/files/rendered-fixture/download' : '')}<div data-content-search-unit-key="fallback-turn-0:0:user">`)
    .replace('Unique question 0, with enough content to verify.', fileOnly ? '' : 'Question about uploaded file')
    .replace(paragraph('Unique final answer for question 0, with enough content to verify.'),
      `${paragraph('Final answer')}${resourceCard('answer.txt')}`)
}
for (const fileOnly of [false, true]) for (const downloadable of [false, true]) for (const isShare of [false, true]) {
  const href = isShare ? 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'https://chatgpt.com/c/conversation-a'
  const test = harness(`<html><body><main>${transcript(fileTurn({ fileOnly, downloadable }), href.split('/').at(-1))}</main></body></html>`, href)
  const fileAdapter = isShare ? new (test.load('src/adapters/chatgpt/chatgpt-share-adapter.ts').ChatGPTShareAdapter)()
    : new (test.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)()
  const extracted = fileAdapter.extractConversation()
  assert.equal(extracted.messages.length, 2, 'A file-only question cannot disappear')
  assert.deepEqual(Array.from(extracted.messages[0].attachmentNames), ['very long upload name.txt'])
  assert.deepEqual(Array.from(extracted.messages[1].attachmentNames), ['answer.txt'])
  const files = Array.from(extracted.attachmentCandidates)
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'very long upload name.txt', 'Use the full title, not ellipsized display text or filename plus type')
  assert.equal(files[0].messageIndex, 0)
  assert.equal(files[0].sourceTurnId, 'user-0')
  assert.equal(files[0].sourceUrl !== null, downloadable, 'Preview controls never manufacture a download URL')
  assert.equal(files[1].messageIndex, 1, 'Assistant files stay attached to the answer')
  assert.equal(files[1].sourceTurnId, 'answer-0')
}

const unnamedImage = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="image" width="100" height="100">'
const imageFixture=harness(`<html><body><main>${transcript(turn(0).replace('Unique question 0, with enough content to verify.',`Question about image${unnamedImage}`).replace(paragraph('Unique final answer for question 0, with enough content to verify.'),`${paragraph('Answer with image')}${unnamedImage}`))}</main></body></html>`,'https://chatgpt.com/c/conversation-a')
const imageAdapter=new (imageFixture.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)()
const imageSnapshot=imageAdapter.extractConversation()
assert.equal(imageSnapshot.attachmentCandidates.length,2)
assert.equal(imageSnapshot.attachmentCandidates[1].name,'image-1.png')
for(const candidate of imageSnapshot.attachmentCandidates) assert.ok(imageSnapshot.messages[candidate.messageIndex].attachmentNames.includes(candidate.name),'Anonymous image candidate names must match the evidence on their exact native message')
assert.equal(imageSnapshot.attachmentCandidates[0].name,imageSnapshot.attachmentCandidates[1].name,'Anonymous image numbering restarts per message, so another mounted message cannot rename an attachment')

// Layout class names and redundant response markers can change independently.
for (const element of native.document.querySelectorAll('[class]:not(code)')) element.setAttribute('class', 'unrelated-new-layout')
for (const element of native.document.querySelectorAll('[data-markdown-text-style]')) element.removeAttribute('data-markdown-text-style')
for (const element of native.document.querySelectorAll('[data-user-message-bubble]')) element.removeAttribute('data-user-message-bubble')
for (const element of native.document.querySelectorAll('[data-dil-source-message-id]')) {
  const wrapper = native.document.createElement('section')
  element.replaceWith(wrapper)
  wrapper.append(element)
}
assert.deepEqual(JSON.parse(JSON.stringify(adapter.getMessages())), JSON.parse(JSON.stringify(original.messages)), 'Semantic fallback must survive class and wrapper changes')
for (const element of native.document.querySelectorAll('[data-dil-source-message-id], [data-dil-message-id]')) {
  element.removeAttribute('data-dil-source-message-id')
  element.removeAttribute('data-dil-message-id')
}
assert.deepEqual(JSON.parse(JSON.stringify(adapter.getMessages())), JSON.parse(JSON.stringify(original.messages)), 'Selection-message identities can locate answers after DIL content markers change')
native.location.href = 'https://chatgpt.com/c/other-conversation'
assert.equal(adapter.getConversationContainer(), null, 'An inactive page must not be relabeled with the current URL')

const shareUrl = 'https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const viewer = harness(`<html><body><main>${transcript(turn(0, { rich: true, searchIndex: 3 }) + turn(1, { searchIndex: 4 }), shareUrl.split('/').at(-1))}</main></body></html>`, shareUrl)
const shareAdapter = new (viewer.load('src/adapters/chatgpt/chatgpt-share-adapter.ts').ChatGPTShareAdapter)()
const shared = shareAdapter.extractConversation()
assert.deepEqual(Array.from(shared.messages, (m) => m.sourceOrder), [6, 7, 8, 9])
const nativeIdViewer = harness(`<html><body><main>${transcript(turn(0) + turn(1), 'native-id-distinct-from-share')}</main></body></html>`, shareUrl)
const nativeIdAdapter = new (nativeIdViewer.load('src/adapters/chatgpt/chatgpt-share-adapter.ts').ChatGPTShareAdapter)()
assert.equal(nativeIdAdapter.extractConversation().messages.length, 4, 'Public transcript IDs need not match the share URL ID')
nativeIdViewer.document.querySelector('main').innerHTML = transcript(turn(0), 'replaced-native-id')
assert.equal(nativeIdAdapter.extractConversation(), null, 'A changed transcript identity must never be mixed into an existing scan')
const mixedViewer = harness(`<html><body><main>${transcript(turn(0), 'one')}${transcript(turn(1), 'two')}</main></body></html>`, shareUrl)
assert.equal(new (mixedViewer.load('src/adapters/chatgpt/chatgpt-share-adapter.ts').ChatGPTShareAdapter)().extractConversation(), null)
const binding = native.load('src/shared/share-capture.ts')
assert.equal(binding.findShareAnchor(original.messages, shared.messages).length, 4, 'Share identity uses messages even when conversation IDs and search indexes differ')
const supplemented = binding.supplementConversationMessages(original.messages, shared.messages)
assert.deepEqual(Array.from(supplemented, (m) => m.sourceMessageId), ['user-0', 'answer-0', 'user-1', 'answer-1'])
assert.ok(supplemented.every((m) => m.sourceOrder === undefined))
const sparse = [original.messages[0], original.messages[1], { ...original.messages[3], content: 'Newer local edited answer', sentAt: 60_000 }]
const filled = binding.supplementConversationMessages(sparse, shared.messages)
assert.equal(filled.length, 4)
assert.equal(filled[3].content, 'Newer local edited answer')
assert.equal(filled[3].sentAt, 60_000)
const previouslyNumbered = original.messages.map((m, index) => ({ ...m, sourceOrder: index }))
assert.deepEqual(Array.from(binding.supplementConversationMessages(previouslyNumbered, shared.messages), (m) => m.sourceMessageId), ['user-0', 'answer-0', 'user-1', 'answer-1'])
assert.ok(binding.supplementConversationMessages(previouslyNumbered, shared.messages).every((m) => m.sourceOrder === undefined), 'A previous share save cannot make new public indexes overwrite another native message')
const repeatedText = shared.messages.map((m) => ({ ...m, sourceMessageId: `other-${m.sourceMessageId}`, sourceTurnId: `other-${m.sourceTurnId}` }))
assert.equal(binding.findShareAnchor(original.messages, repeatedText), null, 'Conflicting message IDs cannot be authorized by equal titles or text')
assert.equal(binding.findShareAnchor(original.messages, [...repeatedText, ...shared.messages]).incoming, 4, 'Message identity resolves repeated question and answer text')

// The live paired renderer places a completed thought label beside an empty
// overlay button. A thought-only completed turn has no assistant unit at all;
// it is different from an empty final-answer placeholder still awaiting DOM.
function pairedEmptyFixture() {
  const clock = { now: 0 }
  const env = harness(`<html><body><main>${transcript(turn(0, { thoughtOnly: true }) + turn(1), 'native-share-transcript')}</main></body></html>`, shareUrl, clock)
  const first = env.document.querySelector('[data-turn-key="user-0"]')
  const header = first.querySelector('[data-fixture-activity-header]')
  // The question/turn can be taller than the viewport. The concrete completed
  // native activity header is the evidence that must actually be visible.
  first.getBoundingClientRect = () => ({ top: -600, bottom: 100, height: 700 })
  header.getBoundingClientRect = () => ({ top: 70, bottom: 100, height: 30 })
  const instance = new (env.load('src/adapters/chatgpt/chatgpt-share-adapter.ts').ChatGPTShareAdapter)()
  return { ...env, clock, first, header, instance }
}
const completedActivity = pairedEmptyFixture()
assert.equal(completedActivity.instance.getMessages().length, 3)
assert.equal(completedActivity.instance.hasPendingRenderedTurns(), true)
assert.equal(completedActivity.instance.getVerifiedEmptySourceOrders().length, 0, 'A single observation cannot authorize a missing answer')
completedActivity.clock.now += 700
assert.equal(completedActivity.instance.getMessages().length, 3)
assert.deepEqual(Array.from(completedActivity.instance.getVerifiedEmptySourceOrders()), [1])
assert.equal(completedActivity.instance.hasPendingRenderedTurns(), false)
assert.ok(completedActivity.instance.getMessages().every((message) => !/Thought|private thought/.test(message.content)), 'Native thought UI must never become answer text')
assert.equal(completedActivity.instance.getSourceOrderTarget(1), completedActivity.header, 'Gap recovery must center the concrete completion header rather than the oversized question')

for (const label of ['思考了 1m 44s', '已思考 1m 44s']) {
  const localized = pairedEmptyFixture()
  localized.header.querySelector('span span').textContent = label
  localized.instance.getMessages()
  localized.clock.now += 700
  localized.instance.getMessages()
  assert.deepEqual(Array.from(localized.instance.getVerifiedEmptySourceOrders()), [1], 'Chinese completed activity labels use the same native proof')
}
for (const invalidate of [
  (env) => { env.header.querySelector('span span').textContent = 'Thinking for 1m' },
  (env) => { env.first.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'streaming') },
  (env) => { env.header.setAttribute('aria-busy', 'true') },
  (env) => { env.header.getBoundingClientRect = () => ({ top: 400, bottom: 430, height: 30 }) },
  (env) => { env.header.getBoundingClientRect = () => ({ top: 70, bottom: 70, height: 0 }) },
  (env) => { env.header.setAttribute('hidden', '') },
  (env) => { env.first.querySelector('[data-chatgpt-agent-turn-start]').remove() },
  (env) => { env.first.querySelector('[data-user-message-bubble]').textContent = '' },
  (env) => { env.first.querySelector('[data-talvt-turn-state]').insertAdjacentHTML('beforeend', '<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant"><div data-chatgpt-selection-message-id="empty-final-answer"><div data-markdown-text-style="assistant-message"></div></div></div>') },
]) {
  const unsafe = pairedEmptyFixture()
  invalidate(unsafe)
  unsafe.instance.getMessages()
  unsafe.clock.now += 700
  unsafe.instance.getMessages()
  assert.equal(unsafe.instance.getVerifiedEmptySourceOrders().length, 0, 'Busy, offscreen, incomplete, unmarked or placeholder answers cannot explain a gap')
}
completedActivity.first.querySelector('[data-talvt-turn-state]').insertAdjacentHTML('beforeend', '<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant"><div data-chatgpt-selection-message-id="late-answer"><div data-markdown-text-style="assistant-message"><p>The final answer arrived later.</p></div></div></div>')
assert.equal(completedActivity.instance.getMessages().length, 4)
assert.equal(completedActivity.instance.getVerifiedEmptySourceOrders().length, 0, 'A later final answer must revoke the earlier empty-slot proof')

// Exercise the real DOM adapter and collector together, including reverse
// flex scrolling, sticky endpoint rows, missing answers and order changes.
async function scan({ reverse = false, missing = false, renumber = false, pending = false, thoughtOnly = false, thoughtIndex = 0 } = {}) {
  const env = harness('<html><body><div id="scroller"><main><div data-thread-find-target="conversation"></div></main></div></body></html>', shareUrl, thoughtOnly ? { now: 0 } : null)
  const root = env.document.getElementById('scroller')
  const content = env.document.querySelector('[data-thread-find-target]')
  let position = 1_500
  const render = () => {
    const first = Math.floor(position / 300)
    const indexes = [...new Set([0, 7, first, Math.min(7, first + 1), Math.min(7, first + 2)])].sort((a, b) => a - b)
    content.innerHTML = transcript(indexes.filter((i) => !missing || i !== 3).map((i) => turn(i, { blank: pending && i === 7, thoughtOnly: thoughtOnly && i === thoughtIndex, searchIndex: renumber && position > 500 ? i + 1 : i })).join(''), shareUrl.split('/').at(-1))
    for (const row of content.querySelectorAll('[data-turn-key]')) {
      const index = Number(row.getAttribute('data-turn-key').split('-').at(-1))
      row.getBoundingClientRect = () => ({ top: index * 300 - position, bottom: (index + 1) * 300 - position, height: 300 })
      row.scrollIntoView = () => { position = Math.max(0, Math.min(2_100, index * 300)); render() }
      for (const unit of row.querySelectorAll('[data-chatgpt-search-unit-key], [data-content-search-unit-key]')) {
        unit.scrollIntoView = row.scrollIntoView
      }
      const header = row.querySelector('[data-fixture-activity-header]')
      if (header) {
        header.getBoundingClientRect = () => ({ top: index * 300 + 240 - position, bottom: index * 300 + 270 - position, height: 30 })
        header.scrollIntoView = () => { position = index * 300 + 105; render() }
      }
    }
  }
  for (const element of [root, content]) {
    Object.defineProperty(element, 'clientHeight', { value: 300 })
    Object.defineProperty(element, 'scrollHeight', { value: 2_400 })
    element.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 })
  }
  Object.defineProperty(root, 'scrollTop', {
    get: () => reverse ? position - 2_100 : position,
    set: (value) => { position = Math.max(0, Math.min(2_100, reverse ? value + 2_100 : value)); render() },
  })
  Object.defineProperty(content, 'scrollTop', { get: () => 0, set() {} })
  env.window.getComputedStyle = (element) => ({ overflowY: element === root ? 'auto' : 'visible', flexDirection: reverse && element === root ? 'column-reverse' : 'column' })
  render()
  const instance = new (env.load('src/adapters/chatgpt/chatgpt-share-adapter.ts').ChatGPTShareAdapter)()
  const result = await instance.collectShareConversation(async () => {}, () => {})
  return { result, position }
}
for (const reverse of [false, true]) {
  const { result, position } = await scan({ reverse })
  assert.equal(result.captureComplete, true)
  assert.equal(result.messages.length, 16)
  assert.deepEqual(Array.from(result.messages, (m) => m.sourceOrder), Array.from({ length: 16 }, (_, i) => i))
  assert.equal(position, 0, 'A successful scan finishes at the chronological top')
}
for (const flags of [{ missing: true }, { renumber: true }, { pending: true }]) {
  assert.equal((await scan(flags)).result.captureComplete, false, 'Missing or renumbered history cannot be certified')
}
for (const reverse of [false, true]) {
  const { result } = await scan({ reverse, thoughtOnly: true })
  assert.equal(result.captureComplete, true, 'A completed thought-only activity must not make a 15-message paired transcript look incomplete')
  assert.equal(result.messages.length, 15)
  assert.deepEqual(Array.from(result.captureSkippedSourceOrders), [1])
  assert.deepEqual(Array.from(result.messages, (message) => message.sourceOrder), [0, ...Array.from({ length: 14 }, (_, index) => index + 2)])
}
assert.equal((await scan({ thoughtOnly: true, missing: true })).result.captureComplete, false, 'A verified empty first answer cannot excuse another missing turn')
for (const reverse of [false, true]) {
  const { result } = await scan({ reverse, thoughtOnly: true, thoughtIndex: 3 })
  assert.equal(result.captureComplete, true, 'Verify a middle thought-only reply before its virtualized header unmounts')
  assert.equal(result.messages.length, 15)
  assert.deepEqual(Array.from(result.captureSkippedSourceOrders), [7])
}

// Reproduce a two-turn current conversation whose complete DOM stays mounted.
// Page-local search numbers must remain outside persisted message metadata,
// while native beginning/geometry evidence can prove a static full transcript.
async function staticCurrentConversation({ reverse = false, indexes = [0, 1], tailGap = 0, controller = true, frozen = false, blankLast = false } = {}) {
  const env = harness(`<html><body><div id="scroller"><main>${transcript(indexes.map(index => turn(index, { blank: blankLast && index === indexes.at(-1) })).join(''))}</main></div></body></html>`, 'https://chatgpt.com/c/conversation-a')
  const root = env.document.getElementById('scroller')
  const content = env.document.querySelector('[data-thread-find-target]')
  const firstIndex = Math.min(...indexes)
  const fullHeight = (Math.max(...indexes) - firstIndex + 1) * 600 + tailGap
  const maximum = fullHeight - 300
  let position = Math.min(450, maximum)
  for (const element of [root, content]) {
    Object.defineProperty(element, 'clientHeight', { value: 300 })
    Object.defineProperty(element, 'scrollHeight', { value: fullHeight })
    element.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 })
  }
  Object.defineProperty(root, 'scrollTop', {
    get: () => reverse ? position - maximum : position,
    set: value => { if (!frozen) position = Math.max(0, Math.min(maximum, reverse ? value + maximum : value)) },
  })
  Object.defineProperty(content, 'scrollTop', { get: () => 0, set() {} })
  env.window.getComputedStyle = element => ({ overflowY: controller && element === root ? 'auto' : 'visible', flexDirection: reverse && element === root ? 'column-reverse' : 'column' })
  for (const row of content.querySelectorAll('[data-turn-key]')) {
    const index = Number(row.getAttribute('data-turn-key').split('-').at(-1))
    const top = (index - firstIndex) * 600
    row.getBoundingClientRect = () => ({ top: top - position, bottom: top + 600 - position, height: 600 })
    row.scrollIntoView = ({ block }) => { if (!frozen) position = Math.max(0, Math.min(maximum, top + (block === 'end' ? 300 : 0))) }
  }
  const instance = new (env.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)()
  return { result: await instance.collectConversation(), position }
}
for (const reverse of [false, true]) {
  const { result, position } = await staticCurrentConversation({ reverse })
  assert.equal(result.messages.length, 4)
  assert.equal(result.captureComplete, true, 'A full static two-turn current conversation must not fail merely because rendered IDs never change during scrolling')
  assert.equal(position, 0, 'A verified static conversation must finish at its chronological top')
  assert.ok(result.messages.every(message => message.sourceOrder === undefined), 'Boundary proof must not persist page-local search indexes')
}
for (const flags of [{ indexes: [3, 4] }, { indexes: [0, 2] }, { tailGap: 1_200 }, { controller: false }, { frozen: true }, { blankLast: true }]) {
  assert.equal((await staticCurrentConversation(flags)).result.captureComplete, false, 'A middle window, missing paired turn, unseen suffix, fake wrapper or immovable root cannot be certified as complete')
}

// Optional private fixture validation reads only the supplied local file in
// memory; it reports counts, never bodies, IDs, bootstrap data or credentials.
if (process.argv[2]) {
  const env = harness(readFileSync(process.argv[2], 'utf8'), 'https://chatgpt.com/c/pending')
  const activeIds = [...new Set(Array.from(env.document.querySelectorAll('[data-app-shell-active-page="true"] [data-chatgpt-selection-conversation-id]'), (node) => node.getAttribute('data-chatgpt-selection-conversation-id')))]
  assert.equal(activeIds.length, 1)
  env.location.href = `https://chatgpt.com/c/${activeIds[0]}`
  const current = new (env.load('src/adapters/chatgpt/chatgpt-adapter.ts').ChatGPTAdapter)().extractConversation()
  assert.ok(current?.messages.length > 0)
  console.log(`Supplied HTML validation: ${current.messages.length} messages from the active conversation`)
}
console.log('ChatGPT semantic DOM verification passed: active identity, layout fallbacks, rich content, ID binding, paired thought-only slots, static two-turn boundaries, forward/reverse complete scans')
