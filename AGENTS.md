# AI Chat Memory Agent Guide

## Project scope

AI Chat Memory is a Manifest V3 Chrome extension built with TypeScript, React,
and Vite. It passively captures the currently open ChatGPT, Gemini, or DeepSeek
conversation and stores it in the current Chrome profile's IndexedDB database.

Read `README.md` for user-visible behavior and `ARCHITECTURE.md` before changing
capture, persistence, or cross-context messaging.

## Repository map

- `src/adapters/`: host-specific DOM extraction and platform behavior. Keep all
  ChatGPT, Gemini, and DeepSeek selectors here.
- `src/content/`: content-script orchestration, observation, and floating-panel
  integration. Do not add host selectors here.
- `src/background/`: Manifest V3 service worker and extension-level messaging.
- `src/services/`: storage, synchronization, attachment, and domain services.
- `src/panel/`: Manager and current-conversation React interfaces.
- `src/shared/`: cross-context types and shared utilities.
- `public/manifest.json`: source extension manifest.
- `scripts/`: build and repository verification scripts.
- `dist/`: generated, verified extension output. Never edit it by hand.

## Behavioral and privacy boundaries

- Read only conversation data already rendered in an open page. Passive capture
  stays on the current conversation. The explicit ChatGPT or Gemini share-capture action
  may open one extension-owned tab for the single share URL manually supplied
  by the user, scroll its rendered DOM, and supplement the originating record
  after identity and completeness checks. Never enumerate remote conversations,
  read credentials, scrape private APIs, automate host-page clicks, or upload
  analytics or logs. Sharing itself remains a manual host-page operation.
- Network reads are allowed for the bounded attachment-copy flow and for an
  explicitly started ChatGPT or Gemini network-capture task. The latter uses only the
  background `network-debug-session.ts` module, the exact target conversation or
  supplied share URL, and naturally returned responses. It must never call or
  replay private APIs, read authentication headers/cookies, or persist raw
  responses. Probe tasks validate response reading without saving. Explicit
  network-save tasks write only after background-owned pagination/tree evidence,
  exact document/branch identity, and rendered anchors pass verification;
  attachment copies require their separate rendered-candidate and permission gate.
  The user's explicit exceptional-save workflow additionally permits an
  originating-panel confirmation to retain safely identity-bound normalized
  candidate text as `pendingCapture`. It must not bypass document/branch checks,
  mark that content verified, replace existing matching text, or copy new
  attachments. Cancellation/restart discards unconfirmed candidates; only a
  complete recapture with actual pending-message coverage clears the marker.
  Current-page network tasks may
  perform one controlled reload only after a final synchronous draft, attachment,
  editing and generation check; ordinary capture never gains this permission.
- An explicitly supplied Gemini public short share URL may be expanded through
  a bounded credential-free GET. Discard its body and require a canonical Google
  share URL before attaching the exact owned capture tab. This is not permission
  to call private RPCs or enumerate shares. Gemini network saving requires the
  exact native conversation/selected-parent chain, a terminal history boundary,
  and full rendered prose/code evidence. Unsupported displays fail closed;
  Gemini does not support exceptional candidate confirmation.
- Gemini DOM shares use no debugger or source reload. Require complete paired
  DOM coverage and a unique share-head anchor in the originating document.
  Bind account, document token and branch revision; discard page-local message
  indexes before cross-page joins. Keep legacy text aliases transient, retain
  local text/attachments, and never grant network provenance to DOM results.
- Keep host-specific selectors and DOM interpretation inside the corresponding
  adapter. Shared orchestration and services must stay platform-neutral.
- Missing or ambiguous native pin evidence must fail closed for first-time
  pinned-only capture. Once a conversation is saved, normal content updates may
  continue according to settings.
- Store a per-message time only when the platform exposes a genuine source time.
  Never substitute capture, save, reload, import, or synchronization time.
  ChatGPT currently exposes assistant reply time only after the user opens that
  reply's native More-actions menu; preserve its minute precision and ignore
  question times. Text generated inside a Gemini answer and private response
  payloads are not message-time metadata.
