import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const readSource = (path) => readFileSync(join(root, path), 'utf8')
const toDataModule = (source) => {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}

const accountLabels = await import(toDataModule(
  readSource('src/shared/account-labels.ts'),
))
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('ChatGPT 打开个人资料'), '')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('打开个人资料'), '')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('ChatGPT Open profile'), '')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('Alice 打开个人资料'), 'Alice')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('Alice · 打开个人资料'), 'Alice')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('ChatGPT Alice'), 'Alice')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('个人资料图片'), '')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('Profile picture'), '')
assert.equal(accountLabels.sanitizeChatGPTAccountLabel('PLUS'), '')
assert.equal(accountLabels.isLegacyChatGPTProfileLabel('ChatGPT 查看个人资料'), true)
assert.equal(accountLabels.isLegacyChatGPTProfileLabel('个人资料图片'), true)
assert.equal(accountLabels.isLegacyChatGPTProfileLabel('alice@example.com'), false)

const attachmentCandidates = await import(toDataModule(
  readSource('src/adapters/attachment-candidates.ts'),
))
assert.equal(attachmentCandidates.isNonConversationAssetName('favicons.png'), true)
assert.equal(attachmentCandidates.isNonConversationAssetName('/assets/favicon.ico'), true)
assert.equal(attachmentCandidates.isNonConversationAssetName('apple-touch-icon.png'), true)
assert.equal(attachmentCandidates.isNonConversationAssetName('vacation-photo.png'), false)
assert.equal(attachmentCandidates.isOpaqueResourceName('3746995d7ba4914f'), true)
assert.equal(
  attachmentCandidates.isCredibleUrlOnlyFileName('3746995d7ba4914f'),
  false,
  'An opaque backend object id must not become a file name by itself',
)
assert.equal(
  attachmentCandidates.isCredibleUrlOnlyFileName('rendered-report.pdf'),
  true,
)

const remoteImages = await import(toDataModule(
  readSource('src/shared/remote-images.ts'),
))
assert.equal(
  remoteImages.isPermittedRemoteImageUrl(
    'https://lh3.googleusercontent.com/gg/temporary-image',
  ),
  true,
)
assert.equal(
  remoteImages.isPermittedRemoteImageUrl(
    'https://files.oaiusercontent.com/file/example',
  ),
  true,
)
assert.equal(
  remoteImages.isPermittedRemoteImageUrl('https://example.com/image.png'),
  false,
)
const renderedChatGPTImage = 'https://images.openai.com/static-rsc-4/synthetic-image?purpose=fullsize'
assert.equal(remoteImages.isPermittedRemoteImageUrl(renderedChatGPTImage), true)
assert.equal(remoteImages.isPermittedRemoteImageForHost(renderedChatGPTImage, 'https://chatgpt.com'), true)
assert.equal(remoteImages.isPermittedRemoteImageForHost(renderedChatGPTImage, 'https://gemini.google.com'), false)
assert.equal(remoteImages.isPermittedRemoteImageUrl('https://images.openai.com.example.com/synthetic-image'), false)
assert.equal(remoteImages.isPermittedRemoteImageUrl('http://images.openai.com/synthetic-image'), false)
assert.equal(
  remoteImages.isPermittedRemoteImageForHost(
    'https://lh3.googleusercontent.com/gg/temporary-image',
    'https://gemini.google.com',
  ),
  true,
)
assert.equal(
  remoteImages.isPermittedRemoteImageForHost(
    'https://lh3.googleusercontent.com/gg/temporary-image',
    'https://chatgpt.com',
  ),
  false,
)
assert.equal(
  remoteImages.getOriginalRemoteImageUrl(
    'https://lh3.googleusercontent.com/rd-gg/signed-token=s512?authuser=1',
  ),
  'https://lh3.googleusercontent.com/rd-gg/signed-token=s0?authuser=1',
)
assert.equal(
  remoteImages.getOriginalRemoteImageUrl(
    'https://lh3.googleusercontent.com/not-rd-gg/image=s512',
  ),
  null,
)
assert.equal(
  remoteImages.isPermittedRemoteImageUrl(
    'https://lh3.google.com/rd-gg/redirect-only',
  ),
  false,
  'The redirect host must never be accepted as a caller-supplied image URL',
)

