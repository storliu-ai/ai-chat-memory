import {
  IMAGE_READER_MESSAGE_SOURCE,
  IMAGE_READER_MESSAGE_TYPE,
  isImageReaderResponse,
  type ImageReaderResponse,
} from '../shared/image-reader-messages'
import { isPermittedRemoteImageForHost } from '../shared/remote-images'

const IMAGE_READER_FRAME_ID = 'ai-chat-memory-image-reader-frame'
const IMAGE_READER_TIMEOUT_MS = 15_000
let framePromise: Promise<HTMLIFrameElement> | null = null

function createImageReaderFrame(): Promise<HTMLIFrameElement> {
  const existing = document.getElementById(IMAGE_READER_FRAME_ID)
  if (existing instanceof HTMLIFrameElement && existing.isConnected) {
    return Promise.resolve(existing)
  }

  const frame = document.createElement('iframe')
  frame.id = IMAGE_READER_FRAME_ID
  frame.src = chrome.runtime.getURL('image-reader.html')
  frame.setAttribute('data-extension-ui', 'ai-chat-memory')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.setProperty('display', 'none', 'important')
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      frame.remove()
      reject(new Error('Image reader frame did not load'))
    }, 5_000)
    frame.addEventListener('load', () => {
      window.clearTimeout(timeout)
      resolve(frame)
    }, { once: true })
    ;(document.body ?? document.documentElement).append(frame)
  })
}

async function getImageReaderFrame(): Promise<HTMLIFrameElement> {
  if (framePromise === null) {
    framePromise = createImageReaderFrame().catch((error: unknown) => {
      framePromise = null
      throw error
    })
  }
  const frame = await framePromise
  if (!frame.isConnected || frame.contentWindow === null) {
    framePromise = null
    return getImageReaderFrame()
  }
  return frame
}

export async function readEmbeddedRemoteImage(
  sourceUrl: string,
  maximumBytes: number,
): Promise<ImageReaderResponse | null> {
  if (!isPermittedRemoteImageForHost(sourceUrl, location.origin)) {
    return null
  }
  try {
    const frame = await getImageReaderFrame()
    const target = frame.contentWindow
    if (target === null) {
      return null
    }
    const channel = new MessageChannel()
    return await new Promise((resolve) => {
      const finish = (value: ImageReaderResponse | null): void => {
        window.clearTimeout(timeout)
        channel.port1.close()
        resolve(value)
      }
      const timeout = window.setTimeout(
        () => finish(null),
        IMAGE_READER_TIMEOUT_MS,
      )
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        finish(isImageReaderResponse(event.data) ? event.data : null)
      }
      channel.port1.start()
      target.postMessage({
        source: IMAGE_READER_MESSAGE_SOURCE,
        type: IMAGE_READER_MESSAGE_TYPE,
        sourceUrl,
        maximumBytes,
      }, chrome.runtime.getURL('').replace(/\/$/, ''), [channel.port2])
    })
  } catch {
    return null
  }
}
