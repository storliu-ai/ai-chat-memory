import type { CaptureBlocker } from '../../shared/network-capture'

const EDITOR = 'rich-textarea [role="textbox"][contenteditable="true"], .input-area textarea'
const GENERATING = 'button[aria-label*="Stop response" i], button[aria-label*="停止回答"], button[aria-label*="停止生成"], .stop-button, [data-test-id="stop-button"]'
const EDITING = 'user-query textarea, user-query [contenteditable="true"], .edit-query-container'
const ATTACHMENT = 'user-query-file-preview, user-query-file-carousel, .attachment-preview, .file-preview, [data-test-id*="upload-preview"], [role="progressbar"], button[aria-label*="Remove file" i], button[aria-label*="移除文件"], button[aria-label*="移除图片"]'
const BRANCH = 'button[aria-label*="next response" i], button[aria-label*="previous response" i], button[aria-label*="重新生成"], button[aria-label*="Regenerate" i], button[aria-label*="发送"], button[aria-label*="Send message" i], button.send-button, user-query button'
const active = (element: Element): boolean => !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'

export function isGeminiBranchAction(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(BRANCH) !== null
}
export function isGeminiConversationSubmission(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches('form') && !!target.querySelector(EDITOR)
}
export function hasGeminiUnfinishedResponse(): boolean {
  return [...document.querySelectorAll(`${GENERATING}, ${EDITING}`)].some(active)
}
export function getGeminiCaptureBlockers(busy = false): CaptureBlocker[] {
  const blockers: CaptureBlocker[] = busy ? ['busy'] : []
  if ([...document.querySelectorAll(GENERATING)].some(active)) blockers.push('generating')
  if ([...document.querySelectorAll(EDITING)].some(active)) blockers.push('editing')
  const editors = [...document.querySelectorAll(EDITOR)].filter(active)
  if (editors.length !== 1) return [...blockers, 'unknown']
  const editor = editors[0], region = editor.closest('input-area-v2, input-area') ?? editor.closest('.input-area-container, .input-area, form')
  const value = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent ?? ''
  if (value.replace(/[\u200B\uFEFF]/g, '').trim()) blockers.push('draft')
  if (!region || editor.getAttribute('aria-disabled') === 'true' || editor.hasAttribute('disabled')) blockers.push('unknown')
  if (region && ([...region.querySelectorAll(ATTACHMENT)].some(active) || [...region.querySelectorAll('input[type="file"]')].some((input) => (input as HTMLInputElement).files?.length) || !!editor.querySelector('img'))) blockers.push('attachment')
  return [...new Set(blockers)]
}
