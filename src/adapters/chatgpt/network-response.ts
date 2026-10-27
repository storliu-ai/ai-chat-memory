import type { ChatGPTCaptureMode } from '../../shared/share-capture'

export interface CaptureEndpointTarget { mode: ChatGPTCaptureMode; id: string }
export type CaptureEndpoint = 'initial' | 'messages' | 'share'

/** Exact target only. Queries are not logged or persisted and headers are never read. */
export function matchChatGPTCaptureEndpoint(value: string, target: CaptureEndpointTarget): CaptureEndpoint | null {
  try {
    const url = new URL(value)
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.port) return null
    const parts = url.pathname.split('/')
    if (parts.length < 4 || parts[1] !== 'backend-api') return null
    if (decodeURIComponent(parts[3]) !== target.id) return null
    if (target.mode === 'share') return parts[2] === 'share' && parts.length === 4 ? 'share' : null
    if (!['conversation', 'conversations'].includes(parts[2])) return null
    if (parts.length === 4) return 'initial'
    return parts.length === 5 && parts[4] === 'messages' ? 'messages' : null
  } catch { return null }
}

export interface ResponseShapeSummary { nodeCount: number; branchId: string | null; schema: 'messages' | 'mapping' }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/** Phase-one shape check ONLY. This must never authorize a conversation save. */
export function inspectChatGPTResponseShape(body: string, endpoint: CaptureEndpoint): ResponseShapeSummary {
  let value: unknown
  try { value = JSON.parse(body) }
  catch { throw new Error('目标响应不是有效 JSON，本次验证未通过') }
  if (!record(value)) throw new Error('无法识别响应结构，本次验证未通过')
  const branchId = typeof value.current_node === 'string' && value.current_node.length <= 256 ? value.current_node : null
  if (record(value.mapping) && branchId) {
    const nodes = Object.values(value.mapping)
    if (!nodes.length || nodes.length > 100_000 || !record(value.mapping[branchId]) || nodes.some((node) => !record(node))) throw new Error('分享响应结构不完整，本次验证未通过')
    return { schema: 'mapping', nodeCount: nodes.length, branchId }
  }
  if (endpoint !== 'share' && Array.isArray(value.messages) && record(value.page_info)) {
    if (value.messages.length > 100_000 || value.messages.some((node) => !record(node))) throw new Error('分页响应结构不完整，本次验证未通过')
    return { schema: 'messages', nodeCount: value.messages.length, branchId }
  }
  throw new Error('暂不支持此响应结构，本次未保存对话')
}