- Preserve user data and unrelated worktree changes. Migrations must retain
  attachments, importance, permissions, exclusions, and manual labels.
- Do not commit copied page bootstrap data, full network responses, account
  tokens, cookies, email addresses, or other user secrets.
- Keep environment-vendor branding out of source, comments, public documentation
  and distributed assets. Run `npm run verify:repository` to check this boundary.
- Internal plans, audit reports and browser evidence in `doc/`, `docs/`, `plan/`,
  `plans/`, root implementation-plan files and `*.local` research are local-only.
  Never force-add ignored files or make builds depend on these private documents.
- Run `npm run verify:secrets` before publication. Use synthetic regression fixtures,
  never real account labels or captured conversations. Keep `.githooks/pre-commit`
  enabled with `npm run setup:git-hooks` after initializing Git. The owner must choose
  a repository-local public name and GitHub noreply email before committing; do not
  invent them, inherit a private global identity, or bypass the hook.
- Before every `git commit`, run `npm run verify:secrets` and manually review the
  actual staged content with `git diff --cached`, including added files, filenames,
  binary attachments, the commit message and author metadata. Reviewing only the
  working tree is insufficient; automated checks do not replace manual review.
- Never commit, push, publish or otherwise upload private user data: real captured
  conversations, account identifiers or personal email addresses, credentials,
  tokens, cookies, private share links, browser/profile data, exports, screenshots,
  logs or network captures containing private information. Use synthetic fixtures
  or thoroughly redacted examples; keep private originals local and ignored.
- If a privacy check fails or staged content is uncertain, remove or redact the
  affected staged material while preserving the user's local originals, then
  repeat automated and manual checks before committing. Never force-add private
  files, disable the pre-commit hook or use `--no-verify` to bypass these checks.

## Change workflow

- Use Node.js 22 and npm.
- Search with `rg`/`rg --files` and make source edits with `apply_patch`.
- Add or update a focused verification script when changing extraction or a
  regression-prone behavior.
- Before handing off a change, run at least:

  ```bash
  npm run typecheck
  npm run lint
  npm run build
  ```

  Run the relevant `verify:*` command directly while iterating when useful. The
  full build runs all repository verification scripts again.
- A rebuilt unpacked extension does not replace a content script already loaded
  in an open AI tab. Reload the extension and refresh those tabs when testing.
- Keep `README.md` and `README.en.md` aligned. Privacy disclosures belong in
  bilingual `PRIVACY.md` and the matching offline `public/privacy.html`; update
  both together and run `npm run verify:privacy`. Do not invent public repository
  URLs, author identities, contact channels, endorsements or approval claims.
- Original project code is GPL-3.0-only; preserve third-party notices and do not
  reintroduce commercial-approval restrictions. Builds must carry matching
  Corresponding Source, the full license, attribution and dependency notices.
  Update the reviewed source inputs and run `npm run verify:license` when changing
  packaging, licensing or runtime dependencies. Private documents remain excluded.
- Keep contribution, security and alternative-licensing policies factual. Do not
  claim private vulnerability reporting is enabled without checking it, imply GPL
  contributions grant non-GPL relicensing rights, or invent release history. Record
  evidenced version changes in `CHANGELOG.md` and retain public policy files in the
  reviewed Corresponding Source inputs.

## Versioning and packages

- For every distributable change, increment the version together in
  `package.json`, the root package entries in `package-lock.json`, and
  `public/manifest.json`. Do not reuse a previously distributed version.
- `npm run build` verifies and atomically publishes `dist/`, then creates the
  root archive `ai-chat-memory-<version>.zip`.
- Packaging validates the new archive before deleting older files that exactly
  match this project's versioned ZIP naming convention. A failed build or
  package must leave the last valid archive intact; unrelated ZIP files must
  never be removed.
- `npm run package` may repackage an already verified `dist/`. If a higher-version
  archive exists, fix the version rather than deleting or overwriting it through
  automation.
