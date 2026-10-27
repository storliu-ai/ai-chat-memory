import {
  APP_SETTINGS_KEY,
  DEFAULT_ATTACHMENT_MAX_SIZE_MB,
  DEFAULT_OVERLAY_PANEL_WIDTH,
  MAX_ATTACHMENT_MAX_SIZE_MB,
  MAX_OVERLAY_PANEL_WIDTH,
  MIN_ATTACHMENT_MAX_SIZE_MB,
  MIN_OVERLAY_PANEL_WIDTH,
  SUPPORTED_PLATFORMS,
  type AppSettings,
  type AppSettingsPatch,
  type Platform,
  type FileSavePolicy,
} from '../shared/models'
import { isEnvironmentId } from '../shared/environments'
import {
  hasCanonicalDisplayColorAssignments,
  normalizeDisplayColorAssignments,
} from '../shared/display-colors'
import { openDatabase, requestToPromise, STORE_NAME, transactionToPromise } from './database'

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  key: APP_SETTINGS_KEY,
  autoSavePolicyVersion: 1,
  autoSave: true,
  autoSavePlatforms: [...SUPPORTED_PLATFORMS],
  autoSavePinnedOnly: true,
  chatgptCaptureMode: 'conversation',
  chatgptSaveMethod: 'dom',
  saveImages: true,
  fileSavePolicy: 'per-conversation',
  attachmentMaxSizeMb: DEFAULT_ATTACHMENT_MAX_SIZE_MB,
  overlayPanelWidth: DEFAULT_OVERLAY_PANEL_WIDTH,
  visibleEnvironmentIds: [],
  accountTagColors: {},
  environmentCardColors: {},
})

function normalizeBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
}

function normalizeAutoSavePlatforms(value: unknown): Platform[] {
  if (!Array.isArray(value)) {
    return [...SUPPORTED_PLATFORMS]
  }
  return SUPPORTED_PLATFORMS.filter((platform) => value.includes(platform))
}

function normalizeFileSavePolicy(value: unknown): FileSavePolicy {
  return value === 'never' ? value : 'per-conversation'
}

function hasCanonicalPlatformOrder(value: unknown, normalized: Platform[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === normalized.length &&
    value.every((platform, index) => platform === normalized[index])
  )
}

function normalizeVisibleEnvironmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter(isEnvironmentId))].slice(0, 100)
}

function hasCanonicalEnvironmentOrder(value: unknown, normalized: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === normalized.length &&
    value.every((environmentId, index) => environmentId === normalized[index])
  )
}

function isAccountColorKey(value: string): boolean {
  return value.trim() !== '' && value.length <= 128
}

export async function putSettings(settings: AppSettings): Promise<AppSettings> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.SETTINGS).put(settings)
    const result = requestToPromise(request)
    await Promise.all([result, transactionToPromise(transaction)])
    return settings
  } finally {
    database.close()
  }
}

