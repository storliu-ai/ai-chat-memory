import { getAccount, getAllAccounts, putAccount } from '../db/accounts'
import { sanitizeChatGPTAccountLabel } from '../shared/account-labels'
import type {
  Account,
  ConversationSavePayload,
  Platform,
} from '../shared/models'
import { NotFoundError } from './errors'

export async function ensureConversationAccount(
  payload: ConversationSavePayload,
): Promise<Account> {
  const existing = await getAccount(payload.accountId)
  const now = Date.now()

  if (existing === null) {
    return putAccount({
      id: payload.accountId,
      platform: payload.platform,
      label: payload.accountLabel.trim() || 'Unknown',
      source: payload.accountSource,
      createdAt: now,
      updatedAt: now,
    })
  }

  if (existing.source === 'manual') {
    return existing
  }

  if (
    payload.accountSource === 'unknown' ||
    payload.accountLabel.trim() === '' ||
    payload.accountLabel.trim() === 'Unknown'
  ) {
    return existing
  }

  const nextLabel = payload.accountLabel.trim() || existing.label
  if (nextLabel === existing.label && payload.accountSource === existing.source) {
    return existing
  }

  return putAccount({
    ...existing,
    label: nextLabel,
    source: payload.accountSource,
    updatedAt: now,
  })
}

export async function listAccounts(): Promise<Account[]> {
  const accounts = await getAllAccounts()
  return accounts.sort((left, right) => left.label.localeCompare(right.label))
}

export async function syncDetectedAccountLabel(
  platform: Platform,
  accountId: string,
  label: string,
): Promise<Account | null> {
  const existing = await getAccount(accountId)
  if (existing === null || existing.platform !== platform || existing.source === 'manual') {
    return existing
  }
  const normalizedLabel = platform === 'chatgpt'
    ? sanitizeChatGPTAccountLabel(label)
    : label.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (
    normalizedLabel.length < 2 ||
    normalizedLabel.length > 100 ||
    normalizedLabel === 'Unknown'
  ) {
    return existing
  }
  if (existing.label === normalizedLabel && existing.source === 'detected') {
    return existing
  }
  return putAccount({
    ...existing,
    label: normalizedLabel,
    source: 'detected',
    updatedAt: Date.now(),
  })
}

export async function updateAccountLabel(accountId: string, label: string): Promise<Account> {
  const normalizedLabel = label.trim()
  if (normalizedLabel === '' || normalizedLabel.length > 100) {
    throw new Error('Account label must contain between 1 and 100 characters')
  }

  const account = await getAccount(accountId)
  if (account === null) {
    throw new NotFoundError('Account was not found')
  }

  return putAccount({
    ...account,
    label: normalizedLabel,
    source: 'manual',
    updatedAt: Date.now(),
  })
}
