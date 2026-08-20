import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CrunchyrollApp } from './app.js'
import { CrError } from './cr/errors.js'
import { loadRewrittenManifest, resolveCdnUrl } from './cr/proxy.js'
import { DEFAULT_PORT } from './cr/constants.js'

const here = dirname(fileURLToPath(import.meta.url))
const uiHtml = () => readFileSync(join(here, 'ui', 'index.html'), 'utf8')
const providerSrc = () => readFileSync(join(here, 'izumi', 'provider.js'), 'utf8')

const ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#f47521"/><path fill="#fff" d="M18 32c0-9 7-16 16-16 5 0 9 2 12 5l-6 6c-1-2-4-3-6-3-5 0-8 4-8 8s3 8 8 8c2 0 5-1 6-3l6 6c-3 3-7 5-12 5-9 0-16-7-16-16z"/></svg>',
  )

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
}

function fail(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const auth = /not logged in|session expired|invalid_grant|sign in/i.test(message)
  const status = auth
    ? 401
    : error instanceof CrError ? (error.status >= 400 && error.status < 600 ? error.status : 502) : 400
  send(res, status, { error: message })
}

export function listen(app: CrunchyrollApp, port = DEFAULT_PORT): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(app, req, res)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actual = typeof address === 'object' && address ? address.port : port
      app.baseUrl = `http://127.0.0.1:${actual}`
      resolve({
        port: actual,
        close: () => new Promise((done, failClose) => server.close((err) => err ? failClose(err) : done())),
      })
    })
  })
}

async function handle(app: CrunchyrollApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', app.baseUrl)
  if (url.pathname !== '/favicon.ico') {
    console.log(`[http] ${req.method} ${url.pathname}`)
  }
  if (req.method === 'OPTIONS') {
    send(res, 204, '')
    return
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(res, 200, uiHtml(), 'text/html; charset=utf-8')
      return
    }
    if (req.method === 'GET' && url.pathname === '/index.json') {
      send(res, 200, {
        id: 'crunchyroll.izumi',
        name: 'Crunchyroll',
        version: '0.1.0',
        type: 'onlinestream-provider',
        lang: 'en',
        description: 'Crunchyroll account source. Requires your Crunchyroll login.',
        icon: ICON,
        main: 'provider.js',
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/provider.js') {
      send(res, 200, providerSrc().replaceAll('__BASE__', app.baseUrl), 'application/javascript; charset=utf-8')
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(res, 200, { ...app.status(), manifestUrl: `${app.baseUrl}/index.json` })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/login/etp') {
      const body = await jsonBody(req)
      send(res, 200, await app.loginEtpRt(String(body.etpRt ?? body.etp_rt ?? '')))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/login/password') {
      const body = await jsonBody(req)
      send(res, 200, await app.loginPassword(String(body.username ?? ''), String(body.password ?? '')))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/login/device') {
      send(res, 200, await app.requestDeviceCode())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/login/device/status') {
      send(res, 200, app.deviceStatus())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/login/device/poll') {
      const body = await jsonBody(req)
      send(res, 200, await app.pollDeviceCode(String(body.deviceCode ?? '')))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      app.logout()
      send(res, 200, { ok: true })
      return
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/search') {
      const body = req.method === 'POST' ? await jsonBody(req) : {}
      const query = String(url.searchParams.get('query') ?? body.query ?? '')
      const dubRaw = url.searchParams.get('dub') ?? body.dub
      const dub = dubRaw === true || dubRaw === '1' || dubRaw === 'true'
      const yearRaw = url.searchParams.get('year') ?? body.year
      const year = yearRaw == null || yearRaw === '' ? undefined : Number(yearRaw)
      console.log(`[http] search query=${JSON.stringify(query)} dub=${dub} year=${year ?? ''}`)
      send(res, 200, { results: await app.search(query, dub, Number.isFinite(year) ? year : undefined) })
      return
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/episodes') {
      const body = req.method === 'POST' ? await jsonBody(req) : {}
      const id = String(url.searchParams.get('id') ?? body.id ?? '')
      console.log(`[http] episodes id=${id}`)
      send(res, 200, { episodes: await app.episodes(id) })
      return
    }
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/play') {
      const body = req.method === 'POST' ? await jsonBody(req) : {}
      const id = String(url.searchParams.get('id') ?? body.id ?? '')
      console.log(`[http] play id=${id}`)
      send(res, 200, await app.episodeServer(id))
      return
    }
    const manifest = url.pathname.match(/^\/v\/([^/]+)\/manifest\.(mpd|m3u8)$/)
    if (req.method === 'GET' && manifest) {
      const session = app.session(manifest[1] ?? '')
      if (!session) {
        send(res, 404, { error: 'unknown play session' })
        return
      }
      const rewritten = await loadRewrittenManifest(app.play, session, app.baseUrl)
      send(res, 200, rewritten.body, rewritten.contentType)
      return
    }
    const asset = url.pathname.match(/^\/v\/([^/]+)\/asset$/)
    if (req.method === 'GET' && asset) {
      const session = app.session(asset[1] ?? '')
      const target = url.searchParams.get('u')
      if (!session || !target) {
        send(res, 404, { error: 'unknown asset' })
        return
      }
      const fetched = await app.play.fetchBinary(session, target)
      send(res, fetched.status, fetched.body, fetched.contentType)
      return
    }
    const cdn = url.pathname.match(/^\/v\/([^/]+)\/cdn\/(.*)$/)
    if (req.method === 'GET' && cdn) {
      const session = app.session(cdn[1] ?? '')
      const target = session ? resolveCdnUrl(session, cdn[2] ?? '', url.search) : undefined
      if (!session || !target) {
        send(res, 404, { error: 'unknown cdn asset' })
        return
      }
      const fetched = await app.play.fetchBinary(session, target)
      send(res, fetched.status, fetched.body, fetched.contentType)
      return
    }
    const relative = url.pathname.match(/^\/v\/([^/]+)\/(.+)$/)
    if (req.method === 'GET' && relative && relative[2] !== 'manifest.mpd' && relative[2] !== 'asset') {
      const session = app.session(relative[1] ?? '')
      const target = session ? resolveCdnUrl(session, relative[2] ?? '', url.search) : undefined
      if (!session || !target) {
        send(res, 404, { error: 'unknown session asset' })
        return
      }
      const fetched = await app.play.fetchBinary(session, target)
      send(res, fetched.status, fetched.body, fetched.contentType)
      return
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    fail(res, error)
  }
}
