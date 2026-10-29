import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CrunchyrollApp } from './app.js'
import { CrError } from './cr/errors.js'
import { loadRewrittenManifest, resolveCdnUrl } from './cr/proxy.js'
import { mediaCacheKey, mediaGateway, nextSegmentUrl, type FetchedMedia } from './cr/media-fetch.js'
import { DEFAULT_PORT } from './cr/constants.js'
import { loadOrCreateShareToken } from './storage.js'
import { CRUNCHYROLL_ICON } from './brand.js'
import { saveServiceSettings, serviceSettings } from './settings.js'
import { localAccess } from './access.js'
import { StremioCatalog } from './stremio.js'

const here = dirname(fileURLToPath(import.meta.url))
let embeddedUiHtml: string | undefined
let embeddedProviderSrc: string | undefined
const uiHtml = () => embeddedUiHtml ?? readFileSync(join(here, 'ui', 'index.html'), 'utf8')
const providerSrc = () => embeddedProviderSrc ?? readFileSync(join(here, 'izumi', 'provider.js'), 'utf8')

export function setEmbeddedAssets(ui: string, provider: string): void {
  embeddedUiHtml = ui
  embeddedProviderSrc = provider
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendMedia(res: ServerResponse, fetched: { status: number; contentType: string; body: Buffer; headers: Record<string, string> }): void {
  const magic = fetched.body.subarray(4, 8).toString('ascii')
  const isMp4 = magic === 'ftyp' || magic === 'moof' || magic === 'styp' || magic === 'mdat'
  const type = isMp4 ? (fetched.contentType.includes('mp4') ? fetched.contentType : 'video/mp4') : fetched.contentType
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': String(fetched.body.length),
  }
  if (fetched.headers['content-range']) headers['content-range'] = fetched.headers['content-range']
  if (fetched.headers['accept-ranges']) headers['accept-ranges'] = fetched.headers['accept-ranges']
  res.writeHead(fetched.status, headers)
  res.end(fetched.body)
}

/** How long the upstream may go silent mid-body before the proxy gives up on it. */
export const MEDIA_IDLE_MS = 20_000

/** Resolves on 'drain', or once the client has gone (then 'drain' never comes). */
function drainedOrGone(res: ServerResponse, gone: () => boolean): Promise<void> {
  if (gone()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** The next chunk, or a rejection when the upstream has been silent for `idleMs`. */
function readWithin<T>(read: Promise<T>, idleMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`upstream sent nothing for ${idleMs / 1000} s`)), idleMs)
  })
  return Promise.race([read, idle]).finally(() => clearTimeout(timer))
}

export async function sendMediaStream(
  res: ServerResponse,
  fetched: {
    status: number
    contentType: string
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>
        cancel?(reason?: unknown): Promise<void>
        releaseLock(): void
      }
    } | Buffer | null
    headers: Record<string, string>
  },
  idleMs = MEDIA_IDLE_MS,
): Promise<void> {
  // A transport without streaming support falls back to the existing buffered response.
  if (Buffer.isBuffer(fetched.body)) {
    sendMedia(res, { ...fetched, body: fetched.body })
    return
  }
  const headers: Record<string, string> = {
    'content-type': fetched.contentType,
    // Segment URLs include the representation and sequence number. Let the
    // WebView reuse init/recent media across rapid seeks instead of returning
    // to CloudFront for the same immutable bytes.
    'cache-control': fetched.status < 400 ? 'private, max-age=600' : 'no-store',
  }
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    if (fetched.headers[name]) headers[name] = fetched.headers[name]
  }
  // The client may leave at any point. A response it abandoned is not necessarily `destroyed`, and
  // its 'close' fires once, so remember it rather than waiting for an event that already happened.
  let closed = false
  res.once('close', () => { closed = true })
  const gone = () => closed || res.destroyed
  res.writeHead(fetched.status, headers)
  if (!fetched.body) {
    res.end()
    return
  }
  const reader = fetched.body.getReader()
  let finished = false
  try {
    while (!gone()) {
      const { done, value } = await readWithin(reader.read(), idleMs)
      if (done) {
        finished = true
        break
      }
      if (value && !res.write(value)) await drainedOrGone(res, gone)
    }
    if (!gone()) res.end()
  } catch (error) {
    if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)))
  } finally {
    // A body left half-read holds its upstream HTTP/2 stream and flow-control window; enough of
    // those and every later media request on the connection stalls. Cancel what wasn't read.
    if (!finished) await reader.cancel?.().catch(() => {})
    reader.releaseLock()
  }
}

