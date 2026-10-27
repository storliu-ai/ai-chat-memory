const GENERIC_CHATGPT_ACCOUNT_LABEL = /^(?:chatgpt|account|profile|user|menu|settings|upgrade|log in|sign up|open profile|view profile|profile picture|avatar|free|plus|pro|team|business|enterprise|账号|账户|个人资料|个人资料图片|头像|菜单|设置|升级|登录|注册)$/i
const CHATGPT_PROFILE_ACTION = /(?:open profile|view profile|profile picture|打开个人资料|查看个人资料|打开账号|打开账户|个人资料图片)/i
const LEADING_CHATGPT_PROFILE_ACTION = /^(?:open profile|view profile|打开个人资料|查看个人资料|打开账号|打开账户)/i
const CHATGPT_PROFILE_ACTION_SUFFIX = /\s*(?:open profile|view profile|打开个人资料|查看个人资料|打开账号|打开账户)\s*$/i

function normalizeAccountLabel(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function isLegacyChatGPTProfileLabel(value: string): boolean {
  const normalized = normalizeAccountLabel(value)
  return (
    CHATGPT_PROFILE_ACTION.test(normalized) ||
    GENERIC_CHATGPT_ACCOUNT_LABEL.test(
      normalized.replace(/^chatgpt\s*[:：·-]?\s*/i, ''),
    )
  )
}

export function sanitizeChatGPTAccountLabel(value: string): string {
  const normalized = normalizeAccountLabel(value)
  const withoutBrand = normalized.replace(/^chatgpt\s*[:：·-]?\s*/i, '')
  if (LEADING_CHATGPT_PROFILE_ACTION.test(withoutBrand)) {
    return ''
  }
  const withoutAction = withoutBrand
    .replace(CHATGPT_PROFILE_ACTION_SUFFIX, '')
    .replace(/[·:：|—–-]+\s*$/, '')
    .trim()
  return GENERIC_CHATGPT_ACCOUNT_LABEL.test(withoutAction)
    ? ''
    : withoutAction
}
