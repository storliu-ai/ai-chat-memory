import type { ChatMessage } from './models'

export type ConversationReconciliation =
  | {
      status: 'exact'
      pageMessageCount: number
      localMessageCount: number
    }
  | {
      status: 'local-history-suffix' | 'local-history-window'
      pageMessageCount: number
      localMessageCount: number
    }
  | {
      status: 'mismatch'
      pageMessageCount: number
      localMessageCount: number
    }

export interface ConversationMessageMergeResult {
  messages: ChatMessage[]
  /** Final zero-based position of the first previously saved message. */
  existingStartIndex: number | null
  /** Final zero-based position of the first currently rendered message. */
  incomingStartIndex: number | null
  status: 'incoming' | 'existing' | 'merged' | 'conflict'
}

function normalizeAttachmentNames(names: readonly string[] | undefined): string[] {
  return [...new Set(
    (names ?? [])
      .map((name) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase())
      .filter((name) => name !== ''),
  )].sort()
}

function areAttachmentNamesEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = normalizeAttachmentNames(left)
  const normalizedRight = normalizeAttachmentNames(right)
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((name, index) => name === normalizedRight[index])
  )
}

function getSourceIdentity(message: ChatMessage): string | null {
  if (typeof message.sourceTurnId === 'string' && message.sourceTurnId.trim() !== '') {
    return `turn:${message.sourceTurnId}:${message.role}`
  }
  if (typeof message.sourceMessageId === 'string' && message.sourceMessageId.trim() !== '') {
    return `message:${message.sourceMessageId}:${message.role}`
  }
  return null
}

export function hasStableMessageIdentity(message: ChatMessage): boolean {
  return getSourceIdentity(message) !== null
}

function hasStableSourceOrder(message: ChatMessage): boolean {
  return (
    hasStableMessageIdentity(message) &&
    message.sourceOrder !== undefined &&
    Number.isSafeInteger(message.sourceOrder) &&
    message.sourceOrder >= 0
  )
}

/**
 * Compare the stable identity exposed for a rendered message. Attachment cards
 * and source times can mount later, so they are deliberately not anchors.
 */
function areMessageIdentitiesEqual(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role) {
    return false
  }
  const leftIdentity = getSourceIdentity(left)
  const rightIdentity = getSourceIdentity(right)
  if (leftIdentity !== null && rightIdentity !== null) {
    return leftIdentity === rightIdentity
  }
  return left.content === right.content
}

/**
 * Compare the content exposed by the host page. Source timestamps are
 * intentionally ignored because they can be enriched after the first save.
 */
export function areMessagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return (
    areMessageIdentitiesEqual(left, right) &&
    left.content === right.content &&
    areAttachmentNamesEqual(left.attachmentNames, right.attachmentNames)
  )
}

function mergeMessageMetadata(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  const attachmentNames = [...new Map(
    [...(existing.attachmentNames ?? []), ...(incoming.attachmentNames ?? [])]
      .map((name) => [
        name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase(),
        name,
      ]),
  ).values()].filter((name) => name.trim() !== '')
  const merged: ChatMessage = {
    ...incoming,
    ...(attachmentNames.length > 0 ? { attachmentNames } : {}),
  }
  if (incoming.sourceTurnId === undefined && existing.sourceTurnId !== undefined) {
    merged.sourceTurnId = existing.sourceTurnId
  }
  if (incoming.sourceMessageId === undefined && existing.sourceMessageId !== undefined) {
    merged.sourceMessageId = existing.sourceMessageId
  }
  if (incoming.sourceOrder === undefined && existing.sourceOrder !== undefined) {
    merged.sourceOrder = existing.sourceOrder
  }
  if (incoming.sentAt === undefined && existing.sentAt !== undefined) {
    merged.sentAt = existing.sentAt
    if (existing.sentAtPrecision !== undefined) {
      merged.sentAtPrecision = existing.sentAtPrecision
    }
  }
  return merged
}

/**
 * A boundary-verified manual snapshot owns message presence and attachment
 * names, while stable source metadata already enriched locally may survive.
 */
