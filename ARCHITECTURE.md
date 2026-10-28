# AI Chat Memory Architecture

## System Architecture

AI Chat Memory is a local-only Chrome Extension built with Manifest V3. It has
five runtime surfaces across three independently built bundles:

1. **Content Script** — a small, framework-free TypeScript bundle running in
   Chrome's default isolated world on `chatgpt.com`, `gemini.google.com`, and
   `chat.deepseek.com`. It selects one site adapter, passively reads
   already-rendered conversation DOM, and owns the minimal floating launcher host.
2. **Background Service Worker** — the normal runtime component that reads or
   writes conversations, accounts, settings, and environment metadata in
   IndexedDB. It handles typed runtime messages and must remain correct after
   Chrome terminates and restarts it.
3. **Current-conversation Controller** — a compact React application. It runs as
   an extension-origin page inside a right-aligned fixed iframe opened from a closed
   Shadow DOM launcher, overlays the host site without resizing it, communicates with
   the service worker, and never opens IndexedDB directly. It shows only the current
   conversation's saved state, manual update, classification-only important mark,
   independent image/file permissions, a general Manager link, and a saved-conversation deep link to its
   Manager detail. The 34 px launcher defaults below the host page's top-right
   controls with one 58 px header-height of extra clearance, is draggable, snaps
   to a viewport edge, and restores itself after host-page SPA re-renders. It is
   hidden while the overlay is open and restored by the shared close path. The
   overlay's left border resizes it between 320 and 960 px and
   persists the preferred width in current-environment settings. Clicking outside
   the iframe closes it unless the user locks the panel. The toolbar Action can
   open the independent Manager.
4. **Manager Page** — a top-level extension tab containing the complete searchable
   conversation library, filters, cross-environment selector, detail view, readable
   Markdown/ZIP export, and settings. The toolbar Action and controller both open
   `manager.html`; management state is therefore independent of whichever AI website
   is currently active.
5. **Shared-directory Setup Page** — a top-level extension page opened only by
   an explicit user action. It invokes the system directory picker, stores the
   structured-clone directory handle in the environment store, and performs the
   initial local mirror.

The architecture deliberately contains no server, cloud synchronization,
telemetry, remote configuration, or remote code. An optional user-authorized
filesystem directory can mirror local data between Chromium environments on the
same machine; every environment owns a separate subdirectory.

Manager Settings links to the packaged, script-free `privacy.html` policy page.
It works offline and is not declared web-accessible. Its Chinese and English
policy text matches the public `PRIVACY.md`; build verification rejects drift.
The public contact channel remains pending until the maintainer establishes it.

Original project code is licensed under GPL-3.0-only. Settings also opens the
script-free `license.html` page with local license, attribution, dependency
notices and source-download links. During staging, the build snapshots only
reviewed source directories, root build/documentation inputs and the three
MIT-licensed runtime packages into `corresponding-source.zip`. Private plans,
research captures, profile data and machine configuration are excluded. The
source manifest binds file hashes to the package version and build ID. Build and
repackaging verification check the license materials and every source member
before publishing; no public repository URL is required to obtain that snapshot.

## Security Boundary

Each supported AI chat page is outside the extension's trusted data boundary. The content
script must therefore be passive, read-only, and fail closed:

- Run in Chrome's default isolated world; never inject into the main world.
- Read only the current URL and DOM rendered in the currently open page. A
  user-triggered ChatGPT or Gemini manual save—or the first local save caused by
  that user's trusted native pin click—may advance the conversation's own scroll
  container so that its virtual list renders additional DOM; it does not request
  remote data or enumerate another conversation.
  Explicit ChatGPT or Gemini share capture additionally permits one extension-created
  inactive tab for the exact manually supplied share URL. Its isolated-world
  content script may scroll and read rendered DOM solely for the source-bound
  capture task described below. No remote conversation enumeration is allowed.
- Never enumerate or call conversation APIs. Explicit ChatGPT or Gemini network-capture
  jobs may read only naturally returned exact-target responses using the restricted
  background debugger transport described below; no request replay or private API
  calls are allowed. The other permitted network path is
  the attachment reader: after the text-save gate succeeds, it may `fetch` a URL
  already rendered inside the current conversation to create a local image or an
  explicitly authorized file copy. Reads time out after eight seconds, stream
  through byte limits, never persist the source URL, and degrade to metadata only.
  `XMLHttpRequest`, `WebSocket`, `EventSource`, and `sendBeacon` remain forbidden.
- Never read cookies, authorization/session tokens, `localStorage`, or
  `sessionStorage` credentials.
- Never patch page APIs, navigation APIs, or JavaScript globals.
- Never click, type, or expand host-site menus. Navigation is permitted to
  the manually supplied URL in the extension-owned share capture tab, plus one
  controlled current-page reload for explicit network capture after its final
  synchronous composer-state check. Complete
  ChatGPT/Gemini capture scrolls the conversation's virtual-list container until
  its top remains stable.
  A successful scan stays at that verified top. The host sidebar retains its
  native styles and row positions; local saved state is displayed only in the
  extension UI, without injecting saved-state attributes or styles or scrolling
  sidebar rows.
- The only intentional page addition is one identified Shadow DOM host containing
  the user-requested launcher and extension-origin iframe. React never renders
  into the host site's document tree and capture never reads the launcher.
- Isolate every content-script entry point and callback with error handling.

A content-script failure may skip one local save or hide the launcher, but must
never interrupt the website. The launcher is not disguised and may be observable
by the site; no anti-detection behavior exists. All conversation data, account
labels, searches, logs, imports, and exports remain on the current machine. They
leave the current browser profile only when the user explicitly exports
JSON/Markdown/ZIP or authorizes a shared directory through the File System Access
picker.

## Data Flow

### Explicit exceptional capture (0.5.60)

When a network-save job fails content/completeness checks while its originating
document and branch remain bound, the coordinator disconnects the debugger and
closes its owned share tab before offering an owner-panel decision. A structurally
complete branch can provide normalized supported network messages with exact
rendered native-ID anchors; otherwise only validated rendered page messages are
eligible. Share candidates also require the source conversation's unique anchor.
No raw response or candidate text enters task-status persistence. The active
save lock prevents ordinary observations from writing while a decision is pending;
the collector cannot restart. Cancellation, deletion, navigation, branch change
and worker restart discard the transient candidate.

Only the originating extension panel can confirm, by job ID; its submitted
content is ignored. Confirmation rechecks readiness, document/branch identity
and exclusion/deletion ordering, then conservatively supplements existing local
text through a dedicated service. It never grants verified-network provenance,
copies new attachments or overwrites existing matching text. Newly retained
exceptional text carries `Conversation.pendingCapture` with its reason/source.
Metadata, local attachments and real source times survive. Manager, Markdown,
JSON import/export and the shared directory retain this state. Passive updates
cannot clear it. Complete recapture replaces provisional text; share completion
also requires coverage of every pending message. DOM shares pass the IDs actually
scanned before source-window merging, so an older public snapshot cannot borrow
unverified local messages as completeness evidence.

