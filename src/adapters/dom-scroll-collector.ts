import type {
  ExtractedAttachmentCandidate,
  ExtractedConversation,
} from '../shared/models'
import {
  mergeRenderedConversationMessages,
} from '../shared/conversation-reconciliation'
import {
  getRenderedSourceOrderGapBridges,
  hasKnownSourceOrderGap,
  hasKnownSourceOrderPrefixGap,
  hasKnownSourceOrderStart,
  hasCompleteScrollBoundaryEvidence,
  hasCompleteUnscrollableHistoryEvidence,
  haveContinuousRenderedWindows,
} from '../shared/capture-continuity'

const COMPLETE_CAPTURE_SETTLE_MS = 120
const COMPLETE_CAPTURE_MAX_SETTLE_MS = 600
const COMPLETE_CAPTURE_BOUNDARY_SETTLE_MS = 1_000
const COMPLETE_CAPTURE_BOUNDARY_MAX_SETTLE_MS = 6_000
const COMPLETE_CAPTURE_STEP_RATIO = 0.82
const COMPLETE_CAPTURE_MAX_STEP_RATIO = 8
const COMPLETE_CAPTURE_RENDERED_COVERAGE_RATIO = 0.72
const COMPLETE_CAPTURE_MIN_RETRY_STEP_PX = 12
const COMPLETE_CAPTURE_MAX_IDLE_STEPS = 5
const COMPLETE_CAPTURE_MAX_STALLED_ROUNDS = 5
const COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS = 2
const COMPLETE_CAPTURE_CONTINUITY_RECOVERY_ROUNDS = 6

interface MessageMergeIndexes {
  messages: ExtractedConversation['messages']
  existingStartIndex: number | null
  incomingStartIndex: number | null
}

interface WindowCollectionProgress {
  count: number
  continuous: boolean
  knownOrderPrefixGap: boolean
  knownOrderStart: boolean
  windowSignature: string
}

interface ScrollSweepResult {
  reachedBoundary: boolean
  observedWindowChange: boolean
  knownOrderStart: boolean
}

export interface DomScrollCollectorOptions {
  container: Element
  getContainer?: () => Element | null
  conversationId: string
  getConversationId: () => string | null
  extractConversation: () => ExtractedConversation | null
  turnSelector: string
  onProgress?: (messageCount: number) => void
  onScanProgress?: (coverage: number) => void
  strategy?: 'adaptive' | 'overlapping-forward'
  beforeStep?: () => Promise<void>
  hasPendingRenderedTurns?: () => boolean
  getVerifiedEmptySourceOrders?: () => number[]
  getSourceOrderTarget?: (sourceOrder: number) => Element | null
  /** Adapter proof of a stable native beginning, without persisting page-local order. */
  hasKnownRenderedStart?: () => boolean
}

/** Public viewers can keep distant sticky turns mounted. A forward sweep uses
 * overlapping viewport steps and requires every numeric message order; sparse
 * raw DOM is never accepted as evidence that intermediate turns do not exist. */
