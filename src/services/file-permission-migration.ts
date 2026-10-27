import {
  openDatabase,
  requestToPromise,
  STORE_NAME,
  transactionToPromise,
} from '../db/database'
import {
  APP_SETTINGS_KEY,
  type AppSettings,
  type Conversation,
} from '../shared/models'

interface LegacyFilePermissionSettings extends Omit<AppSettings, 'fileSavePolicy'> {
  fileSavePolicy?: unknown
}

export interface FilePermissionMigrationResult {
  changed: boolean
  grantedPermissions: number
}

export function needsLegacyImportantFilePermission(
  conversation: Pick<Conversation, 'important' | 'fileAttachmentPermission'>,
): boolean {
  return (
    conversation.important === true &&
    conversation.fileAttachmentPermission !== true
  )
}

/**
 * Versions that offered `important-only` implicitly authorized files whenever
 * a conversation was important. Convert that implicit rule into explicit
 * per-conversation permissions without touching content or user timestamps.
 */
export async function migrateImportantOnlyFilePermissions(): Promise<FilePermissionMigrationResult> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(
      [STORE_NAME.SETTINGS, STORE_NAME.CONVERSATIONS],
      'readwrite',
    )
    const settingsStore = transaction.objectStore(STORE_NAME.SETTINGS)
    const conversationStore = transaction.objectStore(STORE_NAME.CONVERSATIONS)
    const settingsRequest = settingsStore.get(APP_SETTINGS_KEY)
    const conversationsRequest = conversationStore.getAll()
    const [settings, conversations] = await Promise.all([
      requestToPromise<LegacyFilePermissionSettings | undefined>(settingsRequest),
      requestToPromise<Conversation[]>(conversationsRequest),
    ])

    if (settings?.fileSavePolicy !== 'important-only') {
      await transactionToPromise(transaction)
      return { changed: false, grantedPermissions: 0 }
    }

    const conversationsToUpdate = conversations.filter(
      needsLegacyImportantFilePermission,
    )
    const writes: Promise<unknown>[] = [
      requestToPromise(settingsStore.put({
        ...settings,
        key: APP_SETTINGS_KEY,
        fileSavePolicy: 'per-conversation',
      })),
      ...conversationsToUpdate.map((conversation) =>
        requestToPromise(conversationStore.put({
          ...conversation,
          fileAttachmentPermission: true,
        }))),
    ]
    await Promise.all([...writes, transactionToPromise(transaction)])
    return {
      changed: true,
      grantedPermissions: conversationsToUpdate.length,
    }
  } finally {
    database.close()
  }
}
