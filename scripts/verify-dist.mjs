import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const configuredDist = process.env.AI_CHAT_MEMORY_DIST_DIR ?? 'dist'
const dist = isAbsolute(configuredDist)
  ? configuredDist
  : resolve(root, configuredDist)
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))

const references = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...manifest.content_scripts.flatMap((entry) => entry.js),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter((value) => typeof value === 'string')

references.push('storage.html')
references.push('manager.html')
references.push('image-reader.html')
references.push('privacy.html')
references.push('license.html')
references.push('LICENSE')
references.push('COPYRIGHT')
references.push('THIRD_PARTY_NOTICES')
references.push('SOURCES.md')
references.push('corresponding-source.zip')
references.push('runtime-ready.json')

const missing = [...new Set(references)].filter(
  (reference) => !existsSync(join(dist, reference)),
)
if (missing.length > 0) {
  throw new Error(`Manifest references missing build files: ${missing.join(', ')}`)
}

if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== '118') {
  throw new Error('Manifest V3 and Chrome 118 minimum are required')
}

const permissions = manifest.permissions ?? []
if (permissions.length !== 1 || permissions[0] !== 'debugger') {
  throw new Error(`Unexpected extension permissions: ${permissions.join(', ')}`)
}
const expectedHostPermissions = [
  'https://share.gemini.google/*',
  'https://gemini.google.com/share/*',
  'https://lh3.googleusercontent.com/*',
  'https://lh3.google.com/*',
  'https://*.oaiusercontent.com/*',
  'https://images.openai.com/*',
]
if (
  !Array.isArray(manifest.host_permissions) ||
  manifest.host_permissions.length !== expectedHostPermissions.length ||
  !expectedHostPermissions.every((permission) =>
    manifest.host_permissions.includes(permission),
  )
) {
  throw new Error('Only the approved image and explicit public-share hosts may be requested')
}
if (manifest.action?.default_popup !== undefined) {
  throw new Error('Toolbar Action must open the independent Manager tab')
}

const accessibleResources = manifest.web_accessible_resources ?? []
const supportedMatches = [
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
  'https://chat.deepseek.com/*',
]
if (
  accessibleResources.length !== 1 ||
  accessibleResources[0].resources.length !== 2 ||
  !accessibleResources[0].resources.includes('panel.html') ||
  !accessibleResources[0].resources.includes('image-reader.html') ||
  accessibleResources[0].matches.length !== supportedMatches.length ||
  !supportedMatches.every((match) => accessibleResources[0].matches.includes(match))
) {
  throw new Error('Only panel/image-reader pages may be exposed to supported AI chat sites')
}

const contentMatches = manifest.content_scripts.flatMap((entry) => entry.matches)
if (
  contentMatches.length !== supportedMatches.length ||
  !supportedMatches.every((match) => contentMatches.includes(match))
) {
  throw new Error('Content Script must be restricted to supported AI chat sites')
}

function collectFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name)
    return statSync(absolute).isDirectory() ? collectFiles(absolute) : [absolute]
  })
}