The current controller keeps its title/local statistics outside the scroll area,
capture settings and task results first, recent previews below, and a separate
fixed flex footer for visible capture, cancel, open-share and confirmation buttons.
The default width is 360 px; existing persisted user widths and drag resizing remain.

### Conversation capture and update (Phases 3–4)

```text
User opens a ChatGPT, Gemini, or DeepSeek conversation
  -> Content Script and Service Worker build IDs match a packaged completion marker
  -> Site adapter reads the rendered DOM (a complete ChatGPT/Gemini save may first
     sweep its current virtual-list scroll container in adaptive overlapping
     steps, bisect discontinuous steps, and wait for each rendered window)
  -> Settings allow capture only when global auto-save and this platform are enabled
  -> Optional first-collection gate requires rendered pinned evidence
  -> Content Script validates conversation identity and completeness
  -> text-only SAVE_CONVERSATION first enforces pin/exclusion policy
  -> optional bounded image/authorized-file read from rendered resource URLs
  -> stableSerialize({ title, messages, attachments? })
  -> SHA-256 contentHash
  -> chrome.runtime.sendMessage(SAVE_CONVERSATION)
  -> Background Service Worker
  -> ConversationService compares the stored contentHash
  -> IndexedDB INSERT, UPDATE, or no-op
  -> changed records emit CONVERSATION_UPDATED to open extension views
  -> the page observer sends a bounded live title/count/two-message preview to
     its own open overlay iframe
```

Adapters emit all recognized user and assistant message roots in DOM order. In
particular, a DeepSeek virtual-list item may contain the question and answer
together, and adjacent role roots mounted during a virtual-list update are
merged without duplication. ChatGPT additionally emits the host's stable turn
identity, message identity, and rendered numeric order. The content script keeps
a bounded page-local accumulation of observed windows, while the persistence
service joins stable sparse windows by identity/order and legacy windows through
contiguous role-and-full-content anchors. Attachment positions follow a stable
turn identity when available. An unanchored snapshot cannot overwrite saved
history, and an assistant-first snapshot cannot create a record or add messages;
this prevents a transient answer-only render from creating or replacing a
record.
The current paired-turn ChatGPT renderer uses semantic transcript, user-bubble,
search-unit and DIL response markers. Root selection rejects inactive SPA regions
and any conversation IDs inconsistent with the current route. Redundant content
markers tolerate layout-class and wrapper changes; headings carrying only a role
label are never treated as answer text. Each rendered message gets its own native
message identity for attachment positioning. Original-page extraction omits
`fallback-turn` numeric order because those search indexes are page-local.
For a static complete paired transcript, the original-page adapter can provide
a separate native-beginning proof: paired indexes start at zero without holes,
and every rendered pair contains a readable question and answer or independently
verified completed thought-only activity. The shared collector also requires a
real scroll controller, stable top/bottom boundaries, and first/last rendered
turns spanning that controller. It accepts that verified static sweep directly
at the top instead of asking an oversized edge turn to prove the bottom again.
These page-local indexes are never persisted as message order or used to join
original/share messages. Unknown middle windows and blank final-answer
placeholders remain incomplete.
Capture work is serialized. Each newly scheduled page snapshot increments a
page-local revision, and an older capture checks that revision again before its
text and attachment writes, so delayed attachment reads cannot overwrite a
newer rendered conversation.

Repeated windows preserve a candidate's readable rendered image when an exact
matching candidate later contains metadata only. Attachment capture prefers the
latest rendered URL for duplicate resources, and a valid rendered image remains
the fallback when the resource cannot be read as an allowed image. Image
permissions are checked on every capture, so enabling them after a text-only
save can supplement the same local attachment without losing existing data.
ChatGPT's rendered `images.openai.com` resources are included in the exact image
host permissions and host-to-resource validation, so the extension reader can
copy them when the page's canvas or fetch is restricted by cross-origin rules.

The observer is page-local update detection, not synchronization. A saved
conversation is only rechecked when the user opens it again. The sole remote
tab-opening exception is an explicit user-supplied ChatGPT or Gemini share-capture job;
automatic capture never opens or enumerates remote conversations.

### Gemini network capture (0.5.74)

The same explicit-task coordinator and sole debugger transport serve Gemini.
Current-page mode binds the original account slot, rendered account hash,
document and branch revision before one synchronously checked reload. Share
mode owns one tab for the manually supplied canonical share. A public Google
short link can first be expanded by a bounded credential-free GET, discarding
the body and rejecting destinations other than a canonical Gemini share.
This public-link resolver is the only additional fetch path.

The adapter recognizes only natural POST batchexecute responses for history
`hNvQHb` or public share `ujx1Bf`; request bodies and headers are never read.
Gemini can cancel an HTTP-200 response after delivering the data, so the
transport joins the buffered prefix and streamed byte chunks before fatal
UTF-8 decoding. The adapter still requires complete length-framed JSON;
arbitrary loading failures cannot authorize saving. Unsupported Chrome stream
commands fail closed and suggest upgrading or choosing DOM capture.

History proof requires one exact native conversation ID, unambiguous selected
candidates, matching selected-parent links, a unique root, one connected branch
and an observed terminal cursor (or a complete share snapshot bound to its route
ID). A share's final pair must uniquely match the original rendered page;
a shared ancestor alone cannot bind a divergent branch. DOM numeric indexes
never substitute for native identities. Every ordered
question and every assistant display/code block must agree before the worker
assigns native identities and attachment positions. Layout-only differences
in rich prompts retain the DOM text. Fenced and inline assistant code compare
separately without lossy prose normalization. Only supported static display
components are interpreted; hidden comments and action-query attributes are
discarded, and unknown components stop saving. The native app can omit older
action-only suggestion groups that the share viewer displays. A separate
presentation may omit only those entire known groups; ordinary body/code and
partially missing suggestion labels still fail comparison. Only the matching
rendered presentation is archived. Private numeric response fields
never become message timestamps.

Verified native identities can bind uniquely matching legacy DOM messages only
through a worker-owned argument rechecked against the latest stored text.
Permissions, attachments, source times and manual metadata remain local. Gemini
does not offer exceptional pending-candidate confirmation. Its controller has
four choices: current DOM, share DOM, current network, share network. Preferences have
Gemini-specific keys; existing ChatGPT keys/defaults remain compatible.

### ChatGPT network capture and saving