async function collectConversationByForwardScrolling(options: DomScrollCollectorOptions): Promise<ExtractedConversation | null> {
  let collected: ExtractedConversation | null = null
  let container = options.container
  let target: Element | Window | null = null
  let bottomStableRounds = 0
  let stalledRounds = 0
  let lastCount = 0
  let boundaryVerified = false
  let orderConflict = false
  let lastWindowSignature = ''
  const ordersByIdentity = new Map<string, number>()
  const identitiesByOrder = new Map<number, string>()
  const recoveredOrders = new Set<number>()
  const current = (): boolean => options.getConversationId() === options.conversationId
  const collect = (): void => {
    const window = options.extractConversation()
    if (!window || window.conversationId !== options.conversationId) return
    lastWindowSignature = JSON.stringify(window.messages)
    for (const message of window.messages) {
      const identity = messageIdentity(message)
      const order = message.sourceOrder
      if (identity === null || order === undefined) continue
      if ((ordersByIdentity.has(identity) && ordersByIdentity.get(identity) !== order) ||
          (identitiesByOrder.has(order) && identitiesByOrder.get(order) !== identity)) orderConflict = true
      ordersByIdentity.set(identity, order)
      identitiesByOrder.set(order, identity)
    }
    collected = collected === null ? window : mergeExtractedConversations(collected, window) ?? collected
    if (collected.messages.length > 10_000 || (collected.attachmentCandidates?.length ?? 0) > 100) throw new Error('分享对话超出当前采集容量，未确认保存')
    if (collected.messages.length !== lastCount) {
      lastCount = collected.messages.length
      options.onProgress?.(lastCount)
    }
  }
  const settlePending = async (): Promise<void> => {
    if (options.hasPendingRenderedTurns?.()) {
      await waitForRender(container, 900, 1_500)
      collect()
    }
  }
  const recoverRenderedGaps = async (): Promise<void> => {
    // Verify missing slots while their native nodes are still mounted. Waiting
    // until the bottom loses middle-turn evidence in a virtualized transcript.
    const snapshot = collected as ExtractedConversation | null
    const covered = new Set([...(snapshot?.messages ?? []).map((message) => message.sourceOrder), ...(options.getVerifiedEmptySourceOrders?.() ?? [])])
    const numbered = [...covered].filter((order): order is number => Number.isSafeInteger(order) && order! >= 0 && order! <= 20_000)
    for (let order = covered.has(0) ? 0 : 1, end = Math.max(-1, ...numbered); order <= end && current(); order += 1) {
      if (covered.has(order) || recoveredOrders.has(order)) continue
      const node = options.getSourceOrderTarget?.(order)
      if (!node?.isConnected) continue
      recoveredOrders.add(order)
      await options.beforeStep?.()
      if (!current()) return
      node.scrollIntoView({ block: 'center', behavior: 'instant' })
      await waitForRender(container, 1_000, 6_000)
      collect()
      await settlePending()
    }
  }
  while (current()) {
    await options.beforeStep?.()
    if (!current()) break
    const latest = options.getContainer?.() ?? container
    if (latest !== container) { container = latest; target = null; bottomStableRounds = 0 }
    const selected = choosePrimaryScrollTarget(getScrollTargets(container, options.turnSelector), container, options.turnSelector)
    if (selected !== target) {
      target = selected
      if (target !== null) setScrollPosition(target, 0)
      await waitForRender(container, 1_000, 6_000)
      collect()
      await settlePending()
      await recoverRenderedGaps()
    }
    if (target === null) {
      collect()
      boundaryVerified = renderedHistoryFitsWithoutScrolling(container, options.turnSelector)
      break
    }
    const before = getScrollMetrics(target)
    const atBottom = before.top >= before.maximum - 1
    const countBefore = lastCount
    const signatureBefore = lastWindowSignature
    setScrollPosition(target, atBottom ? before.maximum : Math.min(before.maximum, before.top + Math.max(1, before.viewport * 0.65)))
    await waitForRender(container, atBottom ? 1_000 : 300, atBottom ? 6_000 : 1_500)
    collect()
    await settlePending()
    await recoverRenderedGaps()
    const after = getScrollMetrics(target)
    if (atBottom && after.top >= after.maximum - 1 && before.maximum === after.maximum && countBefore === lastCount && signatureBefore === lastWindowSignature && !options.hasPendingRenderedTurns?.()) bottomStableRounds += 1
    else bottomStableRounds = 0
    options.onScanProgress?.(after.maximum === 0 ? 1 : Math.min(1, (after.top + after.viewport) / (after.maximum + after.viewport)))
    if (bottomStableRounds >= 2) {
      // Viewport-sized steps can pass over a short native empty reply without
      // ever centering its renderer long enough to verify it. Revisit exact
      // adapter-supplied gap nodes before declaring the history incomplete.
      const snapshot = collected as ExtractedConversation | null
      const covered = new Set([...(snapshot?.messages ?? []).map((message) => message.sourceOrder), ...(options.getVerifiedEmptySourceOrders?.() ?? [])])
      const numbered = [...covered].filter((order): order is number => Number.isSafeInteger(order) && order! >= 0 && order! <= 20_000)
      let recovery: Element | null = null
      for (let order = covered.has(0) ? 0 : 1, end = Math.max(-1, ...numbered); order <= end; order += 1) {
        if (covered.has(order) || recoveredOrders.has(order)) continue
        const node = options.getSourceOrderTarget?.(order)
        if (node?.isConnected) { recoveredOrders.add(order); recovery = node; break }
      }
      if (recovery) {
        await options.beforeStep?.()
        if (!current()) break
        recovery.scrollIntoView({ block: 'center', behavior: 'instant' })
        await waitForRender(container, 1_000, 6_000)
        collect()
        await settlePending()
        bottomStableRounds = 0
        stalledRounds = 0
        continue
      }
      boundaryVerified = true
      break
    }
    if ((atBottom ? after.top >= after.maximum - 1 && before.maximum === after.maximum : after.top <= before.top) && countBefore === lastCount && signatureBefore === lastWindowSignature) stalledRounds += 1
    else stalledRounds = 0
    if (stalledRounds >= 5) break
  }
  if (current() && target !== null && boundaryVerified) {
    await options.beforeStep?.()
    setScrollPosition(target, 0)
    await waitForRender(container, 1_000, 6_000)
    collect()
    await settlePending()
    boundaryVerified = getScrollMetrics(target).top <= 1
  }
  const result = collected as ExtractedConversation | null
  if (result === null) return null
  const skipped = options.getVerifiedEmptySourceOrders?.() ?? []
  const messageOrders = result.messages.map((message) => message.sourceOrder)
  const orders = [...new Set([...messageOrders, ...skipped])].sort((left, right) => (left ?? -1) - (right ?? -1))
  const dense = !orderConflict && orders.every((order, index) => Number.isInteger(order) && (index === 0 ? order === 0 || order === 1 : order === orders[index - 1]! + 1))
  const complete = current() && boundaryVerified && dense && !options.hasPendingRenderedTurns?.() && result.messages[0]?.role === 'user'
  return { ...result, captureComplete: complete, ...(skipped.length ? { captureSkippedSourceOrders: skipped } : {}), ...(!complete ? { captureIncompleteReason: dense ? 'boundary' as const : 'gap' as const } : {}) }
}

function candidateKey(candidate: ExtractedAttachmentCandidate): string {
  return [
    candidate.kind,
    candidate.name.normalize('NFKC').trim().toLocaleLowerCase(),
    candidate.sourceUrl ?? '',
    candidate.sourceTurnId ?? '',
    String(candidate.messageIndex ?? -1),
  ].join('\0')
}

function remapCandidates(
  candidates: readonly ExtractedAttachmentCandidate[],
  finalMessages: ExtractedConversation['messages'],
  startIndex: number | null,
): ExtractedAttachmentCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.sourceTurnId !== undefined) {
      const finalIndex = finalMessages.findIndex(
        (message) => message.sourceTurnId === candidate.sourceTurnId,
      )
      if (finalIndex >= 0) {
        return { ...candidate, messageIndex: finalIndex }
      }
    }
    return candidate.messageIndex !== undefined && startIndex !== null
      ? { ...candidate, messageIndex: candidate.messageIndex + startIndex }
      : candidate
  })
}

export function mergeExtractedConversations(
  previous: ExtractedConversation,
  incoming: ExtractedConversation,
  direction: 1 | -1 = 1,
): ExtractedConversation | null {
  const merge = mergeRenderedConversationMessages(
    previous.messages,
    incoming.messages,
  )
  if (merge.status !== 'conflict') {
    return buildMergedConversation(previous, incoming, merge)
  }

  // Gemini has released versions where a virtual-list window exposes no
  // stable turn id and replaces the whole previous window. In that case
  // there is no textual anchor for the conservative shared reconciler. A
  // manual sweep still gives us an ordering signal: a forward pass discovers
  // later windows, and a reverse pass discovers earlier windows. Join only at
  // the boundary (or by a stable id when one is present); an unrelated
  // snapshot is never allowed to replace the accumulated copy.
  const fallback = mergeUnanchoredWindow(previous, incoming, direction)
  return fallback === null ? null : fallback
}

