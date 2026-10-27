import type {
  RuntimeRequest,
  RuntimeResponse,
  RuntimeResponseDataMap,
} from './runtime-messages'

function isRuntimeResponse(value: unknown): value is RuntimeResponse<unknown> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false
  }

  const response = value as { ok?: unknown; data?: unknown; error?: unknown }
  if (response.ok === true) {
    return 'data' in response
  }
  if (response.ok === false) {
    return typeof response.error === 'object' && response.error !== null
  }
  return false
}

export async function sendRuntimeRequest<T extends RuntimeRequest>(
  request: T,
): Promise<RuntimeResponseDataMap[T['type']]> {
  const response: unknown = await chrome.runtime.sendMessage(request)
  if (!isRuntimeResponse(response)) {
    throw new Error('The extension returned an invalid local response')
  }
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.data as RuntimeResponseDataMap[T['type']]
}
