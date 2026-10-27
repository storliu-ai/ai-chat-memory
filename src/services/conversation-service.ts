import { findShareAnchor, supplementConversationMessages } from '../shared/share-capture'
import {
  getAllConversations,
  getConversation,
  getConversationsBySource,
  putConversation,
} from '../db/conversations'
import {
  deleteConversationWithExclusionPolicy,
  type ConversationDeletionResult,
  getConversationExclusions,
  putConversationWithExclusionPolicy,
} from '../db/conversation-exclusions'
import type {
  Conversation,
  ConversationAttachment,
  ChatMessage,
  ConversationPage,
  ConversationQuery,
  ConversationSavePayload,
  ConversationSaveMode,
  ConversationStats,
  Platform,
  PendingCapture,
  StorageUsage,
} from '../shared/models'
import {
  mergeConversationAttachments,
  stripConversationAttachmentData,
} from '../shared/attachments'
import { sanitizeChatGPTAccountLabel } from '../shared/account-labels'
import { createContentHash, createConversationId } from '../utils/hash'
import {
  hasStableMessageIdentity,
  mergeCompleteConversationMessages,
  mergeRenderedConversationMessages,
  mergeVerifiedNetworkUpdates,
  startsWithAssistantMessage,
} from '../shared/conversation-reconciliation'
import { ensureConversationAccount } from './account-service'
import { CHATGPT_ACCOUNT_ID } from './chatgpt-account-migration'
import { NotFoundError } from './errors'

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const UNTITLED_CONVERSATION_TITLE = 'Untitled conversation'

function messageIdentity(message: ChatMessage): string | null {
  if (message.sourceTurnId !== undefined && message.sourceTurnId.trim() !== '') {
    return `${message.role}\0turn:${message.sourceTurnId}`
  }
  if (message.sourceMessageId !== undefined && message.sourceMessageId.trim() !== '') {
    return `${message.role}\0message:${message.sourceMessageId}`
  }
  return null
}

function applyAuthoritativeAttachmentNames(
  merged: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  incomingStartIndex: number | null,
): ChatMessage[] {
  const incomingByIdentity = new Map<string, ChatMessage>()
  for (const message of incoming) {
    const identity = messageIdentity(message)
    if (identity !== null) {
      incomingByIdentity.set(identity, message)
    }
  }
  return merged.map((message, index) => {
    const identity = messageIdentity(message)
    const positionalIndex = incomingStartIndex === null
      ? -1
      : index - incomingStartIndex
    const source = identity === null
      ? incoming[positionalIndex]
      : incomingByIdentity.get(identity)
    if (source === undefined) {
      return message
    }
    const next = { ...message }
    delete next.attachmentNames
    if (source.attachmentNames !== undefined && source.attachmentNames.length > 0) {
      next.attachmentNames = [...source.attachmentNames]
    }
    return next
  })
}

function repositionAttachments(
  attachments: readonly ConversationAttachment[] | undefined,
  startIndex: number | null,
  sourceMessages: readonly ChatMessage[] | undefined,
  finalMessages: readonly ChatMessage[] | undefined,
): ConversationAttachment[] | undefined {
  if (attachments === undefined || startIndex === null) {
    return undefined
  }
  return attachments.map((attachment) => {
    const source = sourceMessages?.[attachment.messageIndex ?? -1]
    const turnId = attachment.sourceTurnId ?? source?.sourceTurnId
    const finalIndex = finalMessages?.findIndex((message) =>
      source?.sourceMessageId !== undefined
        ? message.sourceMessageId === source.sourceMessageId && message.role === source.role
        : turnId !== undefined && message.sourceTurnId === turnId && (source === undefined || message.role === source.role),
    ) ?? -1
    if (finalIndex >= 0) return { ...attachment, messageIndex: finalIndex }
    return attachment.messageIndex === undefined
      ? attachment
      : { ...attachment, messageIndex: attachment.messageIndex + startIndex }
  })
}

export interface ConversationSaveResult {
  conversation: Conversation
  changed: boolean
}

function resolveConversationTitle(
  candidate: string,
  existingTitle?: string,
): string {
  const normalized = candidate.trim() || UNTITLED_CONVERSATION_TITLE
  if (normalized !== UNTITLED_CONVERSATION_TITLE) {
    return normalized
  }
  return existingTitle?.trim() || UNTITLED_CONVERSATION_TITLE
}