function buildMergedConversation(
  previous: ExtractedConversation,
  incoming: ExtractedConversation,
  merge: MessageMergeIndexes,
): ExtractedConversation {
  const candidates = [
    ...remapCandidates(
      previous.attachmentCandidates ?? [],
      merge.messages,
      merge.existingStartIndex,
    ),
    ...remapCandidates(
      incoming.attachmentCandidates ?? [],
      merge.messages,
      merge.incomingStartIndex,
    ),
  ]
  const candidatesByKey = new Map<string, ExtractedAttachmentCandidate>()
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    const previous = candidatesByKey.get(key)
    candidatesByKey.set(key, candidate.renderedDataUrl === undefined &&
      previous?.renderedDataUrl !== undefined
      ? { ...candidate, renderedDataUrl: previous.renderedDataUrl }
      : candidate)
  }
  const uniqueCandidates = [...candidatesByKey.values()]
  return {
    ...incoming,
    messages: merge.messages,
    ...(uniqueCandidates.length > 0
      ? { attachmentCandidates: uniqueCandidates }
      : {}),
    title: incoming.title.trim() === '' ? previous.title : incoming.title,
    url: incoming.url || previous.url,
    accountIdentifier: incoming.accountIdentifier ?? previous.accountIdentifier,
    accountLabel: incoming.accountLabel === 'Unknown'
      ? previous.accountLabel
      : incoming.accountLabel,
  }
}

function messageIdentity(message: ExtractedConversation['messages'][number]): string | null {
  const stable = message.sourceMessageId ?? message.sourceTurnId
  return stable === undefined || stable.trim() === ''
    ? null
    : `${message.role}\0${stable}`
}

