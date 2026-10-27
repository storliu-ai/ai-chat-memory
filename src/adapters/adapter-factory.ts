import { ChatGPTAdapter } from './chatgpt/chatgpt-adapter'
import { DeepSeekAdapter } from './deepseek/deepseek-adapter'
import { GeminiAdapter } from './gemini/gemini-adapter'
import type { AIAdapter } from './types'

export function createAdapter(hostname: string = location.hostname): AIAdapter | null {
  switch (hostname) {
    case 'chatgpt.com':
      return new ChatGPTAdapter()
    case 'gemini.google.com':
      return new GeminiAdapter()
    case 'chat.deepseek.com':
      return new DeepSeekAdapter()
    default:
      return null
  }
}