export function mergeCompleteConversationMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const existingByIdentity = new Map<string, ChatMessage>()
  for (const message of existing) {
    const identity = getSourceIdentity(message)
    if (identity !== null) {
      existingByIdentity.set(identity, message)
    }
  }
  return incoming.map((message, index) => {
    const identity = getSourceIdentity(message)
    const positional = existing[index]
    const previous = identity === null
      ? positional !== undefined && areMessageIdentitiesEqual(positional, message)
        ? positional
        : undefined
      : existingByIdentity.get(identity)
    if (previous === undefined) {
      return { ...message }
    }
    const merged = mergeMessageMetadata(previous, message)
    delete merged.attachmentNames
    if (message.attachmentNames !== undefined && message.attachmentNames.length > 0) {
      merged.attachmentNames = [...message.attachmentNames]
    }
    return merged
  })
}

/** A rendered answer root can cover several verified native fragments. Update
 * known IDs without flattening those fragments or replacing full source text.
 * New messages may extend only the known final turn; a different branch needs
 * an explicit complete capture rather than an inferred union. */
export function mergeVerifiedNetworkUpdates(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ConversationMessageMergeResult {
  const unchanged: ConversationMessageMergeResult = { messages: [...existing], existingStartIndex: 0, incomingStartIndex: null, status: 'conflict' }
  const key = (message: ChatMessage): string | null => message.sourceMessageId ? `${message.role}\0${message.sourceMessageId}` : null
  const local = existing.map(key), rendered = incoming.map(key)
  if (local.includes(null) || rendered.includes(null) || new Set(local).size !== local.length || new Set(rendered).size !== rendered.length) return unchanged
  const positions = new Map(local.map((id, index) => [id, index]))
  const common = rendered.flatMap((id, index) => positions.has(id) ? [{ incoming: index, existing: positions.get(id)! }] : [])
  if (!common.length || common.some((entry, index) => index > 0 && entry.existing <= common[index - 1].existing)) return unchanged
  const last = common.at(-1)!
  if (rendered.slice(0, last.incoming + 1).some((id) => !positions.has(id))) return unchanged
  const extra = incoming.slice(last.incoming + 1)
  const lastUser = existing.findLastIndex((message) => message.role === 'user')
  if (extra.length && (last.existing < lastUser || last.existing < existing.length - 1 && existing[last.existing].role !== 'assistant')) return unchanged
  const byId = new Map(incoming.map((message) => [key(message), message]))
  const messages = existing.map((message) => {
    const next = byId.get(key(message))
    if (!next) return message
    const merged = mergeMessageMetadata(message, next)
    if (message.contentSource === 'network') {
      merged.content = message.content; merged.contentSource = 'network'
      if (message.networkWidgetSource !== undefined) merged.networkWidgetSource = message.networkWidgetSource
    }
    return merged
  })
  messages.push(...extra)
  return { messages, existingStartIndex: 0, incomingStartIndex: common[0].existing, status: extra.length ? 'merged' : 'existing' }
}

function overlayMessages(
  base: readonly ChatMessage[],
  overlay: readonly ChatMessage[],
  overlayStart: number,
): ChatMessage[] {
  const result = [...base]
  overlay.forEach((message, index) => {
    const resultIndex = overlayStart + index
    const previous = result[resultIndex]
    result[resultIndex] = previous !== undefined &&
      areMessageIdentitiesEqual(previous, message)
      ? mergeMessageMetadata(previous, message)
      : message
  })
  return result
}

function findSequenceStarts(
  needle: readonly ChatMessage[],
  haystack: readonly ChatMessage[],
): number[] {
  if (needle.length === 0 || needle.length > haystack.length) {
    return []
  }
  const starts: number[] = []
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((message, index) =>
      areMessageIdentitiesEqual(message, haystack[start + index]),
    )) {
      starts.push(start)
    }
  }
  return starts
}

function isStrongSingleMessageAnchor(
  message: ChatMessage,
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): boolean {
  if (message.content.trim().length < 16) {
    return false
  }
  const count = (messages: readonly ChatMessage[]): number => messages.filter(
    (candidate) => areMessageIdentitiesEqual(candidate, message),
  ).length
  return count(existing) === 1 && count(incoming) === 1
}

function findBoundaryOverlap(
  left: readonly ChatMessage[],
  right: readonly ChatMessage[],
): number {
  for (let size = Math.min(left.length, right.length); size > 0; size -= 1) {
    const leftStart = left.length - size
    const matches = right.slice(0, size).every((message, index) =>
      areMessageIdentitiesEqual(message, left[leftStart + index]),
    )
    if (
      matches &&
      (size > 1 || isStrongSingleMessageAnchor(right[0], left, right))
    ) {
      return size
    }
  }
  return 0
}