function boundaryOverlap(
  left: ExtractedConversation['messages'],
  right: ExtractedConversation['messages'],
): number {
  const sameRenderedMessage = (
    first: ExtractedConversation['messages'][number],
    second: ExtractedConversation['messages'][number],
  ): boolean => {
    if (first.role !== second.role || first.content !== second.content) {
      return false
    }
    const firstIdentity = first.sourceMessageId ?? first.sourceTurnId
    const secondIdentity = second.sourceMessageId ?? second.sourceTurnId
    return firstIdentity === undefined || secondIdentity === undefined ||
      firstIdentity === secondIdentity
  }
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

function mergeUnanchoredWindow(
  previous: ExtractedConversation,
  incoming: ExtractedConversation,
  direction: 1 | -1,
): ExtractedConversation | null {
  const previousMessages = previous.messages
  const incomingMessages = incoming.messages
  if (previousMessages.length === 0 || incomingMessages.length === 0) {
    return previous
  }

  const previousIdentityIndexes = new Map<string, number>()
  previousMessages.forEach((message, index) => {
    const identity = messageIdentity(message)
    if (identity !== null && !previousIdentityIndexes.has(identity)) {
      previousIdentityIndexes.set(identity, index)
    }
  })
  const identityOverlap = incomingMessages.some((message) => {
    const identity = messageIdentity(message)
    return identity !== null && previousIdentityIndexes.has(identity)
  })
  const overlap = direction === 1
    ? boundaryOverlap(previousMessages, incomingMessages)
    : boundaryOverlap(incomingMessages, previousMessages)

  // Direction alone never proves continuity. A large adaptive scroll can
  // skip one or more virtual windows, so a disjoint snapshot must be retried
  // at a smaller distance instead of being concatenated into false history.
  if (!identityOverlap && overlap === 0) {
    return null
  }

  let messages: ExtractedConversation['messages']
  let previousStartIndex: number
  let incomingStartIndex: number
  if (direction === 1) {
    const append = overlap > 0 ? incomingMessages.slice(overlap) : incomingMessages
    const filtered = append.filter((message) => {
      const identity = messageIdentity(message)
      return identity === null || !previousIdentityIndexes.has(identity)
    })
    previousStartIndex = 0
    incomingStartIndex = previousMessages.length
    messages = [...previousMessages, ...filtered]
  } else {
    const prepend = overlap > 0
      ? incomingMessages.slice(0, incomingMessages.length - overlap)
      : incomingMessages
    const filtered = prepend.filter((message) => {
      const identity = messageIdentity(message)
      return identity === null || !previousIdentityIndexes.has(identity)
    })
    previousStartIndex = filtered.length
    incomingStartIndex = 0
    messages = [...filtered, ...previousMessages]
  }
  if (messages.length === previousMessages.length && overlap === 0 && !identityOverlap) {
    return null
  }
  const merge: MessageMergeIndexes = {
    messages,
    existingStartIndex: previousStartIndex,
    incomingStartIndex,
  }
  return buildMergedConversation(previous, incoming, merge)
}

function windowsAreContinuous(
  previous: ExtractedConversation,
  incoming: ExtractedConversation,
  direction: 1 | -1,
  merged: ExtractedConversation | null,
): boolean {
  if (merged === null) {
    return false
  }
  return haveContinuousRenderedWindows(
    previous.messages,
    incoming.messages,
    direction,
    merged.messages.length,
  )
}

function getScrollMetrics(target: Element | Window): {
  top: number
  maximum: number
  viewport: number
} {
  if (target === window) {
    const documentElement = document.documentElement
    const body = document.body
    const height = Math.max(
      documentElement?.scrollHeight ?? 0,
      body?.scrollHeight ?? 0,
    )
    const viewport = window.innerHeight || documentElement?.clientHeight || 1
    return {
      top: window.scrollY,
      maximum: Math.max(0, height - viewport),
      viewport,
    }
  }
  const element = target as Element
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
  return {
    top: Math.max(0, Math.min(maximum, isReverseScrollTarget(element) ? maximum + element.scrollTop : element.scrollTop)),
    maximum,
    viewport: Math.max(1, element.clientHeight),
  }
}

function isReverseScrollTarget(element: Element): boolean {
  try { return window.getComputedStyle(element).flexDirection === 'column-reverse' }
  catch { return false }
}

function getScrollTargets(
  container: Element,
  turnSelector: string,
): Array<Element | Window> {
  const candidates: Array<Element | Window> = []
  const append = (candidate: Element | Window): void => {
    if (!candidates.includes(candidate) && getScrollMetrics(candidate).maximum > 0) {
      candidates.push(candidate)
    }
  }

  // The adapter normally returns the host's history scroller. Keep it first,
  // then inspect scrollable descendants because Gemini has also shipped a
  // wrapper where `chat-window-content` is not itself the scroll root.
  append(container)
  try {
    for (const descendant of Array.from(container.querySelectorAll('*'))) {
      if (
        descendant.scrollHeight <= descendant.clientHeight ||
        descendant.querySelector(turnSelector) === null
      ) {
        continue
      }
      append(descendant)
    }
  } catch {
    // A host custom element can disappear while the manual sweep starts.
  }

  let current: Element | null = container.parentElement
  while (current !== null && current !== document.body) {
    append(current)
    current = current.parentElement
  }
  if (document.scrollingElement !== null) {
    append(document.scrollingElement)
  }
  append(window)
  return candidates
}

function countRenderedTurns(
  target: Element | Window,
  container: Element,
  turnSelector: string,
): number {
  if (target === window) {
    try {
      return container.querySelectorAll(turnSelector).length
    } catch {
      return 0
    }
  }
  try {
    return (target as Element).querySelectorAll(turnSelector).length
  } catch {
    return 0
  }
}

function getTopLevelRenderedTurns(
  container: Element,
  turnSelector: string,
): Element[] {
  try {
    const turns = Array.from(container.querySelectorAll(turnSelector))
    const turnSet = new Set(turns)
    return turns.filter((turn) => {
      let parent = turn.parentElement
      while (parent !== null && parent !== container) {
        if (turnSet.has(parent)) {
          return false
        }
        parent = parent.parentElement
      }
      return true
    })
  } catch {
    return []
  }
}

function getRenderedTurnCoverage(
  container: Element,
  turnSelector: string,
): number {
  try {
    const turns = getTopLevelRenderedTurns(container, turnSelector)
    let minimum = Number.POSITIVE_INFINITY
    let maximum = Number.NEGATIVE_INFINITY
    for (const turn of turns) {
      const bounds = turn.getBoundingClientRect()
      if (bounds.height <= 0) {
        continue
      }
      minimum = Math.min(minimum, bounds.top)
      maximum = Math.max(maximum, bounds.bottom)
    }
    return Number.isFinite(minimum) && Number.isFinite(maximum)
      ? Math.max(0, maximum - minimum)
      : 0
  } catch {
    return 0
  }
}

function renderedHistoryFitsWithoutScrolling(
  container: Element,
  turnSelector: string,
): boolean {
  const turns = getTopLevelRenderedTurns(container, turnSelector)
  if (turns.length === 0) {
    return false
  }
  const containerBounds = container.getBoundingClientRect()
  const viewport = Math.max(
    1,
    container.clientHeight,
    containerBounds.height,
  )
  const coverage = getRenderedTurnCoverage(container, turnSelector)
  return coverage > 0 && coverage <= viewport + 2
}

function renderedHistorySpansScrollTarget(
  target: Element | Window,
  container: Element,
  turnSelector: string,
): boolean {
  const turns = getTopLevelRenderedTurns(container, turnSelector)
  if (turns.length === 0) {
    return false
  }
  const metrics = getScrollMetrics(target)
  const targetBounds = target === window
    ? { top: 0, bottom: metrics.viewport }
    : (target as Element).getBoundingClientRect()
  const firstBounds = turns[0].getBoundingClientRect()
  const lastBounds = turns.at(-1)?.getBoundingClientRect()
  if (lastBounds === undefined) {
    return false
  }
  const firstContentTop = firstBounds.top - targetBounds.top + metrics.top
  const lastContentBottom = lastBounds.bottom - targetBounds.top + metrics.top
  const tolerance = Math.max(200, metrics.viewport)
  return (
    firstContentTop <= tolerance &&
    metrics.maximum + metrics.viewport - lastContentBottom <= tolerance
  )
}

function renderedWindowSignature(
  messages: ExtractedConversation['messages'],
): string {
  const describe = (
    message: ExtractedConversation['messages'][number] | undefined,
    includeContentFallback: boolean,
  ): string => {
    if (message === undefined) {
      return ''
    }
    const identity = message.sourceMessageId ?? message.sourceTurnId ?? ''
    const order = String(message.sourceOrder ?? '')
    if (identity !== '' || order !== '') {
      return [message.role, identity, order].join(':')
    }
    return includeContentFallback
      ? `${message.role}:${message.content.slice(0, 120)}`
      : message.role
  }
  return `${messages.length}|${describe(messages[0], true)}|${describe(messages.at(-1), false)}`
}

function choosePrimaryScrollTarget(
  targets: readonly (Element | Window)[],
  container: Element,
  turnSelector: string,
): Element | Window | null {
  // Prefer the container or one of its scrollable descendants. An outer page
  // scroll can have a larger range while leaving the virtual history window
  // unchanged, which is the main cause of Gemini captures that stop early.
  const localTargets = targets.filter((target) =>
    target !== window &&
    target instanceof Element &&
    (target === container || container.contains(target)),
  )
  // The adapter-selected container is the host's semantic history root. If
  // it can scroll, prefer it over a larger descendant range: Gemini's
  // `infinite-scroller` is often a content layer whose scrollHeight reflects
  // the virtualized list but whose scrollTop is not the active scroll state.
  if (
    targets.includes(container) &&
    isLikelyScrollController(container) &&
    countRenderedTurns(container, container, turnSelector) > 0
  ) {
    return container
  }
  // A content layer can report a large scrollHeight while overflow remains
  // visible. It cannot outrank the actual scrolling ancestor merely because
  // it is inside main (the public ChatGPT viewer uses this arrangement).
  const localControllers = localTargets.filter(isLikelyScrollController)
  const ranked = localControllers.length > 0 ? localControllers : [...targets]
  let best: Element | Window | null = null
  let bestIsLikelyController = false
  let bestTurnCount = -1
  let bestRange = -1
  for (const target of ranked) {
    const isLikelyController = isLikelyScrollController(target)
    const turnCount = countRenderedTurns(target, container, turnSelector)
    const range = getScrollMetrics(target).maximum
    if (
      (isLikelyController && !bestIsLikelyController) ||
      (isLikelyController === bestIsLikelyController && turnCount > bestTurnCount) ||
      (
        isLikelyController === bestIsLikelyController &&
        turnCount === bestTurnCount &&
        range > bestRange
      )
    ) {
      best = target
      bestIsLikelyController = isLikelyController
      bestTurnCount = turnCount
      bestRange = range
    }
  }
  return best
}

function isLikelyScrollController(target: Element | Window): boolean {
  if (target === window) {
    return true
  }
  try {
    return /^(?:auto|scroll|overlay)$/.test(
      window.getComputedStyle(target as Element).overflowY,
    )
  } catch {
    return false
  }
}

function setScrollPosition(target: Element | Window, top: number): void {
  try {
    if (target === window) {
      target.scrollTo({ top, behavior: 'auto' })
    } else {
      const element = target as Element
      if (isReverseScrollTarget(element)) element.scrollTop = top - Math.max(0, element.scrollHeight - element.clientHeight)
      else element.scrollTop = top
    }
  } catch {
    // Ignore a stale host scroll root and let the next step continue.
  }
}

async function nudgeScrollBoundary(
  target: Element | Window,
  direction: 1 | -1,
): Promise<void> {
  const metrics = getScrollMetrics(target)
  const boundary = direction === 1 ? metrics.maximum : 0
  const inset = direction === 1
    ? Math.max(0, metrics.maximum - 1)
    : Math.min(metrics.maximum, 1)
  setScrollPosition(target, inset)
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 120)
    window.requestAnimationFrame(() => { window.clearTimeout(timer); resolve() })
  })
  setScrollPosition(target, boundary)
}