`chatgptCaptureMode` (`conversation` / `share`) and the new `chatgptSaveMethod`
(`dom` / `network`) are independent Manager defaults. Per-conversation overrides
use separate `capture-mode:chatgpt:<id>` and `save-method:chatgpt:<id>` entries in
the settings store. Old mode/link preferences are retained; missing methods
normalize to DOM. These choices never enter hashes, exports or directory mirrors.
An active task fixes both values and locks the corresponding controller buttons.
The current-conversation controller presents the four combinations as one tab
strip and uses one manual “滑动采集” action. The tab changes only the underlying
preferences that differ; unchanged dimensions retain default inheritance.
Both network combinations start an explicit save task from that action.
Terminal results are collapsed as history; active tasks and safety blockers
remain visible. The legacy probe operation stays isolated for regression and
cannot write text or attachments.

`network-capture-coordinator.ts` owns each task, transient target URL and document
tokens, and a conversation-wide save lock. The worker rejects ordinary
`SAVE_CONVERSATION` for that source while occupied, including other tabs. The
content client installs before the observer starts and obtains the lock before
any passive save. Local pauses also invalidate in-flight captures. A worker
restart fails unfinished jobs, verifies exact content-task ownership before
detaching or closing a leftover owned tab, and releases its lock. Only lightweight
status and anonymous counts enter the environment store, not bodies or URLs.
Other tabs of the same conversation share the pause but receive read-only task
status. They cannot validate against their own document and cancel the owner's
task; a prior terminal result also cannot hide another tab's active pause.
After the controlled reload, owner verification targets the rebound native
document ID as well as its isolated-world token.

`network-debug-session.ts` is the sole debugger API owner. The manifest requests
only `debugger` in addition to existing image hosts and uses Chrome 118 as the
candidate minimum. The command allowlist is `Page.enable`, `Page.getFrameTree`,
`Network.enable`, `Network.getResponseBody`, `Network.streamResourceContent`. No runtime-supplied commands, JS
execution, child sessions, request replay or authentication events are permitted.
ChatGPT adapter functions restrict response reads to GET/JSON for the exact
conversation/share endpoint; tab, main frame, loader and request ID must agree.
Requests from the old document are ignored until the authorized navigation.
Duplicate frame notifications for the same loader and URL do not count as a
second navigation; a genuinely new document still cancels the task.
The session enables 128 MiB/resource and 256 MiB total buffers and also enforces
decoded response limits. Raw bodies exist only in the callback's memory and are
parsed by the ChatGPT adapter into minimal messages and transient evidence.
Shape validation alone never proves completeness or authorizes persistence.
At most 128 requests including active body reads may be pending, and at most
four bodies may be read concurrently. Overflow fails the session once and
invalidates pending reads, even before asynchronous task cleanup completes.

Current-page launch checks draft text, selected/uploading attachments, editing,
generation and unknown states in the ChatGPT adapter. It registers listeners,
attaches and enables Network first, probes again, then asks the exact isolated
document token to recheck and reload synchronously. One new document may claim
the task; another refresh cancels it. Share mode creates an owned blank tab,
connects before navigation, and does not refresh the source. Task/route/branch
checks, explicit end/cancel, debugger detach, deletion and tab events clean up
the connection and lock. A short status retains its cause/action, with full
details available by hover, focus or click and dismissible by Escape.
Trusted native message submissions invalidate the branch revision alongside
response-navigation actions, even when the conversation URL stays unchanged.

`adapters/chatgpt/network-evidence.ts` checks request before/after cursors,
earliest/latest page markers, overlaps, retries, native IDs and current-node
identity. Mapping responses validate all parent/child edges and cycles, then
walk only the selected branch. Hidden, tool, thought and non-final channels are
omitted; every visible final fragment is retained, including non-end-turn nodes.
Unknown visible content and unfinished messages fail closed. Text/multimodal
text and code are supported; binary pointers only demand rendered attachment
evidence and never become fetch URLs. No private payload timestamp is retained.
Rendered native IDs, roles, order and presentation text are cross-checked;
list styles, citations, entity labels, combined answer roots and folded excerpts
are handled without replacing the saved Markdown with the shorter display.
For the known DIL v1 display format, only its declared `fallbackMarkdown` text
is read; layout code, constants, app data and other metadata are excluded. An
unknown display version fails explicitly. Native entity labels become plain
display text and opaque citation IDs are omitted outside literal code.
Known line/bar/area chart widgets become readable Markdown tables, with scalar
data and labels retained. Known DIL slider, segmented, radio and checkbox controls
are matched case-insensitively and require their actual rendered message plus static source anchors. Their
rendered values become the saved display text, with the static fallback retained
as `networkWidgetSource`; executable component configuration is never retained.
Known DIL row/text/card layouts also require a complete rendered scan: their
declared fallback can omit visible card values. When it differs, native identity,
role, order and static anchors must bind the rendered text before retaining both
the actual display and static source. Matching layouts retain network Markdown.
Only known component names outside literal code are accepted; unknown names fail
closed, including inside known wrappers. No layout expressions are executed.
Markdown table alignment rows and thematic separators affect neither display
matching nor the original Markdown saved by the network authority.

The worker queues start/commit/attachments with other data mutations; cancel
and status remain responsive. Only the exact rebound capture document can
commit. DOM `captureComplete` and numeric `sourceOrder` cannot authorize it.
`saveVerifiedNetworkConversation` receives a background-owned async authority
checked before preparation and again before writes. Share source anchors require
a unique question/answer pair; native-ID matching permits Markdown differences
only after the background cross-check. The supplementary merge preserves newer
local text. Existing genuine times, attachments and user metadata survive.
Verified messages carry `contentSource: 'network'`, assigned only by this
authority. Automatic DOM updates retain their full text and native fragments,
while allowing new messages to extend the known final turn. A different branch
requires a complete capture. An explicit complete DOM save can replace that
provenance; runtime captures cannot assert it themselves.

Text commits once, followed by a separate rendered attachment plan. The content
script retains URLs and binary fallbacks locally, sends only proof metadata,
copies permitted candidates and returns mapped attachments. The worker rereads
the latest record and permissions; `supplementVerifiedNetworkAttachments` only
adds attachments and never resubmits body text or resurrects a deleted record.
Success follows both stages; attachment failures report counts and retain text.
Partial attachment outcomes use a warning in both the notice and collapsed
history. Anonymous ChatGPT image numbering is local to each native message,
matching the rendered attachment-name evidence regardless of virtual windows.
The 100-candidate submission cap matches the accumulated scan/copy capacity;
the copy stage rejects overflow rather than silently dropping later images.
It is separate from stored-history import
validation (10,000 metadata entries under the existing 30 MiB binary cap), so
retained attachments accumulated across scans remain importable.
Cancellation after a text commit accurately reports the retained complete text.
Only status/counters are persisted as job state; evidence is cleared on exit.
Both DOM routes remain operational and never attach this transport.