interface StableMessageEntry {
  message: ChatMessage
  source: 'existing' | 'incoming'
  index: number
}

/**
 * ChatGPT's virtual list can expose a sparse window such as turns 1, 2 and
 * 36–40. Once the host gives us a stable turn id and rendered order, those
 * windows can be joined without requiring a textual overlap. This is limited
 * to fully identified messages; legacy/content-only records continue through
 * the conservative overlap algorithm below.
 */
function mergeStableOrderedWindows(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ConversationMessageMergeResult | null {
  if (
    existing.some((message) => !hasStableSourceOrder(message)) ||
    incoming.some((message) => !hasStableSourceOrder(message))
  ) {
    return null
  }

  const entries = new Map<string, StableMessageEntry>()
  existing.forEach((message, index) => {
    const identity = getSourceIdentity(message)
    if (identity !== null) {
      entries.set(identity, { message, source: 'existing', index })
    }
  })
  incoming.forEach((message, index) => {
    const identity = getSourceIdentity(message)
    if (identity === null) {
      return
    }
    const previous = entries.get(identity)
    entries.set(identity, previous === undefined
      ? { message, source: 'incoming', index }
      : {
          message: mergeMessageMetadata(previous.message, message),
          source: previous.source === 'existing' ? 'existing' : 'incoming',
          index: previous.index,
        })
  })

  const ordered = [...entries.values()].sort((left, right) => {
    const orderDifference = (left.message.sourceOrder ?? 0) -
      (right.message.sourceOrder ?? 0)
    if (orderDifference !== 0) {
      return orderDifference
    }
    return left.index - right.index
  })
  const messages = ordered.map(({ message }) => message)
  const existingIdentities = new Set(
    existing.map(getSourceIdentity).filter((value): value is string => value !== null),
  )
  const incomingIdentities = new Set(
    incoming.map(getSourceIdentity).filter((value): value is string => value !== null),
  )
  const existingStartIndex = ordered.findIndex(({ message }) =>
    existingIdentities.has(getSourceIdentity(message) ?? ''),
  )
  const incomingStartIndex = ordered.findIndex(({ message }) =>
    incomingIdentities.has(getSourceIdentity(message) ?? ''),
  )
  const addedExisting = ordered.some(({ message }) => {
    const identity = getSourceIdentity(message)
    return identity !== null && existingIdentities.has(identity)
  })
  const addedIncoming = ordered.some(({ message }) => {
    const identity = getSourceIdentity(message)
    return identity !== null && incomingIdentities.has(identity)
  })
  const hasNewIncoming = ordered.some(({ message }) => {
    const identity = getSourceIdentity(message)
    return identity !== null && incomingIdentities.has(identity) &&
      !existingIdentities.has(identity)
  })
  const hasNewExisting = ordered.some(({ message }) => {
    const identity = getSourceIdentity(message)
    return identity !== null && existingIdentities.has(identity) &&
      !incomingIdentities.has(identity)
  })

  // Both arrays are known to be non-empty here. The two booleans above are
  // intentionally explicit: they make the status independent of which window
  // happened to be observed first.
  const status = hasNewIncoming && hasNewExisting
    ? 'merged'
    : hasNewIncoming
      ? 'incoming'
      : hasNewExisting
        ? 'existing'
        : 'existing'

  // `addedExisting`/`addedIncoming` document the invariant for future changes
  // and keep the start-index calculation easy to audit.
  if (!addedExisting || !addedIncoming || existingStartIndex < 0 || incomingStartIndex < 0) {
    return null
  }
  return {
    messages,
    existingStartIndex,
    incomingStartIndex,
    status,
  }
}

/**
 * Conservatively joins two rendered windows of the same conversation. Host
 * virtual lists can expose a prefix, middle window, or suffix at different
 * times. Only a full-message contiguous anchor is allowed to add history;
 * an unanchored snapshot keeps the existing record intact.
 */
export function mergeRenderedConversationMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ConversationMessageMergeResult {
  if (existing.length === 0) {
    return {
      messages: [...incoming],
      existingStartIndex: null,
      incomingStartIndex: 0,
      status: 'incoming',
    }
  }
  if (incoming.length === 0) {
    return {
      messages: [...existing],
      existingStartIndex: 0,
      incomingStartIndex: null,
      status: 'existing',
    }
  }

  const stableOrdered = mergeStableOrderedWindows(existing, incoming)
  if (stableOrdered !== null) {
    return stableOrdered
  }

  const incomingStarts = findSequenceStarts(incoming, existing)
  if (incomingStarts.length === 1) {
    const incomingStartIndex = incomingStarts[0]
    return {
      messages: overlayMessages(existing, incoming, incomingStartIndex),
      existingStartIndex: 0,
      incomingStartIndex,
      status: 'existing',
    }
  }

  const existingStarts = findSequenceStarts(existing, incoming)
  if (existingStarts.length === 1) {
    const existingStartIndex = existingStarts[0]
    return {
      messages: overlayMessages(incoming, existing, existingStartIndex),
      existingStartIndex,
      incomingStartIndex: 0,
      status: 'incoming',
    }
  }

  const appendOverlap = findBoundaryOverlap(existing, incoming)
  const prependOverlap = findBoundaryOverlap(incoming, existing)
  if (appendOverlap > prependOverlap) {
    const incomingStartIndex = existing.length - appendOverlap
    return {
      messages: overlayMessages(
        [...existing, ...incoming.slice(appendOverlap)],
        incoming,
        incomingStartIndex,
      ),
      existingStartIndex: 0,
      incomingStartIndex,
      status: 'merged',
    }
  }
  if (prependOverlap > appendOverlap) {
    const existingStartIndex = incoming.length - prependOverlap
    return {
      messages: overlayMessages(
        [...incoming, ...existing.slice(prependOverlap)],
        existing,
        existingStartIndex,
      ),
      existingStartIndex,
      incomingStartIndex: 0,
      status: 'merged',
    }
  }

  // A snapshot still anchored at the first saved message can authoritatively
  // update or extend that same history without deleting a longer local copy.
  if (
    incoming.length >= existing.length &&
    areMessageIdentitiesEqual(incoming[0], existing[0])
  ) {
    return {
      messages: overlayMessages(existing, incoming, 0),
      existingStartIndex: 0,
      incomingStartIndex: 0,
      status: 'incoming',
    }
  }

  return {
    messages: [...existing],
    existingStartIndex: 0,
    incomingStartIndex: null,
    status: 'conflict',
  }
}

export function isMessageSequenceSuffix(
  suffix: readonly ChatMessage[],
  messages: readonly ChatMessage[],
): boolean {
  if (suffix.length === 0 || suffix.length > messages.length) {
    return false
  }
  const start = messages.length - suffix.length
  return suffix.every((message, index) =>
    areMessagesEqual(message, messages[start + index]),
  )
}

export function startsWithAssistantMessage(messages: readonly ChatMessage[]): boolean {
  return messages[0]?.role === 'assistant'
}

/**
 * Checks whether the currently rendered page snapshot is present in local data.
 * A local record can be longer when the host virtualizes older or newer turns,
 * but the rendered snapshot must then be one complete contiguous local window.
 */
export function reconcileRenderedConversationMessages(
  pageMessages: readonly ChatMessage[],
  localMessages: readonly ChatMessage[],
): ConversationReconciliation {
  const pageMessageCount = pageMessages.length
  const localMessageCount = localMessages.length
  const mismatch = {
    status: 'mismatch' as const,
    pageMessageCount,
    localMessageCount,
  }

  if (pageMessageCount === 0 || localMessageCount === 0) {
    return mismatch
  }

  const starts = findSequenceStarts(pageMessages, localMessages).filter((start) =>
    pageMessages.every((message, index) =>
      areMessagesEqual(message, localMessages[start + index]),
    ),
  )
  if (starts.length !== 1) {
    return mismatch
  }
  if (pageMessageCount === localMessageCount && starts[0] === 0) {
    return {
      status: 'exact',
      pageMessageCount,
      localMessageCount,
    }
  }
  return {
    status: starts[0] + pageMessageCount === localMessageCount
      ? 'local-history-suffix'
      : 'local-history-window',
    pageMessageCount,
    localMessageCount,
  }
}
