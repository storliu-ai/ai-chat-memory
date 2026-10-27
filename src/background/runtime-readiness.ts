import { EXTENSION_BUILD_ID } from '../shared/build-id'
import type { CaptureReadiness } from '../shared/runtime-messages'

const RUNTIME_READY_MARKER = 'runtime-ready.json'

function hasMatchingBuildId(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (value as { buildId?: unknown }).buildId === EXTENSION_BUILD_ID
}

export async function getCaptureReadiness(
  contentScriptBuildId: string,
): Promise<CaptureReadiness> {
  if (contentScriptBuildId !== EXTENSION_BUILD_ID) {
    return { ready: false, reason: 'version-mismatch' }
  }
  try {
    const response = await fetch(chrome.runtime.getURL(RUNTIME_READY_MARKER), {
      cache: 'no-store',
    })
    if (!response.ok || !hasMatchingBuildId(await response.json())) {
      return { ready: false, reason: 'package-unavailable' }
    }
    return { ready: true }
  } catch {
    return { ready: false, reason: 'package-unavailable' }
  }
}