### Gemini DOM share and current-page checks (0.5.75)

Gemini supports the same four page/method choices as ChatGPT. A DOM share job
uses the existing owned-tab lifecycle without a debugger or source reload.
Short-link expansion remains explicit and credential-free. Its adapter scans
rendered share turns with overlapping forward steps, requires alternating
question/answer slots from zero with no unexplained holes, and retains legacy
text aliases only in transient memory. Numeric indexes establish completeness
inside one document; all such IDs/orders are removed before a cross-page join.

The source worker reads the exact originating document and rendered account,
and binds its document token, branch revision and account slot. The final share
pair must uniquely match the source. Cancellation, refresh, account/branch
changes and source/share navigation revoke saving. Ordinary opened share tabs
still have no observer and cannot create share-identity records.

DOM text preserves fenced/inline code and omits hidden copy controls and
suggestion actions. The worker validates the exact expected DOM supplement,
then retains existing text through unique complete-window matches, rendered
legacy aliases or code-exact presentation comparisons. It never grants network
provenance. Only message IDs actually covered by the scanned share can clear
pending markers. Source account metadata, newer local text and binary copies
survive. A separate DOM authority is checked immediately before persistence.
An older share prefix and a newer source tail may join only when both rendered
windows have consecutive paired-slot evidence and their entire overlap matches
at one unique offset. The source head is rechecked before saving, so a new turn
submitted during the task revokes that task rather than saving a stale source.

Current-page Gemini sweeps now reject gaps in recognized numeric orders and
incomplete question/answer pairs even when the generic collector inferred a
bridge. Generation/editing must finish before a complete sweep; a newly observed
unfinished response invalidates the running result. Cancellation and destroyed/replaced observer generations invalidate
the running sweep. Legacy attachments follow unique complete role/text matches
when older history is prepended; ambiguous positions stop a full replacement
and retain the existing record.

### Manual ChatGPT share capture (DOM saving)

`chatgptCaptureMode` defaults to `conversation`; `share` applies only to manual
complete saves. It is the Manager default, not a prerequisite for starting a
share job. The current-conversation overlay reads/writes an independent local
override through `GET_CONVERSATION_CAPTURE_MODE` / `SET_CONVERSATION_CAPTURE_MODE`.
Effective mode is the override or the app default; an absent preference follows
the app default and highlights its corresponding mode button. The overlay offers
only `conversation` and `share`, with no separate default/reset choice. It
disables selection during capture and guards async
read/write results across native conversation navigation. Selecting a mode
never starts a job. The overlay uses combined page/method tabs, while Manager
keeps its two independent default controls. Valid explicitly pasted URLs use an independent
local `share-link:chatgpt:<native-id>` settings entry via
`GET_CONVERSATION_SHARE_LINK` / `SET_CONVERSATION_SHARE_LINK`. They survive panel
reopening and navigation, do not enter conversation exports or directory mirrors,
and are removed by clearing application data. Same-context notifications do not
reset an input; link revisions protect it from older preference reads.
The original `/c/<id>` content script sends `SHARE_CAPTURE`
with its rendered question/answer anchor and the user-supplied HTTPS share URL.
If full DOM extraction yields no snapshot, the observer uses a previously
rendered page-local window, message-only DOM extraction, or the source's local
saved messages in that order. Metadata comes from the originating adapter or
saved title, never the share's account identity. It pauses passive writes before
the local read and rechecks cancellation/navigation afterward. An empty current
DOM therefore does not block a source that already has verifiable local history;
no messages in any source still fails before a capture tab is created.
The worker creates `about:blank` with `active: false`, persists its task/tab IDs,
then navigates that owned tab to the normalized URL. Queued initial blank-page
updates are ignored until the authorized share loads or claims the tab;
subsequent navigation away still revokes it. The worker asks the exact source
document for its current context using `tabs.sendMessage` with `documentId`
before starting, reading a source result or authorizing supplementation. This
avoids using a stale initial sender URL as the current SPA conversation identity.
Source origin, frame, build, current URL and conversation ID must all agree.
Claim, progress and finish
messages must match the task, tab, document and URL. Share routes install only
the task reader, never a passive observer or launcher. An authorized task shows
a small isolated progress controller with a return-to-source button; ordinary
user-opened share pages install no capture UI and do not create records.

`ChatGPTShareAdapter` reuses ChatGPT extraction and
`collectConversationByScrolling` with overlapping forward steps. Public viewers
may keep distant first/last turns mounted; each intermediate numeric order must
therefore be a saved message or a separately verified visible native non-message
renderer. Completed thought disclosures and blank output nodes remain outside
message text. Their DOM must be in the viewport, stable across a settle round,
and without busy evidence before their source order may explain a gap. Scanning
tracks changing scroll height and root replacement, verifies both boundaries,
and fails closed on unexplained holes or lost conversation identity.
Paired share turns map their rendered search index to separate question/answer
slots within that page. Duplicate slots or changed indexes for the same message
invalidate completeness. Generic scroll geometry supports `column-reverse`
controllers with negative `scrollTop`. A stable empty DIL root alone does not
prove an empty answer; missing answer slots keep the scan incomplete.
The current paired renderer may instead finish a thought-only activity without
creating any final-answer unit. Its native `data-chatgpt-agent-turn-start` activity
header has an empty overlay button and a sibling completed-thought duration
label. That label may explain the paired answer slot only with a rendered
question, a native completed-turn ancestor, no final-answer renderer or busy
evidence, and a positive-sized label inside the viewport that remains stable
across a settle round. Gap recovery centers this label, so a long question need
not fit inside the viewport. A later answer, placeholder, unfinished state or
contradictory activity label revokes the earlier empty-slot proof. Thought text
and its duration remain outside saved answers and message-time metadata.
The visible public transcript may expose its original native conversation ID,
which is distinct from the share URL ID. The share adapter binds that single
rendered identity and rejects mixed or replaced transcripts; the original-page
adapter continues to require an exact current-conversation ID match.

Five-second progress heartbeats keep an active job responsive. Scanning first
attempts the hidden page without an elapsed-time foreground requirement. An
empty page after a background loading grace period or an incomplete scan that
was hidden reports `needs-foreground`; the user chooses “打开分享采集页继续” to
activate the same tab. The overlay presents that pause with an amber notice and
a prominent “打开分享采集页继续” action; its instructions require keeping the
capture page visible until completion. Repeated visibility interruptions can pause and retry
that same job without turning the pause into a failed save. A scan that stays
visible and remains incomplete still fails closed. Count changes also report
progress immediately. Counts and the scan estimate never decrease during
retries. Both controllers use a left-anchored, slowly widening fill, with no
looping translation. Progress estimates scroll coverage and capture stages;
the message total remains unknown until verified completion. The scan estimate
stays at or below 85, advances to 95 after completeness/identity checks, and
reaches 100 only after a confirmed save.
The overlay restores task controls and terminal results on reopening and polls
only while a capture is active. The capture page receives ready/terminal status
notifications, so a completed scroll explicitly shows the save stage. Save
failures preserve their cause in the task result. The worker holds the task URL,
source anchor and full result in memory; the task's IndexedDB record stores
status only, separate from the explicitly pasted link preference. Restarted workers safely
fail unfinished jobs rather than authorize stale snapshots. They close a tab
only with ownership or a matching task handshake, never solely a reused tab ID.

