/** Account evidence comes only from the rendered profile control, never text in
 * a conversation or authentication/private response data. Names are labels only. */
export interface ChatGPTAccountIdentity {
  kind: 'email'
  identifier: string
}

export const CHATGPT_UNKNOWN_ACCOUNT_ID = 'unknown'
export const CHATGPT_UNKNOWN_ACCOUNT_LABEL = '未识别账号'

export function normalizeChatGPTAccountEmail(value: string | null): string | null {
  const normalized = value?.normalize('NFKC').trim().toLowerCase() ?? ''
  return normalized.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(normalized)
    ? normalized
    : null
}

/** Versioned, platform-qualified keys cannot be confused with old name hashes. */
export function isIdentifiedChatGPTAccountId(value: string): boolean {
  return /^chatgpt:email:[a-f0-9]{64}$/.test(value)
}