function waitForRender(
  container: Element,
  settleMs = COMPLETE_CAPTURE_SETTLE_MS,
  maximumSettleMs = COMPLETE_CAPTURE_MAX_SETTLE_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let settleTimer: number | null = null
    let maximumTimer: number | null = null
    let observer: MutationObserver | null = null
    const finish = (): void => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer)
      }
      if (maximumTimer !== null) {
        window.clearTimeout(maximumTimer)
      }
      observer?.disconnect()
      resolve()
    }
    const scheduleFinish = (): void => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer)
      }
      settleTimer = window.setTimeout(finish, settleMs)
    }
    try {
      observer = new MutationObserver(scheduleFinish)
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'data-index',
          'data-message-id',
          'data-test-id',
          'data-testid',
          'data-turn-id',
          'id',
        ],
      })
    } catch {
      observer = null
    }
    maximumTimer = window.setTimeout(finish, maximumSettleMs)
    scheduleFinish()
  })
}

async function sweepScrollTarget(
  target: Element | Window,
  direction: 1 | -1,
  collect: () => WindowCollectionProgress,
  isCurrent: () => boolean,
  container: Element,
  turnSelector: string,
): Promise<ScrollSweepResult> {
  let observedWindowChange = false
  let knownOrderStart = false
  let previousWindowSignature = ''
  const readProgress = (): WindowCollectionProgress => {
    const progress = collect()
    if (
      previousWindowSignature !== '' &&
      progress.windowSignature !== '' &&
      progress.windowSignature !== previousWindowSignature
    ) {
      observedWindowChange = true
    }
    if (progress.windowSignature !== '') {
      previousWindowSignature = progress.windowSignature
    }
    knownOrderStart ||= progress.knownOrderStart
    return progress
  }
  const incomplete = (): ScrollSweepResult => ({
    reachedBoundary: false,
    observedWindowChange,
    knownOrderStart,
  })
  const targetIsConnected = (): boolean =>
    target === window || (target as Element).isConnected
  if (!isCurrent() || !targetIsConnected()) {
    return incomplete()
  }
  const initial = getScrollMetrics(target)
  setScrollPosition(target, direction === 1 ? 0 : initial.maximum)
  await waitForRender(container)
  let previousCount = readProgress().count
  let previousStartMaximum: number | null = null
  let previousStartRenderedState = ''
  let stalledStartRounds = 0
  let stableStartRounds = 0
  while (
    stableStartRounds < COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS &&
    isCurrent() &&
    targetIsConnected()
  ) {
    await waitForRender(container)
    const progress = readProgress()
    const count = progress.count
    const metrics = getScrollMetrics(target)
    const atStartBoundary = direction === 1
      ? metrics.top <= 1
      : metrics.top >= metrics.maximum - 1
    const maximumStable = previousStartMaximum !== null &&
      Math.abs(metrics.maximum - previousStartMaximum) < 1
    const renderedState = [
      count,
      progress.windowSignature,
      progress.continuous,
      progress.knownOrderPrefixGap,
    ].join('|')
    stalledStartRounds = renderedState === previousStartRenderedState
      ? stalledStartRounds + 1
      : 0
    previousStartRenderedState = renderedState
    stableStartRounds = progress.continuous &&
      atStartBoundary && count === previousCount && maximumStable
      ? stableStartRounds + 1
      : 0
    previousCount = count
    previousStartMaximum = metrics.maximum
    if (!atStartBoundary) {
      setScrollPosition(target, direction === 1 ? 0 : metrics.maximum)
    }
    if (
      stableStartRounds < COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS &&
      stalledStartRounds >= COMPLETE_CAPTURE_MAX_STALLED_ROUNDS
    ) {
      return incomplete()
    }
  }
  if (stableStartRounds < COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS) {
    return incomplete()
  }
  let idleSteps = 0
  let stableBoundaryRounds = 0
  let stalledBoundaryRounds = 0
  let previousBoundaryRenderedState = ''
  let previousBoundaryMaximum: number | null = null
  let stepScale = 1
  while (isCurrent() && targetIsConnected()) {
    const metrics = getScrollMetrics(target)
    const renderedCoverage = getRenderedTurnCoverage(container, turnSelector)
    // Virtualizers often keep several viewports mounted. Move through a little
    // over half of that rendered coverage so adjacent samples still overlap,
    // while capping the jump for unusually tall non-virtualized histories.
    const preferredDistance = Math.max(
      160,
      metrics.viewport * COMPLETE_CAPTURE_STEP_RATIO,
      Math.min(
        metrics.viewport * COMPLETE_CAPTURE_MAX_STEP_RATIO,
        renderedCoverage * COMPLETE_CAPTURE_RENDERED_COVERAGE_RATIO,
      ),
    )
    const distance = Math.max(
      COMPLETE_CAPTURE_MIN_RETRY_STEP_PX,
      preferredDistance * stepScale,
    )
    const nextTop = Math.min(
      metrics.maximum,
      Math.max(0, metrics.top + direction * distance),
    )
    if (Math.abs(nextTop - metrics.top) < 1) {
      const atBoundary = direction === 1
        ? metrics.top >= metrics.maximum - 1
        : metrics.top <= 1
      if (!atBoundary) {
        break
      }

      // Reaching scrollTop 0/max is not enough for a virtual list: ChatGPT or
      // Gemini may prepend/append another window immediately afterward. Wait
      // and collect repeatedly, and accept the edge only when neither the
      // accumulated message count nor the scroll range changes for several
      // consecutive render-settle rounds.
      await nudgeScrollBoundary(target, direction)
      await waitForRender(
        container,
        COMPLETE_CAPTURE_BOUNDARY_SETTLE_MS,
        COMPLETE_CAPTURE_BOUNDARY_MAX_SETTLE_MS,
      )
      const progress = readProgress()
      const count = progress.count
      const after = getScrollMetrics(target)
      const stillAtBoundary = direction === 1
        ? after.top >= after.maximum - 1
        : after.top <= 1
      const maximumStable = previousBoundaryMaximum !== null &&
        Math.abs(after.maximum - previousBoundaryMaximum) < 1
      const renderedState = [
        count,
        progress.windowSignature,
        progress.continuous,
        progress.knownOrderPrefixGap,
      ].join('|')
      stalledBoundaryRounds = renderedState === previousBoundaryRenderedState
        ? stalledBoundaryRounds + 1
        : 0
      previousBoundaryRenderedState = renderedState
      stableBoundaryRounds = progress.continuous &&
        !progress.knownOrderPrefixGap &&
        stillAtBoundary &&
        count === previousCount && maximumStable
        ? stableBoundaryRounds + 1
        : 0
      previousCount = count
      previousBoundaryMaximum = after.maximum
      if (stableBoundaryRounds >= COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS) {
        return {
          reachedBoundary: isCurrent() && targetIsConnected(),
          observedWindowChange,
          knownOrderStart,
        }
      }
      if (stalledBoundaryRounds >= COMPLETE_CAPTURE_MAX_STALLED_ROUNDS) {
        return incomplete()
      }
      continue
    }
    setScrollPosition(target, nextTop)
    await waitForRender(container)
    let progress = readProgress()
    let count = progress.count
    let after = getScrollMetrics(target)
    if (!progress.continuous) {
      let retryDistance = distance
      while (
        !progress.continuous &&
        retryDistance > COMPLETE_CAPTURE_MIN_RETRY_STEP_PX + 1 &&
        isCurrent() &&
        targetIsConnected()
      ) {
        retryDistance = Math.max(
          COMPLETE_CAPTURE_MIN_RETRY_STEP_PX,
          retryDistance / 2,
        )
        setScrollPosition(
          target,
          metrics.top + direction * retryDistance,
        )
        await waitForRender(container)
        progress = readProgress()
        count = progress.count
        after = getScrollMetrics(target)
      }
      if (!progress.continuous) {
        // Return to the last continuous position and use the first/last
        // rendered turn itself as an anchor. `scrollIntoView` lets the host
        // choose its real scroll root, which recovers versions where a
        // geometrically scrollable wrapper is not the virtualizer controller.
        setScrollPosition(target, metrics.top)
        await waitForRender(container)
        progress = readProgress()
        let recovered = false
        for (
          let recoveryRound = 0;
          progress.continuous &&
            recoveryRound < COMPLETE_CAPTURE_CONTINUITY_RECOVERY_ROUNDS &&
            isCurrent() &&
            targetIsConnected();
          recoveryRound += 1
        ) {
          const turns = getTopLevelRenderedTurns(container, turnSelector)
          const edge = direction === -1 ? turns[0] : turns.at(-1)
          if (edge === undefined || !edge.isConnected) {
            break
          }
          const beforeRecovery = getScrollMetrics(target)
          const beforeSignature = progress.windowSignature
          const beforeCount = progress.count
          try {
            edge.scrollIntoView({
              block: direction === -1 ? 'end' : 'start',
              inline: 'nearest',
              behavior: 'auto',
            })
          } catch {
            break
          }
          await waitForRender(container)
          progress = readProgress()
          after = getScrollMetrics(target)
          const movedTowardBoundary = direction === -1
            ? after.top < beforeRecovery.top - 1
            : after.top > beforeRecovery.top + 1
          if (
            progress.continuous &&
            (
              progress.count > beforeCount ||
              progress.windowSignature !== beforeSignature ||
              movedTowardBoundary
            )
          ) {
            recovered = true
            count = progress.count
            break
          }
        }
        if (!recovered) {
          return incomplete()
        }
        stepScale = Math.min(
          1,
          COMPLETE_CAPTURE_MIN_RETRY_STEP_PX / preferredDistance,
        )
      } else {
        stepScale = Math.min(1, retryDistance / preferredDistance)
      }
    }
    stepScale = Math.min(1, stepScale * 1.25)
    if (count === previousCount && Math.abs(after.top - metrics.top) < 1) {
      idleSteps += 1
    } else {
      idleSteps = 0
    }
    previousCount = count
    stableBoundaryRounds = 0
    stalledBoundaryRounds = 0
    previousBoundaryRenderedState = ''
    previousBoundaryMaximum = null
    if (idleSteps >= COMPLETE_CAPTURE_MAX_IDLE_STEPS) {
      break
    }
  }
  return incomplete()
}

