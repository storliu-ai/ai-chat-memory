const ENVIRONMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isEnvironmentId(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_ID_PATTERN.test(value)
}

export function createEnvironmentId(): string {
  return crypto.randomUUID()
}

export function getEnvironmentDirectoryName(environmentId: string): string {
  if (!isEnvironmentId(environmentId)) {
    throw new Error('Invalid environment identifier')
  }
  return `env-${environmentId}`
}

export function normalizeEnvironmentLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, ' ')
  if (label === '' || label.length > 80) {
    throw new Error('Environment name must contain between 1 and 80 characters')
  }
  return label
}