const sourceFiles = collectFiles(join(root, 'src')).filter((file) => /\.[cm]?[jt]sx?$/.test(file))
const attachmentCaptureFile = join(root, 'src/content/attachment-capture.ts')
const remoteImageReaderFile = join(root, 'src/background/remote-image-reader.ts')
const runtimeReadinessFile = join(root, 'src/background/runtime-readiness.ts')
const geminiShareResolverFile = join(root, 'src/adapters/gemini/capture-urls.ts')
const source = sourceFiles
  .filter((file) =>
    file !== attachmentCaptureFile &&
    file !== remoteImageReaderFile &&
    file !== runtimeReadinessFile && file !== geminiShareResolverFile,
  )
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
const forbiddenSourcePatterns = [
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\b/i,
  /\bEventSource\b/i,
  /\bsendBeacon\b/i,
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bchrome\.cookies\b/i,
  /\bhistory\.(?:pushState|replaceState)\b/i,
  /\beval\s*\(/i,
  /\bnew\s+Function\b/i,
  /\banalytics\b/i,
  /\btelemetry\b/i,
  /\bsentry\b/i,
]
const forbiddenMatch = forbiddenSourcePatterns.find((pattern) => pattern.test(source))
if (forbiddenMatch) {
  throw new Error(`Forbidden source API matched: ${forbiddenMatch}`)
}
const resolverSource = readFileSync(geminiShareResolverFile, 'utf8')
if ((resolverSource.match(/\bfetch\s*\(/g) ?? []).length !== 1 || !resolverSource.includes("credentials: 'omit'") || !resolverSource.includes('response.body?.cancel()') || !resolverSource.includes('getGeminiShareId(canonical)') || !resolverSource.includes('8000')) throw new Error('Public Gemini short-link expansion must remain bounded, credential-free and canonical-share-only')
const debuggerFile = join(root, 'src/background/network-debug-session.ts')
for (const file of sourceFiles) {
  if (file !== debuggerFile && /\bchrome\.debugger\b/i.test(readFileSync(file, 'utf8'))) throw new Error('Only the bounded network debug session may access the debugger API')
}
const debuggerSource = readFileSync(debuggerFile, 'utf8')
const approvedCommands = ['Page.enable', 'Page.getFrameTree', 'Network.enable', 'Network.getResponseBody', 'Network.streamResourceContent']
const commands = [...debuggerSource.matchAll(/this\.command\('([^']+)'/g)].map((match) => match[1])
const declaredCommands = [...(/const COMMANDS = \[([^\]]+)\]/.exec(debuggerSource)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])
const apiMethods = [...debuggerSource.matchAll(/chrome\.debugger\.(\w+)/g)].map((match) => match[1])
if (commands.length !== approvedCommands.length || !commands.every((command) => approvedCommands.includes(command)) ||
  declaredCommands.length !== approvedCommands.length || !declaredCommands.every((command) => approvedCommands.includes(command)) ||
  apiMethods.some((method) => !['attach', 'detach', 'sendCommand', 'onEvent', 'onDetach', 'Debuggee'].includes(method)) ||
  (debuggerSource.match(/chrome\.debugger\.sendCommand\(/g) ?? []).length !== 1 ||
  !debuggerSource.includes('!COMMANDS.includes(method)') || !debuggerSource.includes('matchChatGPTCaptureEndpoint') ||
  !debuggerSource.includes('event.frameId !== this.frameId') || !debuggerSource.includes('pending.loaderId !== this.loaderId') ||
  !debuggerSource.includes('MAX_RESOURCE_BYTES') || !debuggerSource.includes('MAX_TOTAL_BYTES') ||
  !debuggerSource.includes('MAX_PENDING_REQUESTS') || !debuggerSource.includes('MAX_CONCURRENT_READS')) {
  throw new Error('Debugger access must keep the exact command allowlist, target/frame/loader binding and response limits')
}

const attachmentCaptureSource = readFileSync(attachmentCaptureFile, 'utf8')
const attachmentFetches = attachmentCaptureSource.match(/\bfetch\s*\(/g) ?? []
if (
  attachmentFetches.length !== 2 ||
  !/credentials:\s*'include'/.test(attachmentCaptureSource) ||
  /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/i.test(
    attachmentCaptureSource,
  )
) {
  throw new Error('Only the bounded attachment reader may fetch host-page resources')
}

const remoteImageReaderSource = readFileSync(remoteImageReaderFile, 'utf8')
const remoteImageFetches = remoteImageReaderSource.match(/\bfetch\s*\(/g) ?? []
if (
  remoteImageFetches.length !== 1 ||
  !/isPermittedRemoteImageUrl/.test(remoteImageReaderSource) ||
  !/credentials:\s*'include'/.test(remoteImageReaderSource) ||
  !/cache:\s*'force-cache'/.test(remoteImageReaderSource) ||
  !/MAX_ATTACHMENT_BINARY_BYTES/.test(remoteImageReaderSource)
) {
  throw new Error('The background image reader must remain host-limited and size-bounded')
}

const runtimeReadinessSource = readFileSync(runtimeReadinessFile, 'utf8')
if (
  (runtimeReadinessSource.match(/\bfetch\s*\(/g) ?? []).length !== 1 ||
  !/chrome\.runtime\.getURL\(RUNTIME_READY_MARKER\)/.test(runtimeReadinessSource) ||
  !/cache:\s*'no-store'/.test(runtimeReadinessSource) ||
  /https?:\/\//i.test(runtimeReadinessSource)
) {
  throw new Error('Runtime readiness may only fetch the packaged completion marker')
}

const runtimeMarker = JSON.parse(
  readFileSync(join(dist, 'runtime-ready.json'), 'utf8'),
)
if (
  typeof runtimeMarker.buildId !== 'string' ||
  runtimeMarker.buildId !== process.env.AI_CHAT_MEMORY_BUILD_ID
) {
  throw new Error('Runtime completion marker does not match the bundled build')
}

const contentScript = readFileSync(join(dist, 'content/content-script.js'), 'utf8')
if (/chrome\.debugger/.test(contentScript)) throw new Error('Debugger access must never enter the content-script bundle')
if (/^\s*(?:import|export)\b/m.test(contentScript)) {
  throw new Error('Content Script must be a self-contained IIFE without module syntax')
}

const serviceWorker = readFileSync(join(dist, 'background/service-worker.js'), 'utf8')
if (!/manager\.html/.test(serviceWorker)) {
  throw new Error('Toolbar Action must open manager.html')
}

const imageReaderHtml = readFileSync(join(dist, 'image-reader.html'), 'utf8')
const imageReaderScript = /<script[^>]+src="\.\/(assets\/[^"?]+\.js)"/.exec(
  imageReaderHtml,
)?.[1]
if (imageReaderScript === undefined) {
  throw new Error('Image reader entry script is missing')
}
const imageReaderJavaScript = readFileSync(join(dist, imageReaderScript), 'utf8')
if (
  (imageReaderJavaScript.match(/\bfetch\s*\(/g) ?? []).length !== 1 ||
  !/lh3\.googleusercontent\.com/.test(imageReaderJavaScript) ||
  !/oaiusercontent\.com/.test(imageReaderJavaScript)
) {
  throw new Error('Embedded image reader must remain host-limited and bounded')
}

const builtJavaScript = collectFiles(dist)
  .filter((file) =>
    file.endsWith('.js') &&
    !file.endsWith('content/content-script.js') &&
    !file.endsWith('background/service-worker.js') &&
    file !== join(dist, imageReaderScript),
  )
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
if (/\bfetch\s*\(/.test(builtJavaScript)) {
  throw new Error('Only the Content Script attachment reader may contain fetch calls')
}
if (/chrome\.debugger/.test(builtJavaScript)) throw new Error('Debugger access must never enter UI or shared bundles')
if (/localhost|127\.0\.0\.1|\/@vite\/client/i.test(builtJavaScript)) {
  throw new Error('Production bundles must not reference a development server')
}

const backgroundFetches = serviceWorker.match(/\bfetch\s*\(/g) ?? []
if (backgroundFetches.length !== 3) {
  throw new Error('The service worker may only fetch approved images, explicit public Gemini share expansion and its local marker')
}

console.log('dist verification passed')