function canonicalizeConversationAccount(
  payload: ConversationSavePayload,
): ConversationSavePayload {
  if (payload.platform !== 'chatgpt') {
    return payload
  }
  const label = sanitizeChatGPTAccountLabel(payload.accountLabel)
  return {
    ...payload,
    accountId: CHATGPT_ACCOUNT_ID,
    accountLabel: label || 'Unknown',
    accountSource: label === '' ? 'unknown' : payload.accountSource,
  }
}

function normalizeQuery(query: ConversationQuery = {}): Required<
  Pick<ConversationQuery, 'page' | 'pageSize'>
> &
  ConversationQuery {
  return {
    ...query,
    page: Math.max(DEFAULT_PAGE, Math.floor(query.page ?? DEFAULT_PAGE)),
    pageSize: Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    ),
  }
}

function matchesQuery(conversation: Conversation, query: ConversationQuery): boolean {
  if (query.platform !== undefined && conversation.platform !== query.platform) {
    return false
  }
  if (query.accountId !== undefined && conversation.accountId !== query.accountId) {
    return false
  }
  if (query.important !== undefined && Boolean(conversation.important) !== query.important) {
    return false
  }
  if (query.updatedAfter !== undefined && conversation.updatedAt < query.updatedAfter) {
    return false
  }
  if (query.updatedBefore !== undefined && conversation.updatedAt > query.updatedBefore) {
    return false
  }

  const search = query.search?.trim().toLocaleLowerCase()
  if (search !== undefined && search !== '') {
    const titleMatches = conversation.title.toLocaleLowerCase().includes(search)
    const messageMatches = conversation.messages.some((message) =>
      message.content.toLocaleLowerCase().includes(search),
    )
    if (!titleMatches && !messageMatches) {
      return false
    }
  }

  return true
}

