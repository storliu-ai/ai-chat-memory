import type { ChatMessage } from './models'

const EARLIEST_SUPPORTED_MESSAGE_TIME = Date.UTC(2015, 0, 1)
const MAX_FUTURE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000

export function parseSourceMessageTimestamp(
  value: unknown,
  now: number = Date.now(),
): number | null {
  let timestamp: number
  if (typeof value === 'number') {
    timestamp = value
  } else if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized === '') {
      return null
    }
    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      timestamp = Number(normalized)
    } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(normalized)) {
      timestamp = Date.parse(normalized)
    } else {
      return null
    }
  } else {
    return null
  }

  if (!Number.isFinite(timestamp)) {
    return null
  }
  if (timestamp >= 1e15) {
    timestamp /= 1_000
  } else if (timestamp < 1e11) {
    timestamp *= 1_000
  }
  timestamp = Math.round(timestamp)
  return timestamp >= EARLIEST_SUPPORTED_MESSAGE_TIME &&
    timestamp <= now + MAX_FUTURE_CLOCK_SKEW_MS
    ? timestamp
    : null
}

export function preserveSourceMessageTimes(
  existing: readonly ChatMessage[] | undefined,
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  if (existing === undefined) {
    return [...incoming]
  }
  return incoming.map((message, index) => {
    if (message.sentAt !== undefined) {
      return message
    }
    const previous = existing[index]
    return previous?.sentAt !== undefined &&
      previous.role === message.role &&
      previous.content === message.content
      ? {
          ...message,
          sentAt: previous.sentAt,
          ...(previous.sentAtPrecision === undefined
            ? {}
            : { sentAtPrecision: previous.sentAtPrecision }),
        }
      : message
  })
}
