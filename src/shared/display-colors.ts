export const DISPLAY_COLOR_OPTIONS = [
  { id: 'rose', label: '玫红', hue: 344 },
  { id: 'red', label: '红色', hue: 2 },
  { id: 'coral', label: '珊瑚', hue: 16 },
  { id: 'orange', label: '橙色', hue: 29 },
  { id: 'amber', label: '琥珀', hue: 44 },
  { id: 'lime', label: '青柠', hue: 78 },
  { id: 'green', label: '绿色', hue: 125 },
  { id: 'emerald', label: '翠绿', hue: 148 },
  { id: 'teal', label: '蓝绿', hue: 171 },
  { id: 'cyan', label: '青色', hue: 188 },
  { id: 'sky', label: '天蓝', hue: 204 },
  { id: 'blue', label: '蓝色', hue: 220 },
  { id: 'indigo', label: '靛蓝', hue: 239 },
  { id: 'violet', label: '紫罗兰', hue: 260 },
  { id: 'purple', label: '紫色', hue: 279 },
  { id: 'pink', label: '粉色', hue: 318 },
] as const

export type DisplayColorToken = (typeof DISPLAY_COLOR_OPTIONS)[number]['id']
export type DisplayColorAssignments = Record<string, DisplayColorToken>

const DISPLAY_COLOR_TOKENS: ReadonlySet<string> = new Set(
  DISPLAY_COLOR_OPTIONS.map(({ id }) => id),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDisplayColorToken(value: unknown): value is DisplayColorToken {
  return typeof value === 'string' && DISPLAY_COLOR_TOKENS.has(value)
}

export function normalizeDisplayColorAssignments(
  value: unknown,
  isValidKey: (key: string) => boolean,
  maximumEntries: number,
): DisplayColorAssignments {
  if (!isRecord(value)) {
    return {}
  }
  const entries: Array<[string, DisplayColorToken]> = []
  for (const [key, color] of Object.entries(value)) {
    if (entries.length >= maximumEntries) {
      break
    }
    if (isValidKey(key) && isDisplayColorToken(color)) {
      entries.push([key, color])
    }
  }
  return Object.fromEntries(entries)
}

export function hasCanonicalDisplayColorAssignments(
  value: unknown,
  normalized: DisplayColorAssignments,
): boolean {
  if (!isRecord(value)) {
    return false
  }
  const keys = Object.keys(value)
  const normalizedKeys = Object.keys(normalized)
  return (
    keys.length === normalizedKeys.length &&
    normalizedKeys.every((key) => value[key] === normalized[key])
  )
}
