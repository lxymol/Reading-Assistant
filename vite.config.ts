import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const pdfAssetRoot = path.resolve('node_modules/pdfjs-dist')
const pdfAssetFolders = ['cmaps', 'standard_fonts', 'wasm']

const pdfAssets = () => ({
  name: 'raid-pdf-assets',
  configureServer(server: { middlewares: { use: (route: string, handler: (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => void) => void } }) {
    server.middlewares.use('/pdfjs-assets', (req, res, next) => {
      const relative = decodeURIComponent(req.url || '').replace(/^\/+/, '')
      const target = path.resolve(pdfAssetRoot, relative)
      if (!target.startsWith(`${pdfAssetRoot}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return next()
      if (target.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
      else if (target.endsWith('.ttf')) res.setHeader('Content-Type', 'font/ttf')
      else res.setHeader('Content-Type', 'application/octet-stream')
      fs.createReadStream(target).pipe(res)
    })
  },
  closeBundle() {
    for (const folder of pdfAssetFolders) fs.cpSync(path.join(pdfAssetRoot, folder), path.resolve('dist/pdfjs-assets', folder), { recursive: true })
  },
})

export default defineConfig({
  plugins: [react(), pdfAssets()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
})