const stableSerializeModuleUrl = toDataModule(
  readSource('src/utils/stable-serialize.ts'),
)
const chatGPTAccountModuleUrl = toDataModule(readSource('src/shared/chatgpt-account.ts'))
const hashJavaScript = ts.transpileModule(readSource('src/utils/hash.ts'), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText.replaceAll(
  "'./stable-serialize'",
  JSON.stringify(stableSerializeModuleUrl),
).replaceAll("'../shared/chatgpt-account'", JSON.stringify(chatGPTAccountModuleUrl))
const hashes = await import(
  `data:text/javascript;base64,${Buffer.from(hashJavaScript).toString('base64')}`
)
assert.equal(await hashes.createAccountId('chatgpt', '个人资料图片'), 'unknown')
assert.equal(await hashes.createAccountId('chatgpt', 'PLUS'), 'unknown')
assert.match(await hashes.createAccountId('chatgpt', 'alice@example.com'), /^chatgpt:email:[a-f0-9]{64}$/)
assert.notEqual(
  await hashes.createAccountId('gemini', 'alice@example.com'),
  await hashes.createAccountId('gemini', 'bob@example.com'),
)

const modelsModuleUrl = toDataModule(readSource('src/shared/models.ts'))
const models = await import(modelsModuleUrl)
assert.deepEqual(
  models.FILE_SAVE_POLICIES,
  ['never', 'per-conversation'],
  'Importance must not be a file-save policy',
)
const panelMessagesJavaScript = ts.transpileModule(
  readSource('src/shared/panel-messages.ts'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText.replaceAll("'./models'", JSON.stringify(modelsModuleUrl))
const panelMessages = await import(
  `data:text/javascript;base64,${Buffer.from(panelMessagesJavaScript).toString('base64')}`
)
const manualSaveMessage = {
  source: panelMessages.PANEL_MESSAGE_SOURCE.PANEL,
  type: panelMessages.PANEL_MESSAGE_TYPE.MANUAL_SAVE,
  requestId: 'request-1',
  conversationId: 'conversation-1',
  allowFiles: true,
  saveImages: false,
}
assert.equal(panelMessages.isPanelToHostMessage(manualSaveMessage), true)
assert.equal(panelMessages.isPanelToHostMessage({
  ...manualSaveMessage,
  allowFiles: 'yes',
}), false)
assert.equal(panelMessages.isPanelToHostMessage({
  ...manualSaveMessage,
  saveImages: 'yes',
}), false)

const messageTimestampsJavaScript = ts.transpileModule(
  readSource('src/shared/message-timestamps.ts'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText.replaceAll("'./models'", JSON.stringify(modelsModuleUrl))
const messageTimestamps = await import(
  `data:text/javascript;base64,${Buffer.from(messageTimestampsJavaScript).toString('base64')}`
)
const sourceTime = Date.UTC(2026, 7, 13, 9, 30, 15)
assert.equal(
  messageTimestamps.parseSourceMessageTimestamp(
    String(sourceTime / 1_000),
    sourceTime,
  ),
  sourceTime,
)
assert.equal(
  messageTimestamps.parseSourceMessageTimestamp(
    new Date(sourceTime).toISOString(),
    sourceTime,
  ),
  sourceTime,
)
assert.equal(
  messageTimestamps.parseSourceMessageTimestamp('同步于刚刚', sourceTime),
  null,
  'Capture/synchronization labels must never become message timestamps',
)
assert.deepEqual(
  messageTimestamps.preserveSourceMessageTimes(
    [{
      role: 'user',
      content: 'same',
      sentAt: sourceTime,
      sentAtPrecision: 'minute',
    }],
    [{ role: 'user', content: 'same' }],
  ),
  [{
    role: 'user',
    content: 'same',
    sentAt: sourceTime,
    sentAtPrecision: 'minute',
  }],
)
const attachmentsJavaScript = ts.transpileModule(
  readSource('src/shared/attachments.ts'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText.replaceAll("'./models'", JSON.stringify(modelsModuleUrl))
const attachmentsModuleUrl = `data:text/javascript;base64,${Buffer.from(attachmentsJavaScript).toString('base64')}`
const attachments = await import(attachmentsModuleUrl)
const validation = await import(toDataModule(readSource('src/services/validation.ts')
  .replaceAll("'../shared/models'", JSON.stringify(modelsModuleUrl))
  .replaceAll("'../shared/attachments'", JSON.stringify(attachmentsModuleUrl))))
const accumulatedAttachments=Array.from({length:57},(_,index)=>({id:index.toString(16).padStart(64,'0'),name:`saved-${index}.png`,kind:'image',mimeType:'image/png',size:3,status:'saved',messageIndex:0,dataUrl:'data:image/png;base64,AQID'}))
assert.equal(validation.hasValidConversationAttachments(accumulatedAttachments),true,'A complete scan must persist images beyond the old 50-image copy cap')
assert.equal(validation.hasValidConversationAttachments(Array.from({length:101},(_,index)=>({...accumulatedAttachments[0],id:index.toString(16).padStart(64,'0')}))),false,'A single capture cannot submit more than 100 attachments')
assert.equal(validation.hasValidStoredConversationAttachments(accumulatedAttachments),true,'Backup import retains valid copies accumulated across complete scans')
assert.equal(validation.hasValidStoredConversationAttachments([...accumulatedAttachments,accumulatedAttachments[0]]),false,'Stored history still rejects duplicate attachment IDs')
assert.equal(validation.hasValidStoredConversationAttachments(Array.from({length:10001},(_,index)=>({...accumulatedAttachments[0],id:index.toString(16).padStart(64,'0')}))),false,'Stored metadata remains bounded')
assert.match(readSource('src/services/data-management-service.ts'),/!hasValidStoredConversationAttachments\(value\.attachments\)/)

assert.equal(attachments.MAX_ATTACHMENT_BINARY_BYTES, 10 * 1_024 * 1_024)
assert.equal(attachments.MAX_CONVERSATION_ATTACHMENT_BYTES, 30 * 1_024 * 1_024)
const tinyImageDataUrl = 'data:image/png;base64,AQID'
assert.deepEqual(attachments.parseAttachmentDataUrl(tinyImageDataUrl), {
  mimeType: 'image/png',
  encoded: 'AQID',
  size: 3,
})
const savedImage = {
  id: 'a'.repeat(64),
  name: 'image.png',
  kind: 'image',
  mimeType: 'image/png',
  size: 3,
  status: 'saved',
  dataUrl: tinyImageDataUrl,
}
assert.equal(attachments.isPersistedAttachmentValid(savedImage), true)
assert.equal(attachments.isPersistedAttachmentValid({
  ...savedImage,
  mimeType: 'image/svg+xml',
  dataUrl: 'data:image/svg+xml;base64,AQID',
}), false)
assert.deepEqual(
  attachments.mergeConversationAttachments(
    [savedImage],
    [{ ...savedImage, status: 'unavailable', dataUrl: undefined }],
  ),
  [savedImage],
  'A temporary attachment read failure must not overwrite saved binary data',
)
assert.deepEqual(
  attachments.mergeConversationAttachments(
    [savedImage],
    [{
      ...savedImage,
      id: 'b'.repeat(64),
      dataUrl: 'data:image/png;base64,BAUG',
    }],
  ),
  [{
    ...savedImage,
    dataUrl: 'data:image/png;base64,BAUG',
  }],
  'A changed temporary URL must update the existing attachment slot',
)
assert.deepEqual(
  attachments.mergeConversationAttachments(
    [savedImage],
    [{
      ...savedImage,
      id: 'c'.repeat(64),
      status: 'unavailable',
      dataUrl: undefined,
      messageIndex: 1,
    }],
  ),
  [{ ...savedImage, messageIndex: 1 }],
  'Position metadata may upgrade an old saved image without losing its binary data',
)
assert.deepEqual(
  attachments.mergeConversationAttachments([savedImage], [], false),
  [],
  'A complete attachment snapshot must remove unmatched legacy attachments',
)

const attachmentPlacement = await import(toDataModule(
  readSource('src/panel/attachment-placement.ts'),
))
const legacyAttachment = { ...savedImage, name: '所上传图片的预览图.png' }
const positionedAttachment = {
  ...savedImage,
  id: 'd'.repeat(64),
  name: 'answer.png',
  messageIndex: 1,
}
const placement = attachmentPlacement.placeConversationAttachments(
  [
    {
      role: 'user',
      content: '请查看图片',
      attachmentNames: ['所上传图片的预览图.png'],
    },
    { role: 'assistant', content: '图片内容如下' },
  ],
  [legacyAttachment, positionedAttachment],
)
assert.deepEqual(placement.byMessage[0], [legacyAttachment])
assert.deepEqual(placement.byMessage[1], [positionedAttachment])
assert.deepEqual(placement.unplaced, [])

const settingsSource = readSource('src/db/settings.ts')
assert.match(settingsSource, /saveImages: true/)
assert.match(settingsSource, /fileSavePolicy: 'per-conversation'/)
assert.match(settingsSource, /value === 'never' \? value : 'per-conversation'/)
assert.match(settingsSource, /attachmentMaxSizeMb: DEFAULT_ATTACHMENT_MAX_SIZE_MB/)
assert.match(settingsSource, /overlayPanelWidth: DEFAULT_OVERLAY_PANEL_WIDTH/)

const filePermissionMigrationSource = readSource(
  'src/services/file-permission-migration.ts',
)
assert.match(filePermissionMigrationSource, /fileSavePolicy !== 'important-only'/)
assert.match(filePermissionMigrationSource, /conversation\.important === true/)
assert.match(filePermissionMigrationSource, /fileAttachmentPermission: true/)
assert.match(filePermissionMigrationSource, /fileSavePolicy: 'per-conversation'/)
assert.doesNotMatch(filePermissionMigrationSource, /updatedAt:/)
assert.doesNotMatch(filePermissionMigrationSource, /contentHash:/)
const databaseModuleUrl = toDataModule(readSource('src/db/database.ts'))
const filePermissionMigrationJavaScript = ts.transpileModule(
  filePermissionMigrationSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText
  .replaceAll("'../db/database'", JSON.stringify(databaseModuleUrl))
  .replaceAll("'../shared/models'", JSON.stringify(modelsModuleUrl))
const filePermissionMigration = await import(
  `data:text/javascript;base64,${Buffer.from(filePermissionMigrationJavaScript).toString('base64')}`
)
assert.equal(filePermissionMigration.needsLegacyImportantFilePermission({
  important: true,
  fileAttachmentPermission: false,
}), true)
assert.equal(filePermissionMigration.needsLegacyImportantFilePermission({
  important: true,
  fileAttachmentPermission: true,
}), false)
assert.equal(filePermissionMigration.needsLegacyImportantFilePermission({
  important: false,
  fileAttachmentPermission: false,
}), false)

const serviceWorkerSource = readSource('src/background/service-worker.ts')
const fileMigrationIndex = serviceWorkerSource.indexOf(
  'await migrateImportantOnlyFilePermissions()',
)
const settingsInitializationIndex = serviceWorkerSource.indexOf(
  'await Promise.all([initializeSettings(), getLocalEnvironment()])',
)
assert.ok(
  fileMigrationIndex >= 0 && fileMigrationIndex < settingsInitializationIndex,
  'The raw legacy policy must migrate before settings normalization',
)

const captureSource = readSource('src/content/attachment-capture.ts')
assert.match(captureSource, /candidate\.kind === 'image' && !policy\.saveImages/)
assert.match(captureSource, /candidate\.kind === 'file' && !policy\.allowFiles/)
assert.match(captureSource, /candidate\.size !== null && candidate\.size > policy\.maximumBytes/)
assert.match(captureSource, /MAX_CONVERSATION_ATTACHMENT_BYTES/)
assert.match(captureSource, /credentials: 'include'/)
assert.match(captureSource, /ATTACHMENT_FETCH_TIMEOUT_MS/)
assert.match(captureSource, /readRenderedImageAttachment/)
assert.match(captureSource, /renderedImage \?\?/)
assert.match(captureSource, /READ_REMOTE_IMAGE/)
assert.match(captureSource, /readRemoteImageAttachment/)
assert.match(captureSource, /readEmbeddedRemoteImage/)
assert.doesNotMatch(
  captureSource,
  /candidates\.slice\(0, MAX_CAPTURE_CANDIDATES\)\.filter/,
  'Duplicate candidates must not consume the bounded unique-candidate slots',
)
assert.match(captureSource, /unique\.length >= MAX_CAPTURE_CANDIDATES/)

const remoteReaderSource = readSource('src/background/remote-image-reader.ts')
assert.match(remoteReaderSource, /getOriginalRemoteImageUrl/)
assert.match(remoteReaderSource, /\[originalUrl, sourceUrl\]/)
assert.match(remoteReaderSource, /redirect: 'follow'/)

const candidateSource = readSource('src/adapters/attachment-candidates.ts')
assert.match(candidateSource, /canvas\.toDataURL/)
assert.match(candidateSource, /renderedDataUrl/)
assert.match(candidateSource, /messageIndex/)
assert.match(candidateSource, /renderedImageDataCache/)
assert.match(candidateSource, /isCredibleUrlOnlyFileName\(urlName\)/)
assert.match(candidateSource, /isOpaqueResourceName\(name\)/)

const observerSource = readSource('src/content/conversation-observer.ts')
const baseSaveIndex = observerSource.indexOf('let saved = await sendRuntimeRequest')
const manualPermissionIndex = observerSource.indexOf(
  'type: RUNTIME_MESSAGE_TYPE.UPDATE_CONVERSATION_FILE_PERMISSION',
  baseSaveIndex,
)
const attachmentCaptureIndex = observerSource.indexOf(
  'const attachments = await captureAttachments',
)
const noCandidateReturnIndex = observerSource.indexOf(
  'if (!hasAttachmentCandidates)',
)
assert.ok(
  baseSaveIndex >= 0 && baseSaveIndex < attachmentCaptureIndex,
  'The exclusion/pinned gate must run before reading attachment bytes',
)
assert.ok(
  manualPermissionIndex > baseSaveIndex &&
    manualPermissionIndex < attachmentCaptureIndex,
  'Explicit manual file permission must be persisted before reading file bytes',
)
assert.ok(
  manualPermissionIndex < noCandidateReturnIndex,
  'Explicit file permission must persist even when the page has not rendered attachment candidates yet',
)
assert.doesNotMatch(observerSource, /important-only/)
assert.match(observerSource, /saved\.fileAttachmentPermission/)
assert.match(observerSource, /saved\.imageAttachmentPermission \?\? settings\.saveImages/)
assert.match(observerSource, /UPDATE_CONVERSATION_IMAGE_PERMISSION/)
assert.match(observerSource, /manuallyAllowFiles/)
assert.match(observerSource, /HAS_SAVED_CONVERSATION/)
assert.match(observerSource, /CHECK_CAPTURE_READINESS/)
assert.match(observerSource, /contentScriptBuildId: EXTENSION_BUILD_ID/g)
assert.doesNotMatch(observerSource, /data-ai-chat-memory-saved-current|ai-chat-memory-saved-indicator-style/)
assert.doesNotMatch(observerSource, /getConversationSidebarElement|scrollIntoView/)
assert.match(observerSource, /SYNC_DETECTED_ACCOUNT_LABEL/)
assert.doesNotMatch(observerSource, /prepend\(/)

const detailSource = readSource('src/panel/pages/ConversationDetailPage.tsx')
assert.match(detailSource, /允许这条对话保存普通文件/)
assert.match(detailSource, /setConversationFileAttachmentPermission/)
assert.match(detailSource, /setConversationImageAttachmentPermission/)
assert.match(detailSource, /conversationSavesImages/)
assert.match(detailSource, /downloadStoredAttachment/)
assert.match(detailSource, /attachment\.dataUrl/)
assert.match(detailSource, /ImagePreviewDialog/)
assert.match(detailSource, /saved-attachment-preview-button/)
assert.match(detailSource, /placeConversationAttachments/)
assert.match(detailSource, /message-saved-attachments/)
assert.match(detailSource, /message\.sentAt/)
assert.match(detailSource, /平台页面提供的消息时间/)
assert.match(detailSource, /isConversationUpdatedExtensionEvent/)
assert.doesNotMatch(detailSource, /saveCurrentHostConversation/)
assert.doesNotMatch(detailSource, /important-only/)
assert.match(detailSource, /图片与文件保存权限保持不变/)
assert.match(detailSource, /请打开原对话并在侧边栏点击更新/)

const imagePreviewSource = readSource(
  'src/panel/components/ImagePreviewDialog.tsx',
)
assert.match(imagePreviewSource, /aria-modal="true"/)
assert.match(imagePreviewSource, /event\.key === 'Escape'/)
assert.match(imagePreviewSource, /关闭图片预览/)

const panelStylesSource = readSource('src/panel/styles.css')
assert.match(panelStylesSource, /cursor: zoom-in/)
assert.match(panelStylesSource, /\.image-preview-backdrop/)
assert.match(
  panelStylesSource,
  /\.saved-attachment-preview-button\s*\{[\s\S]*?aspect-ratio: 4 \/ 3;/,
)
assert.match(
  panelStylesSource,
  /grid-template-columns: repeat\(auto-fill, minmax\(118px, 1fr\)\)/,
)
assert.doesNotMatch(panelStylesSource, /\.saved-attachment-inline-image > img/)

const floatingPanelSource = readSource('src/content/floating-panel.ts')
assert.match(floatingPanelSource, /panel-resize-handle/)
assert.match(floatingPanelSource, /handlePanelResizePointerDown/)
assert.match(floatingPanelSource, /MIN_OVERLAY_PANEL_WIDTH/)
assert.match(floatingPanelSource, /MAX_OVERLAY_PANEL_WIDTH/)
assert.match(floatingPanelSource, /overlayPanelWidth/)
assert.match(floatingPanelSource, /CONVERSATION_CONTEXT_CHANGED/)

const appSource = readSource('src/panel/App.tsx')
assert.match(appSource, /CurrentConversationPanel/)
assert.match(appSource, /manager-sidebar/)

const currentControllerSource = readSource(
  'src/panel/pages/CurrentConversationPanel.tsx',
)
assert.match(currentControllerSource, /getSavedConversation/)
assert.match(currentControllerSource, /setConversationImportant/)
assert.match(currentControllerSource, /setConversationFileAttachmentPermission/)
assert.match(currentControllerSource, /setConversationImageAttachmentPermission/)
assert.match(currentControllerSource, /controller-compact-permissions/)
assert.match(currentControllerSource, /aria-label="附件保存设置"/)
assert.match(currentControllerSource, /附件设置已更改/)
assert.match(currentControllerSource, /更新并补齐附件/)
assert.match(currentControllerSource, /正在读取完整对话…/)
assert.match(currentControllerSource, /controller-heading-important/)
assert.match(currentControllerSource, /图片与文件保存权限保持不变/)
assert.match(currentControllerSource, /openManager/)
assert.match(currentControllerSource, /openManager\(conversation\?\.id\)/)
assert.match(currentControllerSource, /saveFilesOnFirstCapture/)
assert.match(currentControllerSource, /fileCaptureAuthorized/)
assert.match(
  currentControllerSource,
  /saveCurrentHostConversation\([\s\S]*?fileCaptureAuthorized/,
)
const toggleImportantSource = currentControllerSource.slice(
  currentControllerSource.indexOf('const toggleImportant'),
  currentControllerSource.indexOf('const toggleFilePermission'),
)
const toggleFilePermissionSource = currentControllerSource.slice(
  currentControllerSource.indexOf('const toggleFilePermission'),
  currentControllerSource.indexOf('const toggleImagePermission'),
)
const toggleImagePermissionSource = currentControllerSource.slice(
  currentControllerSource.indexOf('const toggleImagePermission'),
  currentControllerSource.indexOf('const autoSaveEnabled'),
)
assert.doesNotMatch(toggleImportantSource, /fileSavePolicy|saveCurrentHostConversation/)
assert.doesNotMatch(toggleFilePermissionSource, /saveCurrentHostConversation/)
assert.doesNotMatch(toggleImagePermissionSource, /saveCurrentHostConversation/)
assert.match(toggleFilePermissionSource, /files: true/)
assert.match(toggleImagePermissionSource, /images: true/)

const panelMessagesSource = readSource('src/shared/panel-messages.ts')
assert.match(panelMessagesSource, /allowFiles\?: boolean/)
assert.match(panelMessagesSource, /typeof value\.allowFiles === 'boolean'/)
assert.match(panelMessagesSource, /saveImages\?: boolean/)
assert.match(panelMessagesSource, /typeof value\.saveImages === 'boolean'/)

const extensionEventsSource = readSource('src/shared/extension-events.ts')
assert.match(extensionEventsSource, /CONVERSATION_UPDATED/)

const managerAppSource = readSource('src/panel/App.tsx')
assert.match(managerAppSource, /URLSearchParams\(location\.hash\.slice\(1\)\)/)
assert.match(managerAppSource, /getConversation\(conversationId\)/)

const chatGPTAdapterSource = readSource(
  'src/adapters/chatgpt/chatgpt-adapter.ts',
)
const chatGPTAccountIdentifierSource = chatGPTAdapterSource.slice(
  chatGPTAdapterSource.indexOf('getAccountIdentifier()'),
  chatGPTAdapterSource.indexOf('getAccountLabel()'),
)
assert.match(chatGPTAdapterSource, /sanitizeChatGPTAccountLabel/)
assert.match(chatGPTAccountIdentifierSource, /getAccountIdentity/)
assert.match(chatGPTAccountIdentifierSource, /normalizeChatGPTAccountEmail/)
assert.doesNotMatch(chatGPTAccountIdentifierSource, /getAttribute\('alt'\)/)
assert.doesNotMatch(chatGPTAccountIdentifierSource, /getAttribute\('aria-label'\)/)
assert.match(chatGPTAdapterSource, /const accountIdentifier = this\.getAccountIdentifier\(\)/)
assert.match(chatGPTAdapterSource, /ACCOUNT_DISPLAY_LABEL/)
assert.match(chatGPTAdapterSource, /ACCOUNT_PROFILE_TRIGGER/)
assert.match(chatGPTAdapterSource, /ACCOUNT_DISPLAY_LABEL_FALLBACK/)
assert.doesNotMatch(chatGPTAdapterSource, /readText\(profileButton\)/)

const chatGPTSelectorsSource = readSource(
  'src/adapters/chatgpt/selectors.ts',
)
assert.match(chatGPTSelectorsSource, /ACCOUNT_DISPLAY_LABEL/)
assert.match(chatGPTSelectorsSource, /\[class~="truncate"\]/)
assert.match(chatGPTSelectorsSource, /accounts-profile-button/)
assert.match(chatGPTSelectorsSource, /data-marquee-text/)

const geminiSelectorsSource = readSource('src/adapters/gemini/selectors.ts')
assert.match(geminiSelectorsSource, /INLINE_PIN_INDICATOR/)
assert.match(geminiSelectorsSource, /trailing-icon-container/)
assert.match(geminiSelectorsSource, /data-mat-icon-name="push_pin"/)

const accountDatabaseSource = readSource('src/db/accounts.ts')
assert.match(accountDatabaseSource, /isLegacyChatGPTProfileLabel/)
assert.match(accountDatabaseSource, /label: 'Unknown'/)
assert.match(accountDatabaseSource, /account\.source !== 'manual'/)

const accountServiceSource = readSource('src/services/account-service.ts')
assert.match(accountServiceSource, /syncDetectedAccountLabel/)
assert.match(accountServiceSource, /existing\.source === 'manual'/)

const conversationServiceSource = readSource(
  'src/services/conversation-service.ts',
)
assert.match(conversationServiceSource, /canonicalizeConversationAccount/)
assert.match(conversationServiceSource, /isIdentifiedChatGPTAccountId/)
assert.match(conversationServiceSource, /getConversationsBySource/)
assert.match(conversationServiceSource, /getConversationExclusions/)
assert.match(conversationServiceSource, /mergeConversationAttachments/)

const migrationSource = readSource(
  'src/services/chatgpt-account-migration.ts',
)
assert.match(migrationSource, /normalizeChatGPTUnknownAccount/)
assert.doesNotMatch(migrationSource, /\.delete\(|STORE_NAME\.CONVERSATIONS|STORE_NAME\.CONVERSATION_EXCLUSIONS/)

assert.match(serviceWorkerSource, /await normalizeChatGPTUnknownAccount\(\)/)
assert.match(serviceWorkerSource, /await ensureExtensionInitialized\(\)/)
assert.match(serviceWorkerSource, /SYNC_DETECTED_ACCOUNT_LABEL/)
assert.match(serviceWorkerSource, /notifyConversationDeleted/)
assert.match(serviceWorkerSource, /notifyConversationUpdated/)
assert.match(serviceWorkerSource, /removeMirroredConversation/)
assert.match(serviceWorkerSource, /readPermittedRemoteImage/)
assert.match(serviceWorkerSource, /CHECK_CAPTURE_READINESS/)
assert.ok(
  serviceWorkerSource.indexOf('getCaptureReadiness(request.contentScriptBuildId)') <
    serviceWorkerSource.indexOf('const result = await saveConversation'),
  'The background must reject stale or partial builds before any conversation write',
)

const runtimeReadinessSource = readSource('src/background/runtime-readiness.ts')
assert.match(runtimeReadinessSource, /runtime-ready\.json/)
assert.match(runtimeReadinessSource, /chrome\.runtime\.getURL/)
assert.match(runtimeReadinessSource, /cache: 'no-store'/)

const buildSource = readSource('scripts/build-extension.mjs')
assert.match(buildSource, /AI_CHAT_MEMORY_OUT_DIR: stage/)
assert.match(buildSource, /publishVerifiedBuild/)
assert.match(buildSource, /rmSync\(join\(destination, markerName\), \{ force: true \}\)/)
assert.doesNotMatch(
  buildSource,
  /rmSync\(destination,\s*\{[^}]*recursive:\s*true/,
  'Publishing must never recursively delete the live dist directory',
)

const remoteImageSource = readSource('src/background/remote-image-reader.ts')
assert.match(remoteImageSource, /lh3\.googleusercontent\.com|isPermittedRemoteImageUrl/)
assert.match(remoteImageSource, /credentials: 'include'/)
assert.match(remoteImageSource, /MAX_ATTACHMENT_BINARY_BYTES/)

const embeddedImageReaderSource = readSource('src/content/embedded-image-reader.ts')
assert.match(embeddedImageReaderSource, /image-reader\.html/)
assert.match(embeddedImageReaderSource, /MessageChannel/)
assert.match(embeddedImageReaderSource, /isPermittedRemoteImageForHost/)

const deletionSource = readSource('src/db/conversation-exclusions.ts')
assert.match(deletionSource, /conversationStore\.delete\(id\)/)
const sharedDirectorySource = readSource('src/services/shared-directory-service.ts')
assert.match(sharedDirectorySource, /removeEntry\(`\$\{conversationId\}\.json`\)/)
const contentScriptSource = readSource('src/content/content-script.ts')
assert.match(contentScriptSource, /showRuntimeUnavailableNotice/)
assert.match(contentScriptSource, /Chrome 无法在不刷新宿主页的情况下替换它/)
assert.match(contentScriptSource, /width: min\(340px/)
assert.match(contentScriptSource, /left: 9px/)
assert.match(contentScriptSource, /justify-content: center/)
assert.match(contentScriptSource, /关闭提示/)
assert.match(contentScriptSource, /host\.remove\(\)/)
assert.match(contentScriptSource, /刷新本页并启用新版插件/)
assert.match(contentScriptSource, /CHECK_CAPTURE_READINESS/)
assert.match(contentScriptSource, /RUNTIME_HEALTH_CHECK_MS/)
assert.match(contentScriptSource, /stopForUnavailableRuntime/)
assert.match(contentScriptSource, /forgetDeletedConversation/)

const importSource = readSource('src/services/data-management-service.ts')
assert.match(importSource, /fileAttachmentPermission/)
assert.match(importSource, /Boolean\(existing\?\.fileAttachmentPermission\)/)
assert.match(importSource, /imageAttachmentPermission/)
assert.match(importSource, /mergeImageAttachmentPermission/)

const runtimeMessagesSource = readSource('src/shared/runtime-messages.ts')
assert.match(runtimeMessagesSource, /UPDATE_CONVERSATION_IMAGE_PERMISSION/)
const conversationDatabaseSource = readSource('src/db/conversations.ts')
assert.match(conversationDatabaseSource, /imageAttachmentPermission/)

assert.match(
  observerSource,
  /incoming\.captureComplete === true[\s\S]*?incoming\.attachmentCandidates \?\? \[\]/,
  'A complete page snapshot must own attachment-candidate presence',
)
assert.match(observerSource, /mergeCompleteConversationMessages\(/)

const hostBridgeSource = readSource('src/panel/services/host-bridge.ts')
assert.doesNotMatch(
  hostBridgeSource,
  /MANUAL_SAVE_TIMEOUT_MS|手动保存等待超时/,
  'The panel must wait for the collector result instead of imposing a fixed timeout',
)

assert.match(conversationServiceSource, /attachmentSnapshotComplete/)
assert.match(conversationServiceSource, /delete next\.attachmentNames/)
assert.match(
  observerSource,
  /attachments: \[\], attachmentSnapshotComplete: true/,
  'A complete DOM snapshot with no candidates must explicitly clear stale attachments',
)

console.log('attachment, resize, and ChatGPT account verification passed')
