function normalizeForSerialization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForSerialization)
  }

  if (typeof value === 'object' && value !== null) {
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) {
        normalized[key] = normalizeForSerialization(child)
      }
    }
    return normalized
  }

  return value
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeForSerialization(value))
}