async function getFilteredConversations(query: ConversationQuery = {}): Promise<Conversation[]> {
  const conversations = await getAllConversations()
  return conversations
    .filter((conversation) => matchesQuery(conversation, query))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function saveConversation(
  payload: ConversationSavePayload,
  saveMode: ConversationSaveMode = 'automatic',
): Promise<ConversationSaveResult | null> {
  return saveConversationInternal(payload, saveMode)
}

/** Only the background network coordinator supplies this authority. It is not
 * a runtime payload flag and cannot be asserted by a content script. */
export async function saveVerifiedNetworkConversation(
  payload: ConversationSavePayload,
  authorize: () => Promise<boolean>,
): Promise<ConversationSaveResult | null> {
  return saveConversationInternal(payload, 'manual', authorize)
}

/** Called only for an owner-panel confirmation. Never gives provisional text
 * verified-network provenance, replaces local text, or reads new attachments. */
export async function savePendingNetworkConversation(
  payload: ConversationSavePayload,
  pendingCapture: PendingCapture,
  authorize: () => Promise<boolean>,
): Promise<ConversationSaveResult | null> {
  if (!await authorize()) throw new Error('待补全保存授权已撤销')
  const resolved = canonicalizeConversationAccount(payload)
  const id = await createConversationId(resolved.platform, resolved.accountId, resolved.conversationId)
  const existing = await getConversation(id)
  const incoming = resolved.messages.map((message) => {
    const clean = { ...message }
    delete clean.contentSource
    delete clean.networkWidgetSource
    return clean
  })
  if (!incoming.length || incoming[0].role !== 'user') throw new Error('没有可确认保存的用户对话')
  const messages = supplementConversationMessages(existing?.messages ?? [], incoming, pendingCapture.source === 'network')
  if (existing && !existing.pendingCapture && messages.length === existing.messages.length && messages.every((message, index) =>
    message.role === existing.messages[index].role && message.content === existing.messages[index].content,
  )) return { conversation: existing, changed: false }
  const title = existing?.title ?? resolveConversationTitle(resolved.title)
  const attachments = repositionAttachments(existing?.attachments, 0, existing?.messages, messages)
  const contentHash = await createContentHash(title, messages, attachments)
  // An exceptional candidate contained entirely in a healthy local record
  // cannot downgrade that record or replace its text/attachments/metadata.
  if (existing && !existing.pendingCapture && contentHash === existing.contentHash) return { conversation: existing, changed: false }
  await ensureConversationAccount(resolved)
  const now = Date.now()
  const conversation: Conversation = {
    id, platform: resolved.platform, accountId: resolved.accountId, conversationId: resolved.conversationId,
    title, url: resolved.url, createdAt: now, pinned: resolved.pinned, important: false,
    imageAttachmentPermission: null, fileAttachmentPermission: false,
    ...existing,
    messages, ...(attachments?.length ? { attachments } : {}),
    updatedAt: now, messageCount: messages.length, contentHash, pendingCapture,
  }
  if (!await authorize()) throw new Error('待补全保存授权已撤销')
  const saved = await putConversationWithExclusionPolicy(conversation, 'manual')
  return saved ? { conversation: saved, changed: true } : null
}

async function saveConversationInternal(
  payload: ConversationSavePayload,
  saveMode: ConversationSaveMode,
  authorize?: () => Promise<boolean>,
): Promise<ConversationSaveResult | null> {
  if (authorize && !await authorize()) throw new Error('接口保存授权已撤销')
  if (payload.messages.length === 0) {
    throw new Error('Incomplete conversations are not saved')
  }

  let resolvedPayload = canonicalizeConversationAccount(payload)
  resolvedPayload = { ...resolvedPayload, messages: resolvedPayload.messages.map((message) => {
    const clean = { ...message }
    delete clean.contentSource
    if (!authorize) delete clean.networkWidgetSource
    return authorize ? { ...clean, contentSource: 'network' as const } : clean
  }) }
  const id = await createConversationId(
    resolvedPayload.platform,
    resolvedPayload.accountId,
    resolvedPayload.conversationId,
  )
  const existing = await getConversation(id)
  const protectNetwork = !authorize && saveMode === 'automatic' && existing?.messages.some((message) => message.contentSource === 'network') === true
  const complete = authorize !== undefined || resolvedPayload.captureSnapshotComplete === true && !protectNetwork
  if (authorize && existing) {
    const byMessageId = new Map(existing.messages.filter((message) => message.sourceMessageId).map((message) => [`${message.role}\0${message.sourceMessageId}`, message]))
    resolvedPayload = { ...resolvedPayload, messages: resolvedPayload.messages.map((message) => {
      const previous = byMessageId.get(`${message.role}\0${message.sourceMessageId}`)
      return previous ? {
        ...(previous.sourceTurnId ? { sourceTurnId: previous.sourceTurnId } : {}), ...message,
        ...(previous.sentAt !== undefined ? { sentAt: previous.sentAt, ...(previous.sentAtPrecision ? { sentAtPrecision: previous.sentAtPrecision } : {}) } : {}),
        ...((previous.attachmentNames?.length || message.attachmentNames?.length) ? { attachmentNames: [...new Set([...(previous.attachmentNames ?? []), ...(message.attachmentNames ?? [])])] } : {}),
      } : message
    }) }
  }
  const title = resolvedPayload.supplementOnly && existing ? existing.title : resolveConversationTitle(resolvedPayload.title, existing?.title)
  const messageMerge = protectNetwork
    ? mergeVerifiedNetworkUpdates(existing?.messages ?? [], resolvedPayload.messages)
    : mergeRenderedConversationMessages(existing?.messages ?? [], resolvedPayload.messages)
  const messages = resolvedPayload.supplementOnly === true
    ? existing?.pendingCapture && complete
      ? supplementConversationMessages(resolvedPayload.messages, existing.messages, authorize !== undefined)
      : supplementConversationMessages(existing?.messages ?? [], resolvedPayload.messages, authorize !== undefined)
    : complete
    ? mergeCompleteConversationMessages(
        existing?.messages ?? [],
        resolvedPayload.messages,
      )
    : resolvedPayload.attachmentSnapshotComplete === true && !protectNetwork
      ? applyAuthoritativeAttachmentNames(
          messageMerge.messages,
          resolvedPayload.messages,
          messageMerge.incomingStartIndex,
        )
      : messageMerge.messages

  // A rendered virtual list can briefly contain only answer nodes while the
  // corresponding question is still being mounted. Such a snapshot is not a
  // valid replacement for a conversation: accepting it creates records that
  // start with an assistant and can later become an assistant-heavy sequence.
  // If it is merely an already-saved suffix, keep the complete local record.
  if (
    startsWithAssistantMessage(resolvedPayload.messages) &&
    (
      complete ||
      (
        (existing === null || messageMerge.status !== 'existing') &&
        !(existing !== null && resolvedPayload.messages.every(hasStableMessageIdentity))
      )
    )
  ) {
    return null
  }

  await ensureConversationAccount(resolvedPayload)

  const supplementAnchor = resolvedPayload.supplementOnly && existing ? findShareAnchor(existing.messages, resolvedPayload.messages, authorize !== undefined) : null
  const offset = supplementAnchor ? supplementAnchor.incoming - supplementAnchor.source : 0
  const existingAttachments = repositionAttachments(
      existing?.attachments,
      resolvedPayload.supplementOnly === true
        ? Math.max(0, offset)
        : complete
        ? 0
        : messageMerge.existingStartIndex,
      existing?.messages,
      messages,
    )
  const incomingAttachments = repositionAttachments(
      resolvedPayload.attachments,
      resolvedPayload.supplementOnly === true
        ? Math.max(0, -offset)
        : complete
        ? 0
        : messageMerge.incomingStartIndex,
      resolvedPayload.messages,
      messages,
    )
  const attachments = mergeConversationAttachments(
    existingAttachments,
    resolvedPayload.supplementOnly ? incomingAttachments?.map((attachment) => {
      const saved = existingAttachments?.find((candidate) => candidate.status === 'saved' && (candidate.id === attachment.id || candidate.kind === attachment.kind && candidate.name === attachment.name && candidate.sourceTurnId === attachment.sourceTurnId && candidate.messageIndex === attachment.messageIndex))
      return saved ?? attachment
    }) : incomingAttachments,
    resolvedPayload.supplementOnly === true || resolvedPayload.attachmentSnapshotComplete !== true || protectNetwork,
  )
  const contentHash = await createContentHash(
    title,
    messages,
    attachments,
  )
  const scannedIds = resolvedPayload.supplementVerifiedMessageIds ? new Set(resolvedPayload.supplementVerifiedMessageIds) : null
  const incomingIds = new Set(resolvedPayload.messages.filter((message) => message.sourceMessageId && (!resolvedPayload.supplementOnly || authorize || scannedIds?.has(message.sourceMessageId))).map((message) => `${message.role}\0${message.sourceMessageId}`))
  const incomingText = new Set(resolvedPayload.messages.map((message) => `${message.role}\0${message.content}`))
  const incomingCoversPending = !existing?.pendingCapture || existing.messages.every((message) =>
    message.sourceMessageId ? incomingIds.has(`${message.role}\0${message.sourceMessageId}`) : (!resolvedPayload.supplementOnly || authorize !== undefined) && incomingText.has(`${message.role}\0${message.content}`),
  )
  const pendingCapture = complete && (!resolvedPayload.supplementOnly || incomingCoversPending)
    ? undefined : existing?.pendingCapture
  let existingWithMetadata = existing
  if (existing !== null) {
    const titleChanged = existing.title !== title
    const pinnedChanged = !resolvedPayload.supplementOnly && existing.pinned !== resolvedPayload.pinned
    if (titleChanged || pinnedChanged || existing.pendingCapture !== pendingCapture) {
      existingWithMetadata = {
        ...existing,
        pendingCapture,
        title,
        contentHash: titleChanged
          ? await createContentHash(title, existing.messages, existing.attachments)
          : existing.contentHash,
        pinned: resolvedPayload.supplementOnly ? existing.pinned : resolvedPayload.pinned,
        updatedAt: titleChanged || existing.pendingCapture !== pendingCapture ? Date.now() : existing.updatedAt,
      }
    }
  }

  if (existing !== null && existing.contentHash === contentHash) {
    if (authorize && !await authorize()) throw new Error('接口保存授权已撤销')
    if (saveMode === 'manual' || existingWithMetadata !== existing) {
      const saved = await putConversationWithExclusionPolicy(
        existingWithMetadata ?? existing,
        saveMode,
      )
      if (saved === null) {
        return null
      }
    }
    return {
      conversation: existingWithMetadata ?? existing,
      changed: existingWithMetadata !== existing,
    }
  }

  const now = Date.now()
  const conversation: Conversation = {
    id,
    platform: resolvedPayload.platform,
    accountId: resolvedPayload.accountId,
    conversationId: resolvedPayload.conversationId,
    title,
    url: resolvedPayload.url,
    messages,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messageCount: messages.length,
    contentHash,
    pinned: resolvedPayload.supplementOnly && existing ? existing.pinned : resolvedPayload.pinned,
    important: existing?.important ?? false,
    imageAttachmentPermission: existing?.imageAttachmentPermission ?? null,
    fileAttachmentPermission: existing?.fileAttachmentPermission ?? false,
    ...(pendingCapture ? { pendingCapture } : {}),
  }

  if (authorize && !await authorize()) throw new Error('接口保存授权已撤销')
  const saved = await putConversationWithExclusionPolicy(conversation, saveMode)
  return saved === null ? null : { conversation: saved, changed: true }
}

/** Attachments supplement the latest saved body; network text is never
 * submitted a second time and user metadata is reread at this boundary. */
export async function supplementVerifiedNetworkAttachments(
  id: string,
  incoming: ConversationAttachment[],
  authorize: () => Promise<boolean>,
): Promise<Conversation> {
  const existing = await getConversation(id)
  if (!existing || !await authorize()) throw new Error('接口附件保存授权已撤销或原记录已删除')
  const attachments = mergeConversationAttachments(existing.attachments, incoming, true)
  const contentHash = await createContentHash(existing.title, existing.messages, attachments)
  if (!await authorize()) throw new Error('接口附件保存授权已撤销')
  return putConversation({ ...existing, attachments, contentHash, updatedAt: contentHash === existing.contentHash ? existing.updatedAt : Date.now() })
}

export async function hasSavedConversation(
  platform: Conversation['platform'],
  conversationId: string,
): Promise<boolean> {
  return (await getConversationsBySource(platform, conversationId)).length > 0
}

export async function getSavedConversationBySource(
  platform: Conversation['platform'],
  conversationId: string,
): Promise<Conversation | null> {
  const conversations = await getConversationsBySource(platform, conversationId)
  const preferred = conversations.reduce<Conversation | null>(
    (current, candidate) => {
      if (current === null || candidate.updatedAt > current.updatedAt) {
        return candidate
      }
      if (
        candidate.updatedAt === current.updatedAt &&
        candidate.messageCount > current.messageCount
      ) {
        return candidate
      }
      return current
    },
    null,
  )
  return preferred === null ? null : stripConversationAttachmentData(preferred)
}

export async function listConversations(
  query: ConversationQuery = {},
): Promise<ConversationPage> {
  const normalized = normalizeQuery(query)
  const conversations = await getFilteredConversations(normalized)
  const offset = (normalized.page - 1) * normalized.pageSize

  return {
    items: conversations
      .slice(offset, offset + normalized.pageSize)
      .map(stripConversationAttachmentData),
    total: conversations.length,
    page: normalized.page,
    pageSize: normalized.pageSize,
  }
}

export async function getConversationById(id: string): Promise<Conversation | null> {
  return getConversation(id)
}

export async function getConversationStats(
  query: ConversationQuery = {},
): Promise<ConversationStats> {
  const conversations = await getFilteredConversations(query)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return {
    total: conversations.length,
    createdToday: conversations.filter((conversation) => conversation.createdAt >= todayStart)
      .length,
  }
}

export async function getConversationStorageUsage(): Promise<StorageUsage> {
  const [conversations, exclusions] = await Promise.all([
    getAllConversations(),
    getConversationExclusions(),
  ])
  if (conversations.length === 0 && exclusions.length === 0) {
    return { bytes: 0 }
  }
  return { bytes: new Blob([JSON.stringify({ conversations, exclusions })]).size }
}

export async function deleteConversation(id: string): Promise<ConversationDeletionResult> {
  return deleteConversationWithExclusionPolicy(id)
}

export async function updateConversationImportance(
  id: string,
  important: boolean,
): Promise<Conversation> {
  const existing = await getConversation(id)
  if (existing === null) {
    throw new NotFoundError('Conversation was not found')
  }
  if (Boolean(existing.important) === important) {
    return { ...existing, important }
  }
  return putConversation({ ...existing, important })
}

export async function updateConversationPinnedBySource(
  platform: Platform,
  accountId: string,
  conversationId: string,
  pinned: boolean,
): Promise<Conversation[]> {
  const canonicalAccountId = platform === 'chatgpt'
    ? CHATGPT_ACCOUNT_ID
    : accountId
  const matches = (await getConversationsBySource(platform, conversationId))
    .filter((conversation) => conversation.accountId === canonicalAccountId)
  const changed = matches
    .filter((conversation) => conversation.pinned !== pinned)
    .map((conversation) => ({ ...conversation, pinned }))
  await Promise.all(changed.map(putConversation))
  return changed
}

export async function updateConversationFileAttachmentPermission(
  id: string,
  allowed: boolean,
): Promise<Conversation> {
  const existing = await getConversation(id)
  if (existing === null) {
    throw new NotFoundError('Conversation was not found')
  }
  if (existing.fileAttachmentPermission === allowed) {
    return existing
  }
  return putConversation({
    ...existing,
    fileAttachmentPermission: allowed,
  })
}

export async function updateConversationImageAttachmentPermission(
  id: string,
  allowed: boolean,
): Promise<Conversation> {
  const existing = await getConversation(id)
  if (existing === null) {
    throw new NotFoundError('Conversation was not found')
  }
  if (existing.imageAttachmentPermission === allowed) {
    return existing
  }
  return putConversation({
    ...existing,
    imageAttachmentPermission: allowed,
  })
}