Before authorizing a save, the worker checks completeness, numeric order, URL
and a unique contiguous user/assistant text anchor against the original rendered
window or saved record. Shared message IDs disambiguate repeated text; conflicting
IDs cannot be authorized by equal text. Cross-page supplementation follows unique
message identities and their relative order, not the public conversation ID or
search numbering. Incompatible numeric orders are discarded rather than stored
as native order; ambiguous insertions or reordered identities reject the merge.
The original observer pauses passive writes throughout
this operation and uses its existing save/attachment queue. `supplementOnly`
is accepted only from the matching original document with a ready task. Existing
local text, source times, newer tail, binary attachments, title and pin state win;
original identity, permissions and manual labels remain intact. An ambiguous
mapping rejects the merge.
`supplementShareCapture` also merges attachment candidates seen on the original
page with the public snapshot before the save queue. Candidates are positioned
by role/message identity or a unique contiguous content anchor, never by a
page-local index alone. A rendered source URL takes precedence over a
metadata-only public card. The originating account label is refreshed after
the scan and the public page's Unknown label is never used for that record.
A verified save releases the task and closes its owned
tab. Cancellation, deletion, source/capture navigation or tab closure revoke
save authorization. No share dialog monitoring, native clicks, private APIs,
page bootstrap parsing, new host permissions or offscreen pages are involved.

ChatGPT answer-time capture is also passive and user-triggered. When the user
opens an answer's native More-actions menu, a five-second bounded observer reads
the platform's label from the Radix menu and uses `aria-labelledby` to resolve
the exact triggering `conversation-turn`. The extension never clicks menus.
Current labels expose minute precision only; `sentAtPrecision: "minute"` keeps
the detail UI from displaying fabricated seconds. Question turns are ignored.
Gemini's rendered conversation DOM does not currently expose source times, and
private generation-stream content is not treated as timestamp metadata.

The current-conversation overlay is event-driven while open. The Content Script
throttles DOM-change status/preview messages to the extension-origin iframe, and
the Service Worker notifies it after a changed IndexedDB write. It has no
continuous local-state polling. Open, focus, visibility restoration, and runtime
events refresh directly; only a pending/saving state that remains stuck for 10
seconds schedules one recovery read. Preview messages contain at most the last
two bounded rendered messages and pass the same fixed-origin/type validation as
manual-save messages.

The Content Script has one serialized current-page persistence queue. Passive
observation, explicit manual update, and native-pin first save differ only in
their capture policy before entering it; neither pin nor manual handling owns a
separate `SAVE_CONVERSATION` route. A trusted pin click on an unsaved current
conversation invalidates queued partial snapshots and installs a gate that
blocks DOM/title/scroll writes until the shared complete collector verifies both
boundaries. A failed complete scan never falls back to the partial window. An
already-saved conversation keeps the lightweight passive update path.

The initial text save intentionally precedes all attachment byte reads. A new
unpinned conversation, disabled platform, excluded conversation, or stale page
generation therefore cannot trigger file downloads. Images inherit the global
default unless a conversation stores an explicit on/off override. Ordinary files
are either globally disabled or explicitly authorized per conversation. The
important mark is never consulted for attachment policy. Existing-conversation
permission switches only persist that policy; an inline controller prompt asks
for a separate manual update, which is the only action that starts the complete
rendered-DOM sweep. Both attachment kinds have a configurable ceiling
up to a non-bypassable 10 MiB per item and a 30 MiB decoded total per conversation.
Only safe raster MIME types can be embedded as images. Unavailable and skipped
items retain bounded metadata without source URLs or binary data.
For a rendered card whose source URL is absent, Manager detail can explicitly
supplement its existing ordinary-file record from a user-selected same-named
local file. This is a local import action, not another host capture/network path.
`SUPPLEMENT_LOCAL_ATTACHMENT` requires a Manager sender, validates base64 MIME
and decoded size, and enters the existing serialized data-operation queue. It
reads the latest conversation and file settings, preserves attachment identity,
position, messages, permissions and labels, recomputes the content hash, mirrors
the local record, and notifies open detail views. The chooser rejects invalid or
oversized selections before reading bytes; the service checks policy, limits
and whether the target still exists again before writing. Navigating away before
the file read completes cancels that UI operation. Already saved attachments are
not overwritten, and later unavailable host metadata retains those saved bytes.
Manager text attachment previews read only the validated persisted base64 copy.
The UI recognizes TXT and Markdown filename extensions; Office files retain
their download flow. Native `TextDecoder` handles UTF-8/BOM detection, explicit
GB18030, and UTF-16 encodings. Source text is rendered as a React text child in
a scrollable `pre`, never HTML, a remote document, or a network resource. Visible
text is capped at 200,000 UTF-16 code units without splitting surrogate pairs;
the clipboard uses the entire decoded text and download uses original bytes.
The dialog traps keyboard focus and restores it on close. Preview selection is
scoped to the environment/conversation and resolves the latest saved attachment
by ID; changing detail routes remounts the page and closes its preview. No
attachment data, permissions, capture behavior, or message times are modified.
Known page chrome such as favicon and Apple touch-icon assets is rejected at the
candidate boundary before policy checks or byte reads.
Opaque resource-path IDs are not file names: an extensionless ID requires
independent native name, MIME, or rendered-size evidence before it can become a
candidate. Rendered image canvas fallbacks are cached by DOM image identity and
decoded dimensions so overlapping scan windows do not repeatedly encode the
same bitmap.

Gemini `lh3.googleusercontent.com/rd-gg/...=s512?authuser=...` resources redirect
through `lh3.google.com`. The Manifest grants that exact redirect host, but the
runtime request validator never accepts it as a page-supplied source. The reader
tries the same signed path with `=s0` first and falls back to the rendered size;
both reads remain MIME-, time-, item-, and conversation-bounded. Successful
bytes become an IndexedDB-persisted `dataUrl` immediately. Conversation-to-image
mapping therefore points only at the local attachment record, never at the
temporary Google URL.

