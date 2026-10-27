import type { ChatMessage } from './models'

function messageIdentity(message: ChatMessage): string | null {
  const stable = message.sourceMessageId ?? message.sourceTurnId
  return stable === undefined || stable.trim() === ''
    ? null
    : `${message.role}\0${stable}`
}

function sameRenderedMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role || left.content !== right.content) {
    return false
  }
  const leftIdentity = messageIdentity(left)
  const rightIdentity = messageIdentity(right)
  return leftIdentity === null || rightIdentity === null || leftIdentity === rightIdentity
}

function boundaryOverlap(
  left: readonly ChatMessage[],
  right: readonly ChatMessage[],
): number {
  for (let size = Math.min(left.length, right.length); size >= 2; size -= 1) {
    const leftStart = left.length - size
    if (right.slice(0, size).every((message, index) =>
      sameRenderedMessage(message, left[leftStart + index]),
    )) {
      return size
    }
  }
  return left.length === right.length && left.every((message, index) =>
    sameRenderedMessage(message, right[index]),
  ) ? left.length : 0
}

function sourceOrderBounds(
  messages: readonly ChatMessage[],
): { minimum: number; maximum: number } | null {
  const orders = messages
    .map((message) => message.sourceOrder)
    .filter((order): order is number => order !== undefined && Number.isSafeInteger(order))
  return orders.length === messages.length && orders.length > 0
    ? { minimum: Math.min(...orders), maximum: Math.max(...orders) }
    : null
}

function sortedUniqueSourceOrders(
  messages: readonly ChatMessage[],
): number[] | null {
  if (sourceOrderBounds(messages) === null) {
    return null
  }
  return [...new Set(messages.map((message) => message.sourceOrder as number))]
    .sort((left, right) => left - right)
}

function sourceOrderGapBridgeKey(lower: number, upper: number): string {
  return `${lower}:${upper}`
}

/**
 * A host order is an ordering hint, not a promise that every integer is a
 * rendered user/assistant message. If one raw DOM window shows a one-slot hole
 * among at least four messages, or a larger hole with at least three ordered
 * messages on both sides, the virtualizer itself has shown that the two sides
 * are adjacent rendered history. This deliberately rejects a weak edge-only
 * or sticky overlap such as [4, 5, 11].
 */
export function getRenderedSourceOrderGapBridges(
  messages: readonly ChatMessage[],
): string[] {
  const orders = sortedUniqueSourceOrders(messages)
  if (orders === null) {
    return []
  }
  return orders.flatMap((upper, index) => {
    if (index === 0) {
      return []
    }
    const lower = orders[index - 1]
    const missingOrderCount = upper - lower - 1
    const hasStableNeighborhood =
      (missingOrderCount === 1 && orders.length >= 4) ||
      (index >= 3 && orders.length - index >= 3)
    return upper - lower > 1 && hasStableNeighborhood
      ? [sourceOrderGapBridgeKey(lower, upper)]
      : []
  })
}

export function haveContinuousRenderedWindows(
  previous: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  direction: 1 | -1,
  mergedMessageCount: number,
): boolean {
  if (previous.length === 0 || incoming.length === 0) {
    return false
  }
  const previousOrders = sourceOrderBounds(previous)
  const incomingOrders = sourceOrderBounds(incoming)
  if (previousOrders !== null && incomingOrders !== null) {
    const newlyDiscoveredOrders = incoming
      .map((message) => message.sourceOrder as number)
      .filter((order) => direction === 1
        ? order > previousOrders.maximum
        : order < previousOrders.minimum,
    )
    if (newlyDiscoveredOrders.length > 0) {
      const renderedGapBridges = new Set(
        getRenderedSourceOrderGapBridges(incoming),
      )
      if (direction === 1) {
        const firstNewOrder = Math.min(...newlyDiscoveredOrders)
        return firstNewOrder <= previousOrders.maximum + 1 ||
          renderedGapBridges.has(sourceOrderGapBridgeKey(
            previousOrders.maximum,
            firstNewOrder,
          ))
      }
      const lastNewOrder = Math.max(...newlyDiscoveredOrders)
      return lastNewOrder >= previousOrders.minimum - 1 ||
        renderedGapBridges.has(sourceOrderGapBridgeKey(
          lastNewOrder,
          previousOrders.minimum,
        ))
    }
  }
  const previousIdentities = new Set(
    previous
      .map(messageIdentity)
      .filter((identity): identity is string => identity !== null),
  )
  if (incoming.some((message) => {
    const identity = messageIdentity(message)
    return identity !== null && previousIdentities.has(identity)
  })) {
    return true
  }
  if (previousOrders !== null && incomingOrders !== null) {
    return incomingOrders.minimum <= previousOrders.maximum &&
      incomingOrders.maximum >= previousOrders.minimum
  }
  const overlap = direction === 1
    ? boundaryOverlap(previous, incoming)
    : boundaryOverlap(incoming, previous)
  if (overlap > 0) {
    return true
  }
  return mergedMessageCount === previous.length && incoming.every((message) =>
    previous.some((candidate) => sameRenderedMessage(candidate, message)),
  )
}

/**
 * Stable rendered order is optional. When every captured message has it,
 * reject a purported full history whose first visible order is already in the
 * middle or whose ordered sequence contains a hole.
 */
export function hasKnownSourceOrderGap(
  messages: readonly ChatMessage[],
  renderedGapBridges: ReadonlySet<string> = new Set(),
): boolean {
  const orders = sortedUniqueSourceOrders(messages)
  if (orders === null) {
    return false
  }
  if (orders[0] > 2) {
    return true
  }
  return orders.some((order, index) =>
    index > 0 &&
    order - orders[index - 1] > 1 &&
    !renderedGapBridges.has(sourceOrderGapBridgeKey(
      orders[index - 1],
      order,
    )),
  )
}

export function hasKnownSourceOrderPrefixGap(
  messages: readonly ChatMessage[],
): boolean {
  const bounds = sourceOrderBounds(messages)
  return bounds !== null && bounds.minimum > 2
}

export function hasKnownSourceOrderStart(
  messages: readonly ChatMessage[],
): boolean {
  const bounds = sourceOrderBounds(messages)
  return bounds !== null && bounds.minimum <= 2
}

export function hasCompleteScrollBoundaryEvidence(
  reachedBoundary: boolean,
  observedWindowChange: boolean,
  knownOrderStart: boolean,
  renderedHistorySpansTarget: boolean,
  allowStaticHistory: boolean,
): boolean {
  if (!reachedBoundary) {
    return false
  }
  if (observedWindowChange) {
    return true
  }
  return allowStaticHistory && knownOrderStart && renderedHistorySpansTarget
}

export function hasCompleteUnscrollableHistoryEvidence(
  continuous: boolean,
  knownOrderPrefixGap: boolean,
  renderedHistoryFits: boolean,
): boolean {
  return continuous && !knownOrderPrefixGap && renderedHistoryFits
}
