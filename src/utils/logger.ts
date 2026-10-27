const DEBUG_ENABLED = import.meta.env.DEV

export const Logger = {
  debug(message: string, ...details: unknown[]): void {
    if (DEBUG_ENABLED) {
      console.debug(`[AI Chat Memory] ${message}`, ...details)
    }
  },

  info(message: string, ...details: unknown[]): void {
    if (DEBUG_ENABLED) {
      console.info(`[AI Chat Memory] ${message}`, ...details)
    }
  },

  warn(message: string, ...details: unknown[]): void {
    console.warn(`[AI Chat Memory] ${message}`, ...details)
  },

  error(message: string, ...details: unknown[]): void {
    console.error(`[AI Chat Memory] ${message}`, ...details)
  },
}