ChatGPT ordinary-file candidates include rendered file-name/download attributes,
OpenAI content links, and same-origin `/backend-api/files/` or `estuary` links.
File-only turns remain message entries even without separate text. Candidate
resolution checks a rendered HTTPS `data-download-url` before an unusable
`sandbox:` href. This does not broaden capture to arbitrary anchors: the source
must still be rendered inside a recognized conversation turn and the ordinary
file policy must explicitly authorize its bounded read.

### Manager and controller data access

```text
React Page/Hook
  -> typed chrome.runtime.sendMessage
  -> Background Service Worker
  -> Conversation/Account/Settings data module
  -> IndexedDB
  -> typed response
  -> React state
```

Presentation components receive data and callbacks through props. They do not
access IndexedDB or Chrome runtime APIs directly.

### Optional shared-directory mirror

```text
Current environment IndexedDB write succeeds
  -> Background Service Worker checks the persisted directory handle permission
  -> current environment only writes environments/env-<its UUID>/...
  -> another environment scans metadata only
  -> user explicitly selects an environment
  -> selected files are size-limited, parsed, URL-checked, identity-checked,
     and content-hash-checked
  -> list merge keeps current-environment records on identity collisions
```

The library's environment filter narrows the explicitly selected display scope
before resolving duplicate conversation IDs. Environment-qualified account
selection likewise filters before merging, allowing the shared source copy to
remain accessible when a local copy exists. `LibraryView.filterAccounts` returns
each scoped environment's account metadata separately; identical account IDs do
not erase that environment's label. These options are independent of search,
pagination and account selection. Existing `LibraryView.accounts` retains its
ID-based union for Manager settings. Account data continues to use the existing
per-environment `accounts.json` mirror and never imports remote accounts into
the local IndexedDB account store.

The directory picker runs in a top-level extension page because the normal
panel may be embedded as a cross-origin iframe. Directory permission is never
requested passively. Other environments cannot be renamed or marked important
from the current environment. The Manager library's explicit, confirmed
`DELETE_SHARED_CONVERSATION` action can delete a selected environment's shared
copy with existing read/write permission. It first writes an immutable UUID
request under the target's `deletions/` directory, then removes all validated
legacy filenames for the canonical conversation identity and updates the count.
Pending requests hide matching records from shared list, detail, and export.
The source consumes requests at worker initialization, before normal runtime
data operations, and before full or per-conversation mirroring. Each local
deletion, pinned-only exclusion change, and request receipt commits atomically
using the existing environment store. Shared cleanup precedes request removal;
receipts survive retries and prevent a crash from deleting a later manual
restoration twice. Runtime data operations are serialized, and mirrors re-read
the current database record after consumption instead of writing stale arguments.
Missing directory permission postpones consumption until authorization returns.
Both environments require 0.5.35 or later to execute this protocol; an older
source can rewrite files but updated readers continue to hide pending deletions.

An explicit manual save uses a typed, local `postMessage`
bridge between the extension-origin iframe and its current host Content
Script. A trusted native pin action that owns a first local save joins the same
complete-collection function. For ChatGPT and Gemini, the Content Script first sweeps the current
virtual-list scroll container in adaptive overlapping steps, waits for each
rendered window, bisects any step whose next window has no stable identity,
source-order, or content continuity, and uses rendered edge turns to recover the
host's actual virtualizer when a scrollable wrapper does not change the message
window. ChatGPT's current `section[data-testid^="conversation-turn-"]` form is
explicitly supported, and candidates with computed vertical scrolling outrank
generic `main` geometry. A candidate that repeats an identical invalid rendered
state for several settle rounds is abandoned so another root or the rendered-edge
fallback can run; this is a no-progress condition, not a fixed total timeout or
message/step ceiling. A target cannot certify completeness from geometry alone until all
candidate scroll roots have been tried. A successful sweep remains at the
verified conversation top instead of remounting the original partial window.
When rendered numeric order is available, a remaining unexplained prefix or
middle hole fails the complete-capture gate. Numeric order is only an ordering
hint: hidden system/tool nodes, failed replies, and branches can make it sparse.
A raw stable DOM window with a sufficient neighborhood on both sides records
that native sparse bridge; a weak sticky edge cannot certify one. A stable top is held long enough for delayed
history batches, and a replaced host scroll root is discovered and continued
within the same capture. Replacing the observation container at the same URL
rebinds its observer and scroll listeners and invalidates queued passive windows
through the capture revision, without changing the conversation generation.
Only navigation or destruction changes that generation. All passive scheduling,
including title and sidebar updates, is paused while a complete collector owns
the page, so rebinding cannot enqueue a partial write or reset its saving state.
The same
identity checks, hashing, Service Worker message, and IndexedDB write then run
as automatic capture. It clears a pending automatic debounce and remains valid
across ordinary DOM settling in the same conversation, while navigation and
conversation identity still invalidate it. It re-reads the accumulated page
messages and fetches the local record through the Service Worker before
reporting success. The comparison uses role, content, stable identity when
available, and normalized attachment names, deliberately ignoring enriched
source timestamps. If the host still never renders the earliest question, the
bridge reports an incomplete page instead of a false update success; it cannot
open or request another conversation.

Readable export is also explicit and extension-local. A single conversation can
export all, earliest N, or latest N saved messages as Markdown. Environment and
all-environment export read only IndexedDB plus the already-authorized shared
directory, strip attachment `dataUrl` bytes, and create one Markdown file per
conversation inside an uncompressed ZIP. It does not call an AI model or generate
a summary. The existing version-1 JSON export remains the lossless local
conversation backup/import path and retains saved attachment data.

Pinned-only first collection is conservative and remains DOM-only. The gate
applies on all three platforms and cannot be bypassed merely because a platform
selector stops matching. ChatGPT and Gemini check already-rendered pinned-section,
pinned-row, icon, and unpin-action evidence. ChatGPT stops row traversal before
an ancestor containing another `/c/` link, so evidence from a pinned sibling
cannot admit the current unpinned conversation. Gemini recognizes both the current
`gem-nav-list-item[data-test-id="conversation"]` structure and its legacy
`.conversation`/`jslog` structure. Trusted native Pin clicks are resolved through
the composed event path, bound to the affected sidebar conversation ID, and
retried while Gemini's optional rename/confirmation UI settles. A non-current
conversation cannot be extracted until the user opens it because its messages
are not rendered; keyed evidence or the native pinned marker then admits capture.
DeepSeek currently exposes no stable native pin marker, so pinned-only mode fails
closed for its first automatic insertion and users can explicitly save the
rendered conversation. Once a conversation exists locally, automatic capture
updates it while global and platform auto-save are enabled, even if it is
currently unpinned. Manual capture bypasses only the first-collection restriction,
not identity or completeness validation.

