const PIN_ACTION = /^(?:pin(?:\s+(?:(?:this|the)\s+)?(?:chat|conversation))?|push[-_\s]?pin|置[顶頂](?:聊天|对话|對話)?|固定(?:聊天|对话|對話)?)$/i
const PIN_ACTION_TOKEN = /(?:^|[-_\s])(?:pin(?:[-_\s]?(?:chat|conversation))?|push[-_\s]?pin)(?:[-_\s]|$)|置[顶頂]|固定(?:聊天|对话|對話)/i
const UNPIN_ACTION = /(?:un|remove)[-_\s]*pin|keep[-_\s]*off|取消置[顶頂]|解除置[顶頂]|取消固定|解除固定|已置[顶頂]/i
const PINNED_DESCRIPTOR = /(?:^|[-_\s])(?:pinned|unpin|is[-_\s]?pinned|keep[-_\s]?off)(?:[-_\s]|$)|已置[顶頂]|取消置[顶頂]|解除置[顶頂]|置[顶頂]对话|置[顶頂]對話|已固定|取消固定|解除固定/i
const NOT_PINNED_DESCRIPTOR = /(?:^|[-_\s])(?:unpinned|not[-_\s]?pinned)(?:[-_\s]|$)|未置[顶頂]|未固定/i
const PIN_ICON_DESCRIPTOR = /^(?:keep|keep[-_\s]?off|push[-_\s]?pin|pin|pinned)$/i

export function isUnpinActionDescriptor(value: string): boolean {
  return UNPIN_ACTION.test(value.trim())
}

export function isPinActionDescriptor(value: string): boolean {
  const normalized = value.trim()
  return (
    !isUnpinActionDescriptor(normalized) &&
    (PIN_ACTION.test(normalized) || PIN_ACTION_TOKEN.test(normalized))
  )
}

export function isPinnedDescriptor(value: string): boolean {
  const normalized = value.trim()
  return (
    !NOT_PINNED_DESCRIPTOR.test(normalized) &&
    PINNED_DESCRIPTOR.test(normalized)
  )
}

export function isPinIconDescriptor(value: string): boolean {
  return PIN_ICON_DESCRIPTOR.test(value.trim())
}
