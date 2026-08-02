import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// NOT a single-file build, and that is the one way home differs from every
// other app here. The others compile to one HTML file because that file IS the
// document. Home is not a document — it is a page served from a stable origin,
// and the stable origin is the entire point: a `file://` page has an opaque
// origin and cannot keep file handles between sessions.
//
// base './' so the built page can be published under any path (bento.page/home).
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { fs: { allow: ['..'] } },
  build: { chunkSizeWarningLimit: 1024 },
})