async function walkRenderedEdge(
  container: Element,
  turnSelector: string,
  direction: 1 | -1,
  collect: (direction: 1 | -1) => WindowCollectionProgress,
  isCurrent: () => boolean,
): Promise<ScrollSweepResult> {
  let idleRounds = 0
  let continuityFailures = 0
  let stableBoundaryRounds = 0
  let observedWindowChange = false
  let previous = collect(direction)
  while (isCurrent() && container.isConnected) {
    const turns = getTopLevelRenderedTurns(container, turnSelector)
    if (turns.length === 0) {
      break
    }
    const edgeTurn = direction === 1 ? turns.at(-1) : turns[0]
    if (edgeTurn === undefined) {
      break
    }
    const targetsBefore = getScrollTargets(container, turnSelector)
    const primaryBefore = choosePrimaryScrollTarget(
      targetsBefore,
      container,
      turnSelector,
    )
    const metricsBefore = primaryBefore === null
      ? null
      : getScrollMetrics(primaryBefore)
    try {
      edgeTurn.scrollIntoView({
        block: direction === 1 ? 'start' : 'end',
        inline: 'nearest',
        behavior: 'auto',
      })
    } catch {
      break
    }
    await waitForRender(container)
    let after = collect(direction)
    let changedWindow = after.windowSignature !== previous.windowSignature
    let addedMessages = after.count > previous.count
    observedWindowChange ||= changedWindow || addedMessages
    if (!after.continuous) {
      continuityFailures += 1
      if (continuityFailures >= COMPLETE_CAPTURE_CONTINUITY_RECOVERY_ROUNDS) {
        break
      }
      try {
        edgeTurn.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'auto',
        })
      } catch {
        break
      }
      await waitForRender(container)
      const beforeRecovery = after
      after = collect(direction)
      const recoveryChangedWindow =
        after.windowSignature !== beforeRecovery.windowSignature
      const recoveryAddedMessages = after.count > beforeRecovery.count
      changedWindow ||= recoveryChangedWindow
      addedMessages ||= recoveryAddedMessages
      observedWindowChange ||= recoveryChangedWindow || recoveryAddedMessages
      if (!after.continuous) {
        previous = after
        continue
      }
      continuityFailures = 0
    } else {
      continuityFailures = 0
    }

    const targetsAfter = getScrollTargets(container, turnSelector)
    const primaryAfter = choosePrimaryScrollTarget(
      targetsAfter,
      container,
      turnSelector,
    )
    const metricsAfter = primaryAfter === null
      ? null
      : getScrollMetrics(primaryAfter)
    const atBoundary = primaryAfter === null || metricsAfter === null
      ? renderedHistoryFitsWithoutScrolling(container, turnSelector)
      : direction === 1
        ? metricsAfter.top >= metricsAfter.maximum - 1
        : metricsAfter.top <= 1
    const moved = primaryBefore === primaryAfter &&
      metricsBefore !== null && metricsAfter !== null &&
      Math.abs(metricsAfter.top - metricsBefore.top) >= 1
    if (!changedWindow && !addedMessages && !moved) {
      idleRounds += 1
    } else {
      idleRounds = 0
    }

    const orderBoundaryValid = direction === 1 || !after.knownOrderPrefixGap
    if (atBoundary && after.continuous && orderBoundaryValid) {
      if (primaryAfter !== null) {
        await nudgeScrollBoundary(primaryAfter, direction)
      }
      await waitForRender(
        container,
        COMPLETE_CAPTURE_BOUNDARY_SETTLE_MS,
        COMPLETE_CAPTURE_BOUNDARY_MAX_SETTLE_MS,
      )
      const settled = collect(direction)
      const unchanged = settled.count === after.count &&
        settled.windowSignature === after.windowSignature
      observedWindowChange ||= !unchanged
      const settledTargets = getScrollTargets(container, turnSelector)
      const settledPrimary = choosePrimaryScrollTarget(
        settledTargets,
        container,
        turnSelector,
      )
      const settledMetrics = settledPrimary === null
        ? null
        : getScrollMetrics(settledPrimary)
      const stillAtBoundary = settledMetrics === null
        ? renderedHistoryFitsWithoutScrolling(container, turnSelector)
        : direction === 1
          ? settledMetrics.top >= settledMetrics.maximum - 1
          : settledMetrics.top <= 1
      stableBoundaryRounds = settled.continuous &&
        (direction === 1 || !settled.knownOrderPrefixGap) &&
        stillAtBoundary && unchanged
        ? stableBoundaryRounds + 1
        : 0
      after = settled
      if (stableBoundaryRounds >= COMPLETE_CAPTURE_BOUNDARY_STABLE_ROUNDS) {
        const proven = observedWindowChange ||
          settledPrimary !== null ||
          (direction === -1 && after.knownOrderStart) ||
          renderedHistoryFitsWithoutScrolling(container, turnSelector)
        return {
          reachedBoundary: proven,
          observedWindowChange,
          knownOrderStart: after.knownOrderStart,
        }
      }
    } else {
      stableBoundaryRounds = 0
    }
    if (
      idleRounds >= COMPLETE_CAPTURE_MAX_IDLE_STEPS &&
      (!atBoundary || stableBoundaryRounds === 0)
    ) {
      break
    }
    previous = after
  }
  return {
    reachedBoundary: false,
    observedWindowChange,
    knownOrderStart: previous.knownOrderStart,
  }
}

