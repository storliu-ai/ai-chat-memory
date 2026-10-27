export interface ParsedChatGPTMessageTime {
  sentAt: number
  precision: 'minute'
}

function createLocalMinuteTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date.getTime()
    : null
}

function createRelativeMinuteTimestamp(
  now: Date,
  dayOffset: number,
  hour: number,
  minute: number,
): number {
  const date = new Date(now)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

/**
 * Parses the platform-rendered label from ChatGPT's answer action menu.
 * The current UI exposes minute precision only, so seconds are deliberately
 * normalized to zero and accompanied by an explicit precision marker.
 */
export function parseChatGPTMessageMenuTime(
  value: string,
  nowTimestamp: number = Date.now(),
): ParsedChatGPTMessageTime | null {
  const normalized = value
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const clockMatch = /(?:^|[，,\s])([01]?\d|2[0-3])[:：]([0-5]\d)$/.exec(normalized)
  if (clockMatch === null) {
    return null
  }

  const hour = Number(clockMatch[1])
  const minute = Number(clockMatch[2])
  const dateLabel = normalized
    .slice(0, clockMatch.index)
    .replace(/[，,\s]+$/g, '')
    .trim()
  const now = new Date(nowTimestamp)
  let sentAt: number | null = null

  if (dateLabel === '今天' || dateLabel === '今日') {
    sentAt = createRelativeMinuteTimestamp(now, 0, hour, minute)
  } else if (dateLabel === '昨天' || dateLabel === '昨日') {
    sentAt = createRelativeMinuteTimestamp(now, -1, hour, minute)
  } else if (dateLabel === '前天') {
    sentAt = createRelativeMinuteTimestamp(now, -2, hour, minute)
  } else {
    const fullDate = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(dateLabel)
    const numericDate = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(dateLabel)
    const shortDate = /^(\d{1,2})月(\d{1,2})日$/.exec(dateLabel)
    if (fullDate !== null || numericDate !== null) {
      const match = fullDate ?? numericDate
      sentAt = createLocalMinuteTimestamp(
        Number(match?.[1]),
        Number(match?.[2]),
        Number(match?.[3]),
        hour,
        minute,
      )
    } else if (shortDate !== null) {
      const month = Number(shortDate[1])
      const day = Number(shortDate[2])
      let year = now.getFullYear()
      sentAt = createLocalMinuteTimestamp(year, month, day, hour, minute)
      if (sentAt !== null && sentAt > nowTimestamp + 24 * 60 * 60 * 1_000) {
        year -= 1
        sentAt = createLocalMinuteTimestamp(year, month, day, hour, minute)
      }
    }
  }

  return sentAt === null || sentAt > nowTimestamp + 60_000
    ? null
    : { sentAt, precision: 'minute' }
}