async function proxyMediaStream(
  app: CrunchyrollApp,
  req: IncomingMessage,
  res: ServerResponse,
  session: NonNullable<ReturnType<CrunchyrollApp['session']>>,
  target: string,
): Promise<void> {
  const abort = new AbortController()
  const cancel = () => abort.abort()
  req.once('aborted', cancel)
  res.once('close', cancel)
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined
  const range = rangeHeader ? { Range: rangeHeader } : undefined
  // Playback keeps the streaming path. Offline storage already waits for each
  // whole fragment, so coalescing/caching there cannot add startup latency.
  const fetched = session.offlineDownload
    ? await loadOfflineMedia(app, session, target, range, abort.signal)
    : await app.play.fetchStream(session, target, range, abort.signal)
  await sendMediaStream(res, fetched)
  if (session.offlineDownload && !rangeHeader && fetched.status < 400) {
    const next = nextSegmentUrl(target)
    if (next) void loadOfflineMedia(app, session, next).catch(() => {})
  }
}

async function loadOfflineMedia(
  app: CrunchyrollApp,
  session: NonNullable<ReturnType<CrunchyrollApp['session']>>,
  target: string,
  range?: { Range: string },
  signal?: AbortSignal,
): Promise<FetchedMedia> {
  const rangeHeader = range?.Range
  const key = mediaCacheKey(`${session.id}:${target}`, rangeHeader)
  return mediaGateway.fetch(
    key,
    () => app.play.fetchStream(session, target, range, signal),
    { cache: !rangeHeader },
  )
}

const stremioCatalogs = new WeakMap<CrunchyrollApp, StremioCatalog>()

/** /stremio/…: the Stremio addon protocol over Crunchyroll's catalogue, plus progress and watchlist
 *  writes. Only on the local scope: share links never reach the account. */
async function handleStremio(app: CrunchyrollApp, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  let catalog = stremioCatalogs.get(app)
  if (!catalog) {
    catalog = new StremioCatalog(app)
    stremioCatalogs.set(app, catalog)
  }
  const path = url.pathname.slice('/stremio/'.length)
  if (req.method === 'GET' && path === 'manifest.json') {
    send(res, 200, await catalog.manifest())
    return
  }
  const listing = path.match(/^catalog\/(series|movie)\/([^/]+?)(?:\/([^/]+))?\.json$/)
  if (req.method === 'GET' && listing) {
    // parseExtra decodes each value: decoding the whole segment first split a value holding "&".
    send(res, 200, { metas: await catalog.catalog(decodeURIComponent(listing[2] ?? ''), listing[3]) })
    return
  }
  const meta = path.match(/^meta\/(series|movie)\/([^/]+)\.json$/)
  if (req.method === 'GET' && meta) {
    // Signed out, a title cannot be read: saying so (401) lets izumi ask for the sign-in rather than
    // report the title as missing.
    if (!app.auth.status().authenticated) {
      send(res, 401, { error: 'Sign in to Crunchyroll to see this title.' })
      return
    }
    const found = await catalog.meta(decodeURIComponent(meta[2] ?? ''), app.baseUrl)
    send(res, found ? 200 : 404, found ? { meta: found } : { meta: null })
    return
  }
  const stream = path.match(/^stream\/(series|movie)\/([^/]+)\.json$/)
  if (req.method === 'GET' && stream) {
    send(res, 200, { streams: await catalog.stream(decodeURIComponent(stream[2] ?? ''), app.baseUrl) })
    return
  }
  if (req.method === 'POST' && path === 'progress') {
    const body = await jsonBody(req)
    const position = Number(body.position)
    if (!Number.isFinite(position) || position < 0) throw new Error('position must be a number of seconds')
    await catalog.progress(String(url.searchParams.get('video') ?? body.videoId ?? ''), position)
    send(res, 200, { ok: true })
    return
  }
  const watchlist = path.match(/^watchlist\/([^/]+)$/)
  if (watchlist && (req.method === 'POST' || req.method === 'DELETE')) {
    const on = await catalog.setWatchlist(decodeURIComponent(watchlist[1] ?? ''), req.method === 'POST')
    send(res, 200, { ok: true, watchlist: on })
    return
  }
  send(res, 404, { error: 'not found' })
}

function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return readBinaryBody(req).then((buf) => buf.toString('utf8'))
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

