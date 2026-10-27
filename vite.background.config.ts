import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const extensionOutDir = process.env.AI_CHAT_MEMORY_OUT_DIR ?? '.dist-build'
const extensionBuildId = process.env.AI_CHAT_MEMORY_BUILD_ID ?? 'development'

export default defineConfig({
  publicDir: false,
  define: {
    __AI_CHAT_MEMORY_BUILD_ID__: JSON.stringify(extensionBuildId),
  },
  build: {
    outDir: `${extensionOutDir}/background`,
    emptyOutDir: false,
    copyPublicDir: false,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/background/service-worker.ts', import.meta.url)),
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'service-worker.js',
      },
    },
  },
})
