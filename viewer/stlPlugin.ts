import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'
import { buildBambu3mf } from './bambu/write3mf'
import type { CatalogNode } from './src/types'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const stlRoot = path.resolve(pluginDir, '../Nova-SM3/STL Files')
const modelExtensions = ['.stl', '.3mf']

function isModelFile(name: string): boolean {
  const lower = name.toLowerCase()
  return modelExtensions.some((ext) => lower.endsWith(ext))
}

function modelContentType(name: string): string {
  return name.toLowerCase().endsWith('.3mf')
    ? 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
    : 'model/stl'
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
}

function scan(dir: string, relative: string): CatalogNode[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const nodes: CatalogNode[] = []

  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const children = scan(full, childRelative)
      if (children.length > 0) {
        nodes.push({ name: entry.name, path: childRelative, children })
      }
    } else if (entry.isFile() && isModelFile(entry.name)) {
      const stat = fs.statSync(full)
      nodes.push({ name: entry.name, path: childRelative, size: stat.size })
    }
  }

  nodes.sort((a, b) => {
    const aFolder = a.children ? 0 : 1
    const bFolder = b.children ? 0 : 1
    if (aFolder !== bFolder) return aFolder - bFolder
    return compareName(a.name, b.name)
  })

  return nodes
}

function safeStlPath(pathname: string): string | null {
  let relative = pathname.replace(/^\/+/, '')
  try {
    relative = decodeURIComponent(relative)
  } catch {
    return null
  }
  if (!relative || relative.includes('\0')) return null
  if (!isModelFile(relative)) return null

  const full = path.resolve(stlRoot, relative)
  const root = path.resolve(stlRoot)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

function sendJson(res: Connect.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(payload)
}

function requestPath(rawUrl: string): string {
  const query = rawUrl.indexOf('?')
  return query === -1 ? rawUrl : rawUrl.slice(0, query)
}

function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function fileNameFrom(req: Connect.IncomingMessage): string {
  const raw = req.headers['x-file-name']
  const header = Array.isArray(raw) ? raw[0] : raw
  if (!header) return 'part.stl'
  try {
    return decodeURIComponent(header)
  } catch {
    return 'part.stl'
  }
}

async function handleBambu(req: Connect.IncomingMessage, res: Connect.ServerResponse) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end('POST만 받을 수 있습니다.')
    return
  }
  try {
    const stl = await readBody(req)
    const archive = buildBambu3mf(stl, fileNameFrom(req))
    const downloadName = fileNameFrom(req).replace(/\.(stl|3mf)$/i, '') + '_ams_support.3mf'
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`)
    res.setHeader('Content-Length', archive.length)
    res.end(archive)
  } catch (error) {
    const message = error instanceof Error ? error.message : '3MF를 만들지 못했습니다.'
    sendJson(res, 400, { error: message })
  }
}

function handle(req: Connect.IncomingMessage, res: Connect.ServerResponse, next: Connect.NextFunction) {
  const pathname = requestPath(req.url ?? '/')

  if (pathname === '/api/bambu-3mf') {
    void handleBambu(req, res)
    return
  }

  if (pathname === '/api/catalog') {
    if (!fs.existsSync(stlRoot)) {
      sendJson(res, 500, { error: 'STL 폴더를 찾을 수 없습니다.' })
      return
    }
    sendJson(res, 200, scan(stlRoot, ''))
    return
  }

  if (pathname === '/stl' || pathname.startsWith('/stl/')) {
    const full = safeStlPath(pathname.slice('/stl/'.length))
    if (!full) {
      res.statusCode = 400
      res.end('잘못된 경로입니다.')
      return
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.statusCode = 404
      res.end('파일을 찾을 수 없습니다.')
      return
    }
    const stat = fs.statSync(full)
    res.statusCode = 200
    res.setHeader('Content-Type', modelContentType(full))
    res.setHeader('Content-Length', stat.size)
    const stream = fs.createReadStream(full)
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    })
    stream.pipe(res)
    return
  }

  next()
}

export function stlFilesPlugin(): Plugin {
  return {
    name: 'nova-sm3-stl-files',
    configureServer(server) {
      server.middlewares.use(handle)
    },
  }
}

export { stlRoot }