function lanAddress(): string | undefined {
  const candidates: Array<{ address: string; score: number }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue
      const label = name.toLowerCase()
      let score = 0
      if (/wi-?fi|wlan|wireless|ethernet|^en\d+$|^eth\d+$/.test(label)) score += 20
      if (/virtual|vethernet|vmware|hyper-v|wsl|docker|loopback|zerotier|tailscale/.test(label)) score -= 50
      candidates.push({ address: entry.address, score })
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.address
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function listen(
  app: CrunchyrollApp,
  port = DEFAULT_PORT,
  onManagedShutdown?: () => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const shareToken = loadOrCreateShareToken()
  const partyToken = randomBytes(24).toString('base64url')
  const server = createServer((req, res) => {
    void handle(app, req, res, shareToken, partyToken, onManagedShutdown)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, process.env.CR_SOURCE_HOST || '0.0.0.0', () => {
      const address = server.address()
      const actual = typeof address === 'object' && address ? address.port : port
      app.baseUrl = `http://127.0.0.1:${actual}`
      const advertised = process.env.CR_PUBLIC_HOST || lanAddress()
      app.shareBaseUrl = advertised ? `http://${advertised}:${actual}/share/${shareToken}` : ''
      app.partyBaseUrl = advertised ? `http://${advertised}:${actual}/share/${partyToken}` : ''
      resolve({
        port: actual,
        close: () => new Promise((done, failClose) => server.close((err) => err ? failClose(err) : done())),
      })
    })
  })
}

