import type { ChatGPTCaptureMode } from './share-capture'
import type { ConversationAttachment, ExtractedConversation } from './models'

export type ChatGPTSaveMethod = 'dom' | 'network'
export type CaptureBlocker = 'draft' | 'attachment' | 'editing' | 'generating' | 'unknown' | 'busy'
export const NETWORK_PAGE_PROBE = 'AI_CHAT_MEMORY_NETWORK_PAGE_PROBE'
export const NETWORK_PAGE_REFRESH = 'AI_CHAT_MEMORY_NETWORK_PAGE_REFRESH'
export const NETWORK_TASK_CHANGED = 'AI_CHAT_MEMORY_NETWORK_TASK_CHANGED'
export const NETWORK_VERIFY_TASK = 'AI_CHAT_MEMORY_NETWORK_VERIFY_TASK'
export const NETWORK_PAGE_CONTEXT = 'AI_CHAT_MEMORY_NETWORK_PAGE_CONTEXT'

export const CAPTURE_BLOCKERS: Record<CaptureBlocker, { short: string; detail: string }> = {
  draft: { short: '有未发送内容，请处理后重试。', detail: '本对话接口采集需要刷新页面。请先发送，或自行备份并清空输入框，再重新发起；本次未启动。' },
  attachment: { short: '有待发送附件，请处理后重试。', detail: '本对话接口采集需要刷新页面。请先完成发送，或自行移除待发送附件，再重新发起；本次未启动。' },
  editing: { short: '正在编辑消息，请完成或取消后重试。', detail: '为避免丢失修改，本次未启动。请完成或取消编辑，再重新发起。' },
  generating: { short: '回答生成中，请等回答结束后重试。', detail: '为避免刷新中断生成，本次未启动。回答结束后需要重新发起，不会自动开始。' },
  unknown: { short: '页面状态未就绪，请稍后重试。', detail: '暂时无法确认输入区或回答状态，本次未启动，也不会自动重试。' },
  busy: { short: '已有采集任务，请结束后重试。', detail: '请等待已有任务结束或先取消，再重新发起。' },
}

/** Status only: never put URLs, response bodies, cursors or source text here. */
export interface NetworkCaptureStatus {
  id: string
  conversationId: string
  originTabId: number
  captureTabId: number | null
  mode: ChatGPTCaptureMode
  method: 'network'
  phase: 'connecting' | 'loading' | 'reading' | 'needs-foreground' | 'awaiting-confirmation' | 'saving' | 'attachments' | 'stopping' | 'verified' | 'complete' | 'partial' | 'failed' | 'cancelled'
  operation?: 'probe' | 'save'
  messageCount?: number
  savedAttachmentCount?: number
  failedAttachmentCount?: number
  bodySaved?: boolean
  candidateCount?: number
  candidateSource?: 'network' | 'page'
  issue?: string
  responseCount: number
  responseBytes: number
  largestResponseBytes: number
  nodeCount: number
  message: string
  updatedAt: number
}

export interface NetworkCaptureResponse {
  status: NetworkCaptureStatus | null
  paused: boolean
  blockers?: CaptureBlocker[]
  ownedPage?: boolean
  canControl?: boolean
  networkComplete?: boolean
  drive?: boolean
  needsAttachmentScan?: boolean
  attachmentPlan?: Array<{ localIndex: number; networkIndex: number; sourceMessageId: string; sourceTurnId?: string }>
  attachmentPolicy?: { saveImages: boolean; allowFiles: boolean; skippedFileStatus: 'confirmation-required' | 'not-saved'; maximumBytes: number }
}

export interface NetworkPageProbe {
  url: string
  conversationId: string | null
  documentToken: string
  contentScriptBuildId: string
  blockers: CaptureBlocker[]
  branchRevision: number
}

export interface NetworkCaptureRequest {
  type: 'NETWORK_CAPTURE'
  contentScriptBuildId: string
  action: 'start' | 'status' | 'pause' | 'claim' | 'finish' | 'cancel' | 'open' | 'return' | 'invalidate' | 'progress' | 'commit' | 'confirm' | 'attachments' | 'error'
  conversationId?: string
  jobId?: string
  mode?: ChatGPTCaptureMode
  method?: 'network'
  shareUrl?: string
  documentToken?: string
  operation?: 'probe' | 'save'
  capture?: ExtractedConversation
  attachments?: ConversationAttachment[]
  messageCount?: number
  needsForeground?: boolean
  error?: string
  allowFiles?: boolean
  saveImages?: boolean
}

export function isNetworkCaptureActive(status: NetworkCaptureStatus | null): boolean {
  return status !== null && !['verified', 'complete', 'partial', 'failed', 'cancelled'].includes(status.phase)
}
