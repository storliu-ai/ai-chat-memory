import { MAX_ATTACHMENT_BINARY_BYTES } from '../shared/attachments'
import {
  isImageReaderRequest,
  type ImageReaderResponse,
} from '../shared/image-reader-messages'
import { isPermittedRemoteImageForHost } from '../shared/remote-images'
import { readPermittedRemoteImage } from '../background/remote-image-reader'

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const port = event.ports[0]
  if (
    event.source !== window.parent ||
    port === undefined ||
    !isImageReaderRequest(event.data) ||
    event.data.maximumBytes > MAX_ATTACHMENT_BINARY_BYTES ||
    !isPermittedRemoteImageForHost(event.data.sourceUrl, event.origin)
  ) {
    port?.postMessage({ ok: false } satisfies ImageReaderResponse)
    port?.close()
    return
  }

  void readPermittedRemoteImage(
    event.data.sourceUrl,
    event.data.maximumBytes,
  ).then((result) => {
    port.postMessage(result === null
      ? { ok: false } satisfies ImageReaderResponse
      : { ok: true, ...result } satisfies ImageReaderResponse)
  }).catch(() => {
    port.postMessage({ ok: false } satisfies ImageReaderResponse)
  }).finally(() => {
    port.close()
  })
})