async function handle(
  app: CrunchyrollApp,
  req: IncomingMessage,
  res: ServerResponse,
  shareToken: string,
  partyToken: string,
  onManagedShutdown?: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', app.baseUrl)
  const shared = url.pathname.match(/^\/share\/([^/]+)(\/.*)$/)
  const scope = shared?.[1] === shareToken ? 'android' : shared?.[1] === partyToken ? 'party' : 'local'
  if (scope !== 'local') url.pathname = shared?.[2] ?? '/'
  else if (!isLoopback(req)) {
    send(res, 403, { error: 'A valid Watch Together playback capability is required.' })
    return
  }
  // A share capability is the token in its path, so any origin may use it. A local request must come
  // from izumi on a loopback host (see access.ts).
  let corsOrigin = '*'
  if (scope === 'local') {
    const access = localAccess(req.headers, url.pathname)
    if (!access.ok) {
      send(res, 403, { error: access.reason })
      return
    }
    corsOrigin = access.corsOrigin ?? ''
  }
  if (corsOrigin) {
    res.setHeader('access-control-allow-origin', corsOrigin)
    res.setHeader('access-control-allow-headers', 'content-type, authorization, origin, range')
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
    res.setHeader('access-control-allow-private-network', 'true')
    if (corsOrigin !== '*') res.setHeader('vary', 'origin')
  }
  const remoteBase = scope === 'party' ? app.partyBaseUrl : scope === 'android' ? app.shareBaseUrl : app.baseUrl
  if (scope === 'party' && !(
    url.pathname.startsWith('/v/')
    && (req.method === 'GET' || req.method === 'OPTIONS' || (req.method === 'POST' && url.pathname.endsWith('/license')))
  )) {
    send(res, 403, { error: 'A Watch Together capability can only read its shared playback session.' })
    return
  }
  if (scope === 'android' && !(
    url.pathname === '/index.json'
    || url.pathname === '/provider.js'
    || url.pathname === '/api/status'
    || url.pathname === '/api/search'
    || url.pathname === '/api/episodes'
    || url.pathname === '/api/play'
    || url.pathname.startsWith('/v/')
  )) {
    send(res, 403, { error: 'This playback capability cannot manage the Crunchyroll account.' })
    return
  }
  const noisyMedia = /\/v\/[^/]+\/(cdn\/|asset$)/.test(url.pathname)
  if (url.pathname !== '/favicon.ico' && !noisyMedia) {
    const query = url.search.length && url.search.length < 64 ? url.search : ''
    console.log(`[http] ${req.method} ${url.pathname}${query}`)
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
        version: '0.1.2',
        type: 'onlinestream-provider',
        lang: 'en',
        description: 'Crunchyroll account source. Requires your Crunchyroll login.',
        icon: CRUNCHYROLL_ICON,
        main: 'provider.js',
        // Crunchyroll's own catalogue, as a Stremio addon (see stremio.ts).
        catalog: '/stremio/manifest.json',
      })
      return
    }
    if (url.pathname.startsWith('/stremio/') && scope === 'local') {
      await handleStremio(app, req, res, url)
      return
    }
    if (req.method === 'GET' && url.pathname === '/provider.js') {
      send(res, 200, providerSrc().replaceAll('__BASE__', remoteBase), 'application/javascript; charset=utf-8')
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(res, 200, {
        ...app.status(),
        manifestUrl: `${remoteBase}/index.json`,
        androidManifestUrl: app.shareBaseUrl ? `${app.shareBaseUrl}/index.json` : undefined,
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/__izumi/shutdown' && onManagedShutdown) {
      send(res, 200, { ok: true })
      setImmediate(onManagedShutdown)
      return
    }
    if (req.method === 'GET' && url.pathname === '/__izumi/settings') {
      const [profiles, details] = await Promise.all([
        app.accountProfiles().catch(() => undefined),
        app.accountDetails().catch(() => undefined),
      ])
      send(res, 200, serviceSettings(app, profiles, details))
      return
    }
    if (req.method === 'POST' && url.pathname === '/__izumi/settings') {
      const body = await jsonBody(req)
      const values = body.values
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Crunchyroll settings values must be an object.')
      }
      send(res, 200, await saveServiceSettings(app, values as Record<string, unknown>, () => app.accountProfiles(), () => app.accountDetails()))
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
      send(res, 200, await app.episodeServer(id, 'en-US', remoteBase))
      return
    }
    const license = url.pathname.match(/^\/v\/([^/]+)\/license$/)
    if (req.method === 'POST' && license) {
      const session = app.session(license[1] ?? '')
      if (!session) {
        send(res, 404, { error: 'unknown play session' })
        return
      }
      const challenge = await readBinaryBody(req)
      const body = await app.play.fetchLicense(session, challenge)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': String(body.length),
      })
      res.end(body)
      return
    }
    const playSession = url.pathname.match(/^\/v\/([^/]+)\/session$/)
    if (req.method === 'DELETE' && playSession) {
      await app.play.release(playSession[1] ?? '')
      send(res, 200, { ok: true })
      return
    }
    const source = url.pathname.match(/^\/v\/([^/]+)\/source$/)
    if (req.method === 'GET' && source) {
      const id = source[1] ?? ''
      const session = app.session(id)
      if (session) await app.play.ensureLiveToken(session)
      // The player asks for the manifest next: it is read now, while this answers, and that request
      // joins the read (or finds it done).
      if (session) void loadRewrittenManifest(app.play, session, remoteBase).catch(() => {})
      const mapped = app.sessionSource(
        id,
        'en-US',
        remoteBase,
      )
      if (!mapped) {
        send(res, 404, { error: 'unknown play session' })
        return
      }
      send(res, 200, mapped)
      return
    }
    const manifest = url.pathname.match(/^\/v\/([^/]+)\/manifest\.(mpd|m3u8)$/)
    if (req.method === 'GET' && manifest) {
      let session = app.session(manifest[1] ?? '')
      if (!session) {
        send(res, 404, { error: 'unknown play session' })
        return
      }
      const audio = url.searchParams.get('audio')
      if (audio) session = await app.play.ensureAudio(session, audio)
      const hard = url.searchParams.get('hard')
      const alt = hard ? session.hardSubs.find((track) => track.language === hard)?.url : undefined
      const offline = url.searchParams.get('offline') === '1'
      const heightRaw = Number(url.searchParams.get('height'))
      const maxHeight = Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : undefined
      session.offlineDownload = offline
      session.offlineHeight = maxHeight
      const rewritten = await loadRewrittenManifest(app.play, session, remoteBase, alt, true, {
        offline: offline ? { maxHeight } : undefined,
      })
      if (offline) {
        const heights = [...rewritten.body.matchAll(/\bheight="(\d+)"/g)].map((match) => match[1])
        console.log(`[http] offline manifest heights=${heights.join(',') || 'none'} max=${maxHeight ?? 'auto'}`)
      }
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
      await proxyMediaStream(app, req, res, session, target)
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
      await proxyMediaStream(app, req, res, session, target)
      return
    }
    const relative = url.pathname.match(/^\/v\/([^/]+)\/(.+)$/)
    if (req.method === 'GET' && relative && relative[2] !== 'manifest.mpd' && relative[2] !== 'asset' && relative[2] !== 'license' && relative[2] !== 'source') {
      const session = app.session(relative[1] ?? '')
      const target = session ? resolveCdnUrl(session, relative[2] ?? '', url.search) : undefined
      if (!session || !target) {
        send(res, 404, { error: 'unknown session asset' })
        return
      }
      await proxyMediaStream(app, req, res, session, target)
      return
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    fail(res, error)
  }
}