Every capture request also carries the Content Script build ID. Before any
conversation write, the Service Worker requires that ID to match its own bundle
and re-reads the packaged `runtime-ready.json` marker with `no-store`. Missing,
partial, or mixed-version extension files fail closed before the pinned policy
or IndexedDB write can be bypassed. Chrome does not replace a statically injected
Content Script in an existing document during an extension reload, so an invalid
or stale page script removes the launcher, stops its observers, and displays a
notice with an explicit refresh button; it never refreshes the AI page itself.
The notice is compact, centers that action, and has a top-left close control that
only removes the notice for the current document. Dismissal does not restart capture.

Each saved record also carries the last observed boolean pin state. Native Pin
and Unpin actions update that metadata by platform/account/conversation identity;
normal captures reconcile the current page state without changing the content
timestamp. Gemini additionally checks the semantic trailing icon in
`gem-nav-list-item` rows rather than relying on an absolute child index.
That icon is accepted only inside the current conversation-ID-matched row. Pin
evidence traversal stops at `mat-nav-list`, `conversations-list`, or another
multi-row ancestor, so a sibling row's `push_pin` cannot admit an unpinned chat.

Gemini's `.conversation-container` represents one question-and-answer turn, not
the entire chat. Gemini can retain multiple matching history/scroller roots,
including an empty stale root. Its adapter ranks every surrounding `.chat-history`,
`infinite-scroller`, chat-window, and fallback root by rendered turn count and
then message-node count, selects the fullest root, and flattens all rendered turns
in document order. If every candidate is initially empty, observation falls back
to the main region. More generally, Gemini observes the surrounding main region
while extraction remains scoped to the selected fullest history; replacing or
populating a sibling history therefore still schedules extraction without merging
duplicate histories.

Deleting a local conversation checks its persisted pin state in the same IndexedDB
transaction. Pinned deletion writes a deterministic exclusion tombstone and removes
the conversation, so a concurrent debounce cannot recreate it. Unpinned deletion
removes the conversation and any obsolete tombstone without creating a new one.
Manual save and explicit JSON import remove matching exclusions; Settings also
exposes an explicit remove action.

## IndexedDB Schema

- **Database:** `AIChatMemoryDB`
- **Version:** `3`

### `conversations`

- `keyPath`: `id`
- Indexes: `updatedAt`, `createdAt`, `platform`, `accountId`, `conversationId`
- Compound index: `[platform, accountId]`
- Stores the last observed `pinned` state separately from the content hash

`id` is the SHA-256 digest of
`platform + "\0" + accountId + "\0" + conversationId`. The URL-derived
`conversationId` is retained separately. Existing conversations never receive a
random identifier.

### `conversationExclusions`

- `keyPath`: `id` (the same deterministic ID used by `conversations`)
- Stores platform, account ID, remote conversation ID, last title, and exclusion time
- Blocks automatic insertion and update until explicitly removed
- Is created by single-conversation deletion only when that record was last
  confirmed as pinned

### `accounts`

- `keyPath`: `id`
- Indexes: `platform`, `updatedAt`

Accounts are labels and filter values only. They are not parent stores or login
sessions. Detected account IDs hash both platform and identifier. ChatGPT always
uses its legacy `unknown` ID because its rendered profile control does not expose
a stable login identifier; UI strings such as plan names and avatar alt text must
never form a key. Other platforms use platform-scoped unknown IDs so missing
identities cannot collide. Gemini prefers a rendered email and falls back to the
active Google multi-login slot.

ChatGPT uses an explicit rendered email/name or the dedicated name node inside
the persistent bottom-left profile control only as a friendly label. The current
structural fallback accepts its `truncate`/marquee node even when the button test
ID is absent, but excludes main content and `/c/` conversation rows. The name
need not be inside the button: the current sidebar row's empty
profile-menu overlay is bound to its sibling dedicated name and avatar. The
plan and upgrade line is excluded, and ambiguous names fail closed. It does not
open the profile menu and rejects profile actions, avatar descriptions, and plan
names such as
`ChatGPT 打开个人资料`, `个人资料图片`, and `PLUS`. On startup, legacy ChatGPT accounts,
conversations, and exclusion tombstones are canonicalized to the single stable
key. Duplicate copies of one remote conversation are merged without losing the
important mark, file permission, or saved attachment data.
The same initialization phase converts the removed legacy `important-only` file
policy to `per-conversation`: conversations already marked important receive an
explicit file permission so their former effective access is preserved, while
all other conversation permissions and content timestamps remain unchanged.

### `settings`

- `keyPath`: `key`
- Application settings record:
  `{ key: "app", chatgptCaptureMode: "conversation", chatgptSaveMethod: "dom", autoSavePolicyVersion: 1, autoSave: true, autoSavePlatforms: ["chatgpt", "gemini", "deepseek"], autoSavePinnedOnly: true, saveImages: true, fileSavePolicy: "per-conversation", attachmentMaxSizeMb: 10, overlayPanelWidth: 420, visibleEnvironmentIds: [], accountTagColors: {}, environmentCardColors: {} }`
- Independent current-conversation capture preferences:
  `{ key: "capture-mode:chatgpt:<native-id>", mode: "conversation" | "share" }`.
  They can exist before a conversation is saved, do not alter content hashes,
  timestamps or attachment permissions, and are cleared with application data.
  They remain local to the browser profile and are not mirrored or exported.
- Independent current-conversation save-method preferences:
  `{ key: "save-method:chatgpt:<native-id>", method: "dom" | "network" }`.
  Missing preferences follow the Manager default, initially DOM. Updating a
  method never resets the existing capture-mode or share-link preference.
- Independent manually supplied share-link preferences:
  `{ key: "share-link:chatgpt:<native-id>", url: "https://chatgpt.com/share/<id>" }`.
  Only normalized valid links are stored; these are local settings, excluded from
  conversation exports and synchronization, and cleared with application data.

The two color maps contain only explicit selections from the fixed 16-token
palette. They are local Manager presentation settings: account tokens style only
account tags, environment tokens style whole cards only while at least one other
environment is selected, and equal tokens do not merge records.

### `environment`

- `keyPath`: `key`
- Stable local environment identity and human-readable label
- Optional structured-clone `FileSystemDirectoryHandle`

This store survives the in-app clear-data operation so the same environment
folder can be synchronized to an empty state. It is still isolated per browser
profile; the user grants each profile access to the same physical root.

Clearing all data clears conversations, exclusions, accounts, and application settings,
then recreates the default settings record. Environment identity and the
directory connection are retained.

## Data Models