async function walkRenderedTurns(
  container: Element,
  turnSelector: string,
  collect: (direction: 1 | -1) => WindowCollectionProgress,
  isCurrent: () => boolean,
): Promise<ScrollSweepResult> {
  // `scrollIntoView` is the fallback for host versions whose geometrically
  // scrollable wrapper is not the virtual-list controller. Verify the newest
  // edge first so a capture started in the middle cannot omit its suffix, then
  // walk back through older windows and intentionally finish at the top.
  const bottom = await walkRenderedEdge(
    container,
    turnSelector,
    1,
    collect,
    isCurrent,
  )
  if (!bottom.reachedBoundary) {
    return bottom
  }
  const top = await walkRenderedEdge(
    container,
    turnSelector,
    -1,
    collect,
    isCurrent,
  )
  return {
    reachedBoundary: top.reachedBoundary,
    observedWindowChange:
      bottom.observedWindowChange || top.observedWindowChange,
    knownOrderStart: bottom.knownOrderStart || top.knownOrderStart,
  }
}

export async function collectConversationByScrolling(
  options: DomScrollCollectorOptions,
): Promise<ExtractedConversation | null> {
  if (options.strategy === 'overlapping-forward') return collectConversationByForwardScrolling(options)
  const {
    container,
    getContainer = () => container,
    conversationId,
    getConversationId,
    extractConversation,
    turnSelector,
    onProgress = () => undefined,
  } = options
  const isCurrent = (): boolean => getConversationId() === conversationId
  let collected: ExtractedConversation | null = null
  let lastReportedCount = 0
  let captureComplete = false
  const renderedSourceOrderGapBridges = new Set<string>()

  const collectCurrentWindow = (
    direction: 1 | -1 = 1,
  ): WindowCollectionProgress => {
    const current = extractConversation()
    if (
      current === null ||
      current.conversationId !== conversationId ||
      current.messages.length === 0
    ) {
      const messages = collected?.messages ?? []
      return {
        count: messages.length,
        continuous: false,
        knownOrderPrefixGap: hasKnownSourceOrderPrefixGap(messages),
        knownOrderStart: hasKnownSourceOrderStart(messages),
        windowSignature: '',
      }
    }
    const windowSignature = renderedWindowSignature(current.messages)
    const currentGapBridges = getRenderedSourceOrderGapBridges(current.messages)
    let continuous = true
    if (collected === null) {
      collected = current
      currentGapBridges.forEach((bridge) =>
        renderedSourceOrderGapBridges.add(bridge),
      )
    } else {
      const merged = mergeExtractedConversations(collected, current, direction)
      continuous = windowsAreContinuous(collected, current, direction, merged)
      if (merged !== null && continuous) {
        collected = merged
        currentGapBridges.forEach((bridge) =>
          renderedSourceOrderGapBridges.add(bridge),
        )
      }
    }
    const count = collected?.messages.length ?? 0
    if (count !== lastReportedCount) {
      lastReportedCount = count
      try {
        onProgress(count)
      } catch {
        // Progress UI is diagnostic only.
      }
    }
    return {
      count,
      continuous,
      knownOrderPrefixGap: collected === null
        ? false
        : hasKnownSourceOrderPrefixGap(collected.messages),
      knownOrderStart: collected === null
        ? false
        : hasKnownSourceOrderStart(collected.messages) || options.hasKnownRenderedStart?.() === true,
      windowSignature,
    }
  }

  let activeContainer = getContainer() ?? container
  let attemptedTargets = new Set<Element | Window>()
  while (isCurrent()) {
    const latestContainer = getContainer()
    if (latestContainer !== null && latestContainer !== activeContainer) {
      activeContainer = latestContainer
      attemptedTargets = new Set<Element | Window>()
    }
    const targets = getScrollTargets(activeContainer, turnSelector)
    const primary = choosePrimaryScrollTarget(
      targets,
      activeContainer,
      turnSelector,
    )
    if (primary === null) {
      const progress = collectCurrentWindow(-1)
      captureComplete = hasCompleteUnscrollableHistoryEvidence(
        progress.continuous,
        progress.knownOrderPrefixGap,
        renderedHistoryFitsWithoutScrolling(activeContainer, turnSelector),
      )
      break
    }
    // A scrollable wrapper is a candidate until it changes rendered history
    // or a known native beginning spans a real controller at stable boundaries.
    // Unknown static windows still try the remaining local/outer targets.
    const orderedTargets = [
      primary,
      ...targets.filter((target) => target !== primary),
    ].filter((target) => !attemptedTargets.has(target))
    if (orderedTargets.length === 0) {
      break
    }
    let containerChanged = false
    for (const target of orderedTargets) {
      if (!isCurrent()) {
        break
      }
      attemptedTargets.add(target)
      const sweep = await sweepScrollTarget(
        target,
        -1,
        () => collectCurrentWindow(-1),
        () => isCurrent() && getContainer() === activeContainer,
        activeContainer,
        turnSelector,
      )
      if (hasCompleteScrollBoundaryEvidence(
        sweep.reachedBoundary,
        sweep.observedWindowChange,
        sweep.knownOrderStart,
        renderedHistorySpansScrollTarget(target, activeContainer, turnSelector),
        isLikelyScrollController(target),
      )) {
        captureComplete = true
        break
      }
      const replacement = getContainer()
      if (replacement !== null && replacement !== activeContainer) {
        activeContainer = replacement
        attemptedTargets = new Set<Element | Window>()
        containerChanged = true
        break
      }
    }
    if (captureComplete) {
      break
    }
    if (!containerChanged && orderedTargets.every((target) => attemptedTargets.has(target))) {
      continue
    }
  }
  if (isCurrent() && !captureComplete) {
    const finalContainer = getContainer() ?? activeContainer
    const edgeWalk = await walkRenderedTurns(
      finalContainer,
      turnSelector,
      collectCurrentWindow,
      isCurrent,
    )
    captureComplete = edgeWalk.reachedBoundary
  }
  if (isCurrent()) {
    collectCurrentWindow(-1)
  }

  if (collected === null) {
    return null
  }
  // A navigation during the final collection/settle phase invalidates the
  // snapshot even when no scroll target was needed.
  const sourceOrderGap = hasKnownSourceOrderGap(
    collected.messages,
    renderedSourceOrderGapBridges,
  )
  const finalCaptureComplete = captureComplete && isCurrent() && !sourceOrderGap
  const result = collected as ExtractedConversation
  return {
    ...result,
    captureComplete: finalCaptureComplete,
    ...(!finalCaptureComplete
      ? { captureIncompleteReason: sourceOrderGap ? 'gap' as const : 'boundary' as const }
      : {}),
  }
}