export async function getSettings(): Promise<AppSettings> {
  const database = await openDatabase()
  let settings: AppSettings | undefined

  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readonly')
    const request = transaction.objectStore(STORE_NAME.SETTINGS).get(APP_SETTINGS_KEY)
    ;[settings] = await Promise.all([
      requestToPromise<AppSettings | undefined>(request),
      transactionToPromise(transaction),
    ])
  } finally {
    database.close()
  }

  if (settings !== undefined) {
    const storedAutoSavePolicyVersion = (
      settings as { autoSavePolicyVersion?: unknown }
    ).autoSavePolicyVersion
    const autoSavePolicyVersion = storedAutoSavePolicyVersion === 1 ? 1 : 0
    const storedAutoSavePlatforms = (
      settings as { autoSavePlatforms?: unknown }
    ).autoSavePlatforms
    const autoSavePlatforms = normalizeAutoSavePlatforms(storedAutoSavePlatforms)
    const storedVisibleEnvironmentIds = (
      settings as { visibleEnvironmentIds?: unknown }
    ).visibleEnvironmentIds
    const visibleEnvironmentIds = normalizeVisibleEnvironmentIds(
      storedVisibleEnvironmentIds,
    )
    const storedAccountTagColors = (
      settings as { accountTagColors?: unknown }
    ).accountTagColors
    const accountTagColors = normalizeDisplayColorAssignments(
      storedAccountTagColors,
      isAccountColorKey,
      500,
    )
    const storedEnvironmentCardColors = (
      settings as { environmentCardColors?: unknown }
    ).environmentCardColors
    const environmentCardColors = normalizeDisplayColorAssignments(
      storedEnvironmentCardColors,
      isEnvironmentId,
      100,
    )
    const attachmentMaxSizeMb = normalizeBoundedInteger(
      (settings as { attachmentMaxSizeMb?: unknown }).attachmentMaxSizeMb,
      MIN_ATTACHMENT_MAX_SIZE_MB,
      MAX_ATTACHMENT_MAX_SIZE_MB,
      DEFAULT_ATTACHMENT_MAX_SIZE_MB,
    )
    const overlayPanelWidth = normalizeBoundedInteger(
      (settings as { overlayPanelWidth?: unknown }).overlayPanelWidth,
      MIN_OVERLAY_PANEL_WIDTH,
      MAX_OVERLAY_PANEL_WIDTH,
      DEFAULT_OVERLAY_PANEL_WIDTH,
    )
    const normalized: AppSettings = {
      key: APP_SETTINGS_KEY,
      autoSavePolicyVersion: 1,
      autoSave: typeof settings.autoSave === 'boolean' ? settings.autoSave : true,
      autoSavePlatforms,
      chatgptCaptureMode: settings.chatgptCaptureMode === 'share' ? 'share' : 'conversation',
      chatgptSaveMethod: settings.chatgptSaveMethod === 'network' ? 'network' : 'dom',
      // Versions before policy v1 installed with first-time pinned-only capture
      // disabled. Migrate that unsafe default once; later explicit toggles keep
      // their value because the normalized record now carries policy v1.
      autoSavePinnedOnly: autoSavePolicyVersion === 0
        ? true
        : settings.autoSavePinnedOnly === true,
      saveImages: (settings as { saveImages?: unknown }).saveImages !== false,
      fileSavePolicy: normalizeFileSavePolicy(
        (settings as { fileSavePolicy?: unknown }).fileSavePolicy,
      ),
      attachmentMaxSizeMb,
      overlayPanelWidth,
      visibleEnvironmentIds,
      accountTagColors,
      environmentCardColors,
    }
    if (
      storedAutoSavePolicyVersion !== normalized.autoSavePolicyVersion ||
      settings.autoSave !== normalized.autoSave ||
      settings.chatgptCaptureMode !== normalized.chatgptCaptureMode ||
      settings.chatgptSaveMethod !== normalized.chatgptSaveMethod ||
      !hasCanonicalPlatformOrder(storedAutoSavePlatforms, autoSavePlatforms) ||
      settings.autoSavePinnedOnly !== normalized.autoSavePinnedOnly ||
      (settings as { saveImages?: unknown }).saveImages !== normalized.saveImages ||
      (settings as { fileSavePolicy?: unknown }).fileSavePolicy !== normalized.fileSavePolicy ||
      (settings as { attachmentMaxSizeMb?: unknown }).attachmentMaxSizeMb !== attachmentMaxSizeMb ||
      (settings as { overlayPanelWidth?: unknown }).overlayPanelWidth !== overlayPanelWidth ||
      !hasCanonicalEnvironmentOrder(
        storedVisibleEnvironmentIds,
        visibleEnvironmentIds,
      ) ||
      !hasCanonicalDisplayColorAssignments(
        storedAccountTagColors,
        accountTagColors,
      ) ||
      !hasCanonicalDisplayColorAssignments(
        storedEnvironmentCardColors,
        environmentCardColors,
      )
    ) {
      return putSettings(normalized)
    }
    return normalized
  }

  return putSettings({ ...DEFAULT_APP_SETTINGS })
}

export async function updateSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  const current = await getSettings()
  const next = { ...current, ...patch, key: APP_SETTINGS_KEY }
  return putSettings({
    ...next,
    autoSavePlatforms: normalizeAutoSavePlatforms(next.autoSavePlatforms),
    fileSavePolicy: normalizeFileSavePolicy(next.fileSavePolicy),
    attachmentMaxSizeMb: normalizeBoundedInteger(
      next.attachmentMaxSizeMb,
      MIN_ATTACHMENT_MAX_SIZE_MB,
      MAX_ATTACHMENT_MAX_SIZE_MB,
      DEFAULT_ATTACHMENT_MAX_SIZE_MB,
    ),
    overlayPanelWidth: normalizeBoundedInteger(
      next.overlayPanelWidth,
      MIN_OVERLAY_PANEL_WIDTH,
      MAX_OVERLAY_PANEL_WIDTH,
      DEFAULT_OVERLAY_PANEL_WIDTH,
    ),
    visibleEnvironmentIds: normalizeVisibleEnvironmentIds(
      next.visibleEnvironmentIds,
    ),
    accountTagColors: normalizeDisplayColorAssignments(
      next.accountTagColors,
      isAccountColorKey,
      500,
    ),
    environmentCardColors: normalizeDisplayColorAssignments(
      next.environmentCardColors,
      isEnvironmentId,
      100,
    ),
  })
}

export async function clearSettings(): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME.SETTINGS, 'readwrite')
    const request = transaction.objectStore(STORE_NAME.SETTINGS).clear()
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  } finally {
    database.close()
  }
}

export async function initializeSettings(): Promise<AppSettings> {
  return getSettings()
}
