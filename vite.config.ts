import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const extensionOutDir = process.env.AI_CHAT_MEMORY_OUT_DIR ?? '.dist-build'
const extensionBuildId = process.env.AI_CHAT_MEMORY_BUILD_ID ?? 'development'

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __AI_CHAT_MEMORY_BUILD_ID__: JSON.stringify(extensionBuildId),
  },
  build: {
    outDir: extensionOutDir,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
        manager: fileURLToPath(new URL('./manager.html', import.meta.url)),
        storage: fileURLToPath(new URL('./storage.html', import.meta.url)),
        imageReader: fileURLToPath(new URL('./image-reader.html', import.meta.url)),
      },
    },
  },
})
