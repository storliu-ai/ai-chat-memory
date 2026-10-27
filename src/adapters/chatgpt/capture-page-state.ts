import type { CaptureBlocker } from '../../shared/network-capture'

// Composer and transcript scopes stay here; orchestration never interprets host DOM.
const COMPOSER = '#prompt-textarea, [data-testid="composer-text-input"], form [role="textbox"][contenteditable="true"]'
const GENERATING = '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]'
const EDITING = '[data-testid="conversation-turn"] textarea, [data-testid^="conversation-turn-"] textarea, [data-testid="edit-message-input"], [data-testid^="conversation-turn-"] [contenteditable="true"]'
const PENDING_ATTACHMENT = '[data-testid*="attachment"], [data-testid*="upload"], [data-file-name], [data-filename], [role="progressbar"], button[aria-label*="Remove" i], button[aria-label*="移除"], button[aria-label*="删除附件"]'
const BRANCH_ACTION = '[data-testid="previous-response"], [data-testid="next-response"], button[aria-label="Previous response"], button[aria-label="Next response"], button[aria-label="上一个回答"], button[aria-label="下一个回答"], [data-testid="regenerate-response-button"]'

function active(element: Element): boolean {
  return !element.closest('[hidden], [inert], [aria-hidden="true"], [data-app-shell-active-page="false"]') &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
}

export function isChatGPTBranchAction(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(BRANCH_ACTION) !== null
}

export function isChatGPTConversationSubmission(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches('form') &&
    [...target.querySelectorAll(`${COMPOSER}, ${EDITING}`)].some(active)
}

/** Fail closed when a new renderer cannot be recognized. A focused empty input
 * is safe; a disabled/missing/ambiguous composer is not evidence of idleness. */
export function getChatGPTCaptureBlockers(captureBusy = false): CaptureBlocker[] {
  const blockers: CaptureBlocker[] = []
  if (captureBusy) blockers.push('busy')
  if ([...document.querySelectorAll(GENERATING)].some(active)) blockers.push('generating')
  if ([...document.querySelectorAll(EDITING)].some(active)) blockers.push('editing')
  const composers = [...document.querySelectorAll(COMPOSER)].filter(active)
  if (composers.length !== 1) return [...blockers, 'unknown']
  const composer = composers[0]
  const region = composer.closest('form, [data-testid="composer"], [data-type="unified-composer"]')
  const text = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.textContent ?? ''
  if (text.replace(/[\u200B\uFEFF]/g, '').trim()) blockers.push('draft')
  if (region) {
    if ([...region.querySelectorAll('input[type="file"]')].some((input) => (input as HTMLInputElement).files?.length)) blockers.push('attachment')
    if ([...region.querySelectorAll(PENDING_ATTACHMENT)].some(active) || [...composer.querySelectorAll('img, [data-type="file"], [data-type="image"]')].some(active)) blockers.push('attachment')
  } else blockers.push('unknown')
  if (composer.getAttribute('aria-disabled') === 'true' || composer.hasAttribute('disabled') || composer.getAttribute('contenteditable') === 'false') blockers.push('unknown')
  return [...new Set(blockers)]
}