```ts
type Platform = 'chatgpt' | 'gemini' | 'deepseek'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sentAt?: number
  sentAtPrecision?: 'minute' | 'second'
  attachmentNames?: string[]
}

interface Conversation {
  id: string
  platform: Platform
  accountId: string
  conversationId: string
  title: string
  url: string
  messages: ChatMessage[]
  attachments?: ConversationAttachment[]
  createdAt: number
  updatedAt: number
  messageCount: number
  contentHash: string
  important: boolean
  imageAttachmentPermission: boolean | null
  fileAttachmentPermission: boolean
}

interface ConversationAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  mimeType: string
  size: number | null
  status: 'saved' | 'confirmation-required' | 'not-saved' | 'too-large' | 'unavailable'
  dataUrl?: string
}

interface ConversationExclusion {
  id: string
  platform: Platform
  accountId: string
  conversationId: string
  title: string
  excludedAt: number
}

interface Account {
  id: string
  platform: Platform
  label: string
  source: 'detected' | 'manual' | 'unknown'
  createdAt: number
  updatedAt: number
}
```

`createdAt` is assigned on the first local save. `updatedAt` changes only when
the stable hash of `title`, `messages`, and persisted attachment state changes.
URL timestamps, current time, account labels, `important`, and per-conversation
attachment permissions never participate in `contentHash`. Toggling those local
controls therefore does not make a conversation look remotely updated, and later
captures preserve them. List responses strip attachment `dataUrl` fields; detail,
lossless JSON export, and an explicitly authorized shared-directory mirror retain
them. Readable Markdown/ZIP export strips the bytes and emits attachment names,
sizes, and states.

## Adapter Interface

```ts
interface AIAdapter {
  readonly platform: Platform
  isConversationPage(): boolean
  getConversationId(): string | null
  getConversationIdFromTarget(target: EventTarget | null): string | null
  getTitle(): string
  getMessages(): ChatMessage[]
  getAccountIdentifier(): string | null
  getAccountLabel(): string
  getConversationContainer(): Element | null
  getConversationObservationContainer(): Element | null
  getSidebarContainer(): Element | null
  supportsPinnedConversations(): boolean
  isPinActionTarget(target: EventTarget | null): boolean
  isCurrentConversationPinned(): boolean
  extractConversation(): ExtractedConversation | null
}
```

`BaseAdapter` contains safe query and normalization helpers. Site behavior lives
under `src/adapters/chatgpt/`, `src/adapters/gemini/`, and
`src/adapters/deepseek/`; selectors are centralized per adapter with conservative
fallbacks. Conversation services, the database, and Floating Panel contain no
site DOM selectors.

## Observation and Race Safety

The shared site observer:

- Prefer the conversation message container over permanent whole-body watching.
- Use a 1,500 ms restartable debounce during streaming output.
- Use only a temporary 500–1,000 ms low-frequency container lookup with a fixed
  maximum wait time.
- Detect SPA URL changes through mutations plus low-frequency URL comparison,
  without patching `history.pushState` or `history.replaceState`.
- Capture a generation token and conversation ID for each scheduled extraction.
- Check the conversation ID immediately before and after extraction.
- Discard work when the generation changed, IDs differ, the ID is missing, or no
  messages are present.

These guards prevent an extraction scheduled on Conversation A from saving DOM
belonging to Conversation B. Incomplete transition DOM is ignored rather than
allowed to overwrite a complete local record.

## Runtime Message Protocol

The floating-panel host waits for `REQUEST_LIVE_STATE` from the current
iframe's window and exact extension origin before sending context or live
state. This avoids targeting the initial `about:blank` document, which inherits
the chat host's origin. Close, reopen and destroy clear readiness; asynchronous
save responses remain bound to the original ready frame.

All request discriminants live in `src/shared/runtime-messages.ts`:

- `SAVE_CONVERSATION`
- `GET_CONVERSATIONS`
- `GET_CONVERSATION`
- `GET_SAVED_CONVERSATION`
- `HAS_SAVED_CONVERSATION`
- `SEARCH_CONVERSATIONS`
- `GET_STATS`
- `GET_STORAGE_USAGE`
- `DELETE_CONVERSATION`
- `GET_CONVERSATION_EXCLUSIONS`
- `REMOVE_CONVERSATION_EXCLUSION`
- `UPDATE_CONVERSATION_IMPORTANCE`
- `UPDATE_CONVERSATION_PINNED`
- `UPDATE_CONVERSATION_IMAGE_PERMISSION`
- `UPDATE_CONVERSATION_FILE_PERMISSION`
- `DELETE_ALL_DATA`
- `GET_SETTINGS`
- `UPDATE_SETTINGS`
- `GET_CONVERSATION_CAPTURE_MODE`
- `SET_CONVERSATION_CAPTURE_MODE`
- `GET_CONVERSATION_SAVE_METHOD`
- `SET_CONVERSATION_SAVE_METHOD`
- `NETWORK_CAPTURE`
- `GET_ACCOUNTS`
- `SYNC_DETECTED_ACCOUNT_LABEL`
- `UPDATE_ACCOUNT_LABEL`
- `EXPORT_DATA`
- `IMPORT_DATA`
- `GET_LIBRARY_VIEW`
- `GET_SHARED_DIRECTORY_STATUS`
- `GET_SHARED_CONVERSATION`
- `DELETE_SHARED_CONVERSATION`
- `GET_EXPORT_ENVIRONMENTS`
- `UPDATE_ENVIRONMENT_LABEL`
- `READ_REMOTE_IMAGE`

Requests form a discriminated union. Responses use one envelope:

```ts
type RuntimeResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RuntimeErrorCode; message: string } }
```

The service worker validates unknown messages, catches synchronous and
asynchronous errors, implements every declared handler, and never relies on an
in-memory cache for correctness.

## Vite Build Architecture

The extension is produced by three sequential builds coordinated by
`scripts/build-extension.mjs`:

1. `vite.config.ts` builds the embedded `panel.html`, independent `manager.html`,
   image reader, and directory-setup `storage.html` into a clean `.dist-build/`,
   and copies `public/manifest.json` plus `public/icons/` there.
2. `vite.content.config.ts` bundles `src/content/content-script.ts` and all of its
   dependencies into the single IIFE file `.dist-build/content/content-script.js` with
   `emptyOutDir: false`.
3. `vite.background.config.ts` bundles
   `src/background/service-worker.ts` into the ES module
   `.dist-build/background/service-worker.js` with `emptyOutDir: false`.

All verification runs against the staging tree. Only after it passes does the
coordinator remove the old completion marker, atomically replace individual
files, prune obsolete files, and publish the new marker last. It never removes
the live `dist/` directory, so Chrome cannot observe a deliberately empty
extension root. The marker-free publication window is intentionally unavailable
to capture even if an old Service Worker remains in memory.

The unpacked extension root is always `dist/`. Production does not load source
files, a Vite client, localhost, remote JavaScript, or bare imports from the
content-script bundle.

`panel.html` and the bounded `image-reader.html` are the only web-accessible HTML
resources and are restricted to the three supported chat origins. Manager and
storage setup remain top-level extension pages. Hashed internal JavaScript assets
are not declared as web-accessible resources.
