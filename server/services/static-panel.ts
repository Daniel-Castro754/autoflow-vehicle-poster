import type { IncomingMessage, ServerResponse } from 'node:http'
import { open } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function servePanel(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dist: string,
) {
  if (!['GET', 'HEAD'].includes(req.method || '')) return false
  const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  if (
    path !== 'index.html' &&
    path !== 'favicon.svg' &&
    !/^assets\/[\w.-]+\.(?:js|css|woff2)$/.test(path)
  )
    return false
  const file = await open(join(dist, path), 'r').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!file) return false
  try {
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    }
    const info = await file.stat()
    res.writeHead(200, {
      'Content-Type': types[extname(path)],
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': path.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    if (req.method === 'HEAD') res.end()
    else await pipeline(file.createReadStream({ autoClose: false }), res)
    return true
  } finally {
    await file.close()
  }
}
