import { getAllAccounts } from '../db/accounts'
import { getAllConversations } from '../db/conversations'
import { getLocalEnvironment } from '../db/environment'
import type {
  Account,
  Conversation,
  ConversationQuery,
  LibraryAccount,
  LibraryConversation,
  LibraryView,
} from '../shared/models'
import { stripConversationAttachmentData } from '../shared/attachments'
import {
  getSharedDirectoryStatus,
  readVisibleSharedEnvironments,
} from './shared-directory-service'

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

function matchesQuery(
  conversation: LibraryConversation,
  query: ConversationQuery,
): boolean {
  if (query.platform !== undefined && conversation.platform !== query.platform) {
    return false
  }
  if (query.accountId !== undefined && conversation.accountId !== query.accountId) {
    return false
  }
  if (query.accountSourceEnvironmentId !== undefined &&
      conversation.sourceEnvironmentId !== query.accountSourceEnvironmentId) {
    return false
  }
  if (
    query.important !== undefined &&
    Boolean(conversation.important) !== query.important
  ) {
    return false
  }
  if (query.updatedAfter !== undefined && conversation.updatedAt < query.updatedAfter) {
    return false
  }
  if (query.updatedBefore !== undefined && conversation.updatedAt > query.updatedBefore) {
    return false
  }
  const search = query.search?.trim().toLocaleLowerCase()
  if (search) {
    return (
      conversation.title.toLocaleLowerCase().includes(search) ||
      conversation.messages.some((message) =>
        message.content.toLocaleLowerCase().includes(search),
      )
    )
  }
  return true
}

function selectPreferredExternal(
  current: LibraryConversation,
  candidate: LibraryConversation,
): LibraryConversation {
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt ? candidate : current
  }
  if (candidate.messageCount !== current.messageCount) {
    return candidate.messageCount > current.messageCount ? candidate : current
  }
  return candidate.contentHash > current.contentHash ? candidate : current
}

function toLibraryConversation(
  conversation: Conversation,
  sourceEnvironmentId: string,
  sourceEnvironmentLabel: string,
  sourceIsLocal: boolean,
  accountLabel: string,
): LibraryConversation {
  return {
    ...stripConversationAttachmentData(conversation),
    sourceEnvironmentId,
    sourceEnvironmentLabel,
    sourceIsLocal,
    accountLabel,
  }
}

export async function getLibraryView(
  query: ConversationQuery = {},
): Promise<LibraryView> {
  const [localEnvironment, localConversations, localAccounts, directory] =
    await Promise.all([
      getLocalEnvironment(),
      getAllConversations(),
      getAllAccounts(),
      getSharedDirectoryStatus(),
    ])
  const sharedEnvironments = directory.visibleEnvironmentIds.length > 0
    ? await readVisibleSharedEnvironments()
    : []

  const accountMap = new Map<string, Account>()
  const filterAccounts: LibraryAccount[] = []
  const includeEnvironment = (id: string): boolean =>
    query.sourceEnvironmentId === undefined || query.sourceEnvironmentId === id
  for (const account of localAccounts) {
    accountMap.set(account.id, account)
    if (includeEnvironment(localEnvironment.id)) {
      filterAccounts.push({ ...account, sourceEnvironmentId: localEnvironment.id, sourceEnvironmentLabel: localEnvironment.label })
    }
  }
  for (const shared of sharedEnvironments) {
    for (const account of shared.accounts) {
      if (includeEnvironment(shared.environment.id)) {
        filterAccounts.push({ ...account, sourceEnvironmentId: shared.environment.id, sourceEnvironmentLabel: shared.environment.label })
      }
      if (!accountMap.has(account.id)) {
        accountMap.set(account.id, account)
      }
    }
  }

  const merged = new Map<string, LibraryConversation>()
  for (const conversation of localConversations) {
    if (!includeEnvironment(localEnvironment.id) ||
        (query.accountSourceEnvironmentId !== undefined && query.accountSourceEnvironmentId !== localEnvironment.id)) continue
    merged.set(
      conversation.id,
      toLibraryConversation(
        conversation,
        localEnvironment.id,
        localEnvironment.label,
        true,
        accountMap.get(conversation.accountId)?.label ?? 'Unknown',
      ),
    )
  }
  for (const shared of sharedEnvironments) {
    if (!includeEnvironment(shared.environment.id) ||
        (query.accountSourceEnvironmentId !== undefined && query.accountSourceEnvironmentId !== shared.environment.id)) continue
    const sharedAccounts = new Map(
      shared.accounts.map((account) => [account.id, account.label]),
    )
    for (const conversation of shared.conversations) {
      const candidate = toLibraryConversation(
        conversation,
        shared.environment.id,
        shared.environment.label,
        false,
        sharedAccounts.get(conversation.accountId) ?? 'Unknown',
      )
      const existing = merged.get(conversation.id)
      if (existing === undefined) {
        merged.set(conversation.id, candidate)
      } else if (!existing.sourceIsLocal) {
        merged.set(conversation.id, selectPreferredExternal(existing, candidate))
      }
    }
  }

  const filtered = [...merged.values()]
    .filter((conversation) => matchesQuery(conversation, query))
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const page = Math.max(DEFAULT_PAGE, Math.floor(query.page ?? DEFAULT_PAGE))
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)),
  )
  const offset = (page - 1) * pageSize
  const today = new Date()
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime()

  return {
    page: {
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page,
      pageSize,
    },
    stats: {
      total: filtered.length,
      createdToday: filtered.filter(
        (conversation) => conversation.createdAt >= todayStart,
      ).length,
    },
    accounts: [...accountMap.values()].sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
    filterAccounts: filterAccounts.sort((left, right) =>
      left.sourceEnvironmentLabel.localeCompare(right.sourceEnvironmentLabel) || left.label.localeCompare(right.label),
    ),
    directory: {
      ...directory,
      currentEnvironment: {
        ...directory.currentEnvironment,
        conversationCount: localConversations.length,
      },
    },
  }
}
