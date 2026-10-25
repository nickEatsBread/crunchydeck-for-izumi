import { CHROME_UA, HOSTS, PLAY_PLATFORM, TIZEN_UA } from './constants.js'
import { CrError, shortBody } from './errors.js'
import { cdnHeaders, crHeaders, isCdnUrl, mediaHeaders } from './headers.js'
import { jsonOrThrow, type CrTransport } from './http.js'
import { unwrapLicenseResponse } from './license.js'
import type { Auth } from './auth.js'
import { loadSession, saveSession } from '../storage.js'

export interface SubtitleTrack {
  url: string
  language: string
  format?: string
  isDefault?: boolean
}

export interface PlaySession {
  id: string
  contentId: string
  token: string
  manifestUrl: string
  videoContainer: string
  /** Original DASH BaseURL (CDN path, no query). Relative SegmentTemplate paths resolve against this. */
  cdnBase?: string
  /** CloudFront `?t=exp=…` from the MPD BaseURL. Reattached when proxying segments. */
  cdnQuery?: string
  drmName?: string
  drmUrl?: string
  audioLocale?: string
  headers: Record<string, string>
  cdnHeaders: Record<string, string>
  subtitles: SubtitleTrack[]
  captions: SubtitleTrack[]
  /** Burned-in DASH variants keyed by subtitle locale. Selecting one reloads the stream. */
  hardSubs: Array<{ language: string; url: string }>
  /** Other audio versions of this episode (each is a different content GUID). */
  versions: Array<{ language: string; guid: string }>
  /** Fire TV / Roku BIF (or a sprite URL) used for seek-bar hover previews. */
  previewUrl?: string
  /** Cached BIF bytes so hover/prefetches do not re-download the whole file. */
  previewCache?: { url: string; contentType: string; body: Buffer }
  /** Cached rewritten MPD so Shaka's extra manifest GETs do not hit Crunchyroll again. */
  rewritten?: { key: string; contentType: string; body: string }
  /** Set when Izumi stores this session (`manifest.mpd?offline=1`). */
  offlineDownload?: boolean
  /** Preferred stored video height from `?height=`. */
  offlineHeight?: number
  createdAt: number
}

export interface DeferredPlayMeta {
  audioLocale?: string
  versions?: Array<{ language: string; guid: string }>
}

function toCleanManifest(url: string): string {
  return url.replace(/\/0\/[a-z]{2}-[A-Z0-9]{2,3}\//, '/1/clean/')
}

interface PlayJson {
  url?: string
  token?: string
  assetId?: string
  videoContainer?: string
  audioLocale?: string
  hardSubs?: Record<string, { url?: string; hlang?: string }>
  subtitles?: Record<string, { url?: string; language?: string; format?: string }>
  captions?: Record<string, { url?: string; language?: string; format?: string }>
  versions?: Array<{ audio_locale?: string; audioLocale?: string; guid?: string; original?: boolean }>
  drm?: { name?: string; drmUrl?: string }
  bifs?: unknown
  thumbnails?: unknown
  preview?: unknown
}

function playUrl(profile: ReturnType<Auth['status']>['profile'], contentId: string): string[] {
  const platform = profile === 'tv' ? PLAY_PLATFORM.tv : PLAY_PLATFORM.web
  if (profile === 'tv') {
    return [
      `${HOSTS.play}/v1/${contentId}/${platform}/play`,
      `${HOSTS.play}/v3/${contentId}/${platform}/play`,
    ]
  }
  return [
    `${HOSTS.www}/playback/v3/${contentId}/${platform}/play`,
    `${HOSTS.play}/v3/${contentId}/${platform}/play`,
  ]
}

type TrackMap = Record<string, { url?: string; language?: string; format?: string; locale?: string }>

function tracks(
  map: TrackMap | Array<{ url?: string; language?: string; format?: string; locale?: string; lang?: string }> | undefined,
  preferred: string,
): SubtitleTrack[] {
  if (!map) return []
  const asMap: TrackMap = Array.isArray(map)
    ? Object.fromEntries(
      map
        .filter((item) => item?.url)
        .map((item) => {
          const language = item.language ?? item.locale ?? item.lang ?? 'und'
          return [language, { url: item.url, language, format: item.format }]
        }),
    )
    : map
  const out: SubtitleTrack[] = []
  for (const [key, value] of Object.entries(asMap)) {
    const language = value.language ?? value.locale ?? key
    if (!value?.url || key === 'none' || language === 'none') continue
    out.push({
      url: value.url,
      language,
      format: value.format,
      isDefault: language === preferred || language === 'en-US',
    })
  }
  if (out.some((t) => t.isDefault)) {
    let first = true
    for (const track of out) {
      if (track.isDefault) {
        if (!first) track.isDefault = false
        first = false
      }
    }
  }
  return out
}

export function versionsOf(
  json: PlayJson,
  fallbackId: string,
  fallbackLang?: string,
): Array<{ language: string; guid: string }> {
  const out: Array<{ language: string; guid: string }> = []
  const seen = new Set<string>()
  for (const item of json.versions ?? []) {
    const language = item.audio_locale ?? item.audioLocale
    if (!item.guid || !language || language === 'none' || seen.has(language)) continue
    seen.add(language)
    out.push({ language, guid: item.guid })
  }
  if (fallbackLang && !seen.has(fallbackLang)) {
    out.unshift({ language: fallbackLang, guid: fallbackId })
  } else if (!out.length && fallbackLang) {
    out.push({ language: fallbackLang, guid: fallbackId })
  }
  return out
}

export function firstPreviewUrl(source: unknown): string | undefined {
  if (!source) return undefined
  if (typeof source === 'string' && /^https?:/i.test(source)) return source
  if (Array.isArray(source)) {
    for (const item of source) {
      const hit = firstPreviewUrl(item)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof source === 'object') {
    const rec = source as Record<string, unknown>
    for (const key of ['en-US', 'en', 'url']) {
      if (rec[key] == null) continue
      const hit = firstPreviewUrl(rec[key])
      if (hit) return hit
    }
    if (typeof rec.url === 'string' && /^https?:/i.test(rec.url)) return rec.url
    for (const value of Object.values(rec)) {
      const hit = firstPreviewUrl(value)
      if (hit) return hit
    }
  }
  return undefined
}

export class PlayService {
  private sessions = new Map<string, PlaySession>()
  private binaryJobs = new Map<string, Promise<{
    contentType: string
    body: Buffer
    status: number
    headers: Record<string, string>
  }>>()
  private resolveJobs = new Map<string, Promise<PlaySession>>()
  private liveResolveQueue: Promise<void> = Promise.resolve()
  /** TV accounts allow one live play token. Last successful resolve owns it. */
  private liveSessionId: string | undefined
  private persistedLeaksJob: Promise<void> | undefined

  constructor(
    private transport: CrTransport,
    private auth: Auth,
  ) {}

  get(id: string): PlaySession | undefined {
    return this.sessions.get(id)
  }

  /** Create a zero-network local handle. The official play token is minted only
   * when Shaka requests this handle's manifest (i.e. after the user selected it). */
  defer(contentId: string, meta?: DeferredPlayMeta): PlaySession {
    void this.releasePersistedLeaks().catch(() => {})
    const session: PlaySession = {
      id: crypto.randomUUID(),
      contentId,
      token: '',
      manifestUrl: '',
      videoContainer: 'dash',
      audioLocale: meta?.audioLocale,
      headers: {},
      cdnHeaders: {},
      subtitles: [],
      captions: [],
      hardSubs: [],
      versions: meta?.versions?.length
        ? meta.versions
        : (meta?.audioLocale ? [{ language: meta.audioLocale, guid: contentId }] : []),
      createdAt: Date.now(),
    }
    this.sessions.set(session.id, session)
    this.pruneDeferredSessions()
    return session
  }

  async resolve(contentId: string, reuseId?: string): Promise<PlaySession> {
    const key = reuseId ? `reuse:${reuseId}` : `new:${contentId}`
    const pending = this.resolveJobs.get(key)
    if (pending) return pending
    // Different Izumi source requests can arrive together. Serialize the part
    // that owns Crunchyroll's single live grant so two successful /play calls
    // can never overlap remotely, even if the UI changes episode rapidly.
    const job = this.liveResolveQueue.then(() => this.resolveOnce(contentId, reuseId))
    this.liveResolveQueue = job.then(() => {}, () => {})
    this.resolveJobs.set(key, job)
    try {
      return await job
    } finally {
      this.resolveJobs.delete(key)
    }
  }

  private async resolveOnce(contentId: string, reuseId?: string): Promise<PlaySession> {
    const prev = reuseId ? this.sessions.get(reuseId) : undefined
    const previousToken = prev?.token
    const previousContentId = prev?.contentId
    // `defer()` starts restart cleanup without delaying picker rows. An
    // immediate selection must still join that exact cleanup before minting;
    // a boolean "started" flag allowed the two remote tokens to overlap.
    await this.releasePersistedLeaks()
    if (!reuseId) {
      await this.releaseOldest()
    }
    const live = this.liveSessionId ? this.sessions.get(this.liveSessionId) : undefined
    if (live && live.id !== reuseId && live.token) {
      const liveToken = live.token
      await this.deleteToken({ ...live, token: liveToken })
      live.token = ''
      live.manifestUrl = ''
      live.rewritten = undefined
      live.previewCache = undefined
      this.liveSessionId = undefined
      this.persistTokens()
    }
    // A Samsung-TV account can have a single live play grant. Audio changes and
    // token refreshes reuse the local session UUID, but Crunchyroll still sees a
    // new remote stream. Releasing the grant we own before asking for its
    // replacement avoids the predictable TOO_MANY_ACTIVE_STREAMS response and
    // the old 1.5s retry. Keep the local handle so an in-flight Shaka URL can be
    // reminted instead of turning into a localhost 404.
    if (previousToken && prev) {
      await this.deleteToken({
        ...prev,
        contentId: previousContentId ?? prev.contentId,
        token: previousToken,
      })
      prev.token = ''
      prev.manifestUrl = ''
      prev.rewritten = undefined
      prev.previewCache = undefined
      if (this.liveSessionId === prev.id) this.liveSessionId = undefined
      this.persistTokens()
    }
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const headers = crHeaders({
      profile,
      authorization: `Bearer ${token}`,
      extra: { Accept: '*/*' },
    })
    let lastError: unknown
    let json: PlayJson | undefined
    // TV device login cannot call the web chrome play endpoint (401 missing_token).
    // Hitting it first added a round-trip to every resolve and made the picker feel stalled.
    if (profile === 'web') {
      try {
        const webRes = await this.transport.request({
          url: `${HOSTS.www}/playback/v3/${contentId}/web/chrome/play`,
          headers: crHeaders({ profile: 'web' }),
        })
        if (webRes.status < 400) {
          const webJson = JSON.parse(webRes.text) as PlayJson
          if (webJson.url && webJson.token) {
            json = webJson
            console.log('[play] using web/chrome play')
          }
        } else {
          console.log(`[play] web/chrome HTTP ${webRes.status} ${webRes.text.slice(0, 120)}`)
        }
      } catch (error) {
        console.log(`[play] web/chrome ${error instanceof Error ? error.message : error}`)
      }
    }
    for (let attempt = 0; attempt < 3 && !json?.url; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
      for (const url of playUrl(profile, contentId)) {
        try {
          json = await jsonOrThrow<PlayJson>(await this.transport.request({ url, headers }))
          if (json.url && json.token) break
        } catch (error) {
          lastError = error
          const busy = error instanceof CrError && (error.body.includes('TOO_MANY_ACTIVE_STREAMS') || error.status === 420)
          if (busy) {
            await this.releasePersistedLeaks()
            // Drop other CR tokens but keep session UUIDs so Shaka's URL remints instead of 404ing.
            await Promise.all([...this.sessions.values()].map((item) => this.deleteToken(item).catch(() => {})))
          }
        }
      }
    }
    if (!json?.url || !json.token) {
      if (lastError instanceof CrError) throw lastError
      throw lastError instanceof Error ? lastError : new Error('Crunchyroll did not return a playable stream')
    }
    const id = reuseId ?? crypto.randomUUID()
    const next: PlaySession = {
      id,
      contentId,
      token: json.token,
      manifestUrl: toCleanManifest(json.url),
      videoContainer: json.videoContainer ?? 'dash',
      drmName: json.drm?.name,
      drmUrl: json.drm?.drmUrl,
      audioLocale: json.audioLocale,
      headers: mediaHeaders(profile, token),
      cdnHeaders: cdnHeaders(profile),
      subtitles: tracks(json.subtitles, 'en-US'),
      captions: tracks(json.captions, 'en-US'),
      hardSubs: Object.entries(json.hardSubs ?? {})
        .filter(([key, value]) => key !== 'none' && !!value?.url)
        .map(([language, value]) => ({ language, url: value!.url! })),
      versions: versionsOf(json, contentId, json.audioLocale),
      previewUrl: firstPreviewUrl(json.bifs) ?? firstPreviewUrl(json.thumbnails) ?? firstPreviewUrl(json.preview),
      createdAt: Date.now(),
    }
    // Keep the object stored for a local session UUID stable across Crunchyroll
    // token remints. Manifest rewriting attaches cdnBase/cdnQuery after resolve()
    // returns; replacing the map entry here made later /cdn requests see a
    // different object without that routing state and return "unknown cdn asset".
    const session = prev ? Object.assign(prev, next) : next
    this.sessions.set(id, session)
    this.liveSessionId = id
    this.persistTokens()
    // TV play already includes hardSubs + versions. Extra CMS/clean-MPD harvests 404 or
    // find no sidecar text and were the dominant cost of "resolving". Only harvest when
    // the play payload is missing those language maps.
    if (session.versions.length <= 1) {
      await this.harvestEpisodeMeta(session, headers)
    }
    const known = new Set(['url', 'token', 'assetId', 'videoContainer', 'audioLocale', 'hardSubs', 'subtitles', 'captions', 'versions', 'drm'])
    const extra = Object.keys(json).filter((key) => !known.has(key))
    if (extra.length) console.log(`[play] extra keys ${extra.join(',')}`)
    if (session.previewUrl) console.log(`[play] preview ${session.previewUrl}`)
    else if (json.bifs) console.log(`[play] bifs ${JSON.stringify(json.bifs).slice(0, 400)}`)
    console.log(
      `[play] id=${contentId} audio=${session.audioLocale ?? ''} versions=${session.versions.map((v) => v.language).join(',') || 'none'} hard=${session.hardSubs.map((t) => t.language).join(',') || 'none'} subs=${session.subtitles.length} caps=${session.captions.length}`,
    )
    return session
  }

  /** Switch this session onto another audio version GUID without minting a second stream slot. */
  async ensureAudio(session: PlaySession, language: string): Promise<PlaySession> {
    if (!language || session.audioLocale === language) return session
    const hit = session.versions.find((item) => item.language === language)
    if (!hit || hit.guid === session.contentId) return session
    console.log(`[play] switch audio ${session.audioLocale} → ${language} guid=${hit.guid}`)
    return this.resolve(hit.guid, session.id)
  }

  /** Episode objects carry `versions` (dubs) and `subtitle_locales` even when TV play omits them. */
  private async harvestEpisodeMeta(
    session: PlaySession,
    headers: Record<string, string>,
  ): Promise<void> {
    if (session.versions.length > 1) return
    try {
      const obj = await jsonOrThrow<{
        data?: Array<{
          versions?: PlayJson['versions']
          audio_locale?: string
        }>
        versions?: PlayJson['versions']
      }>(await this.transport.request({
        url: `${HOSTS.api}/content/v2/cms/objects/${session.contentId}`,
        headers,
      }))
      const rec = obj.data?.[0] ?? { versions: obj.versions }
      const harvested = versionsOf(
        { versions: rec.versions },
        session.contentId,
        rec.audio_locale ?? session.audioLocale,
      )
      if (harvested.length) session.versions = harvested
      console.log(`[play] cms objects versions=${session.versions.map((v) => v.language).join(',') || 'none'}`)
    } catch (error) {
      console.log(`[play] cms objects meta ${error instanceof Error ? error.message : error}`)
    }
  }

  /** crunchyroll-linux `service.video`: index/v2 CMS cookies + `/videos/{id}/streams`.
   *  TV samsung play often returns empty subtitle arrays; the CMS payload still has ASS/VTT. */
  private async harvestCmsText(
    session: PlaySession,
    headers: Record<string, string>,
  ): Promise<void> {
    try {
      const index = await jsonOrThrow<{
        cms?: { bucket?: string; policy?: string; signature?: string; key_pair_id?: string }
      }>(await this.transport.request({ url: `${HOSTS.api}/index/v2`, headers }))
      const cms = index.cms
      if (!cms?.bucket || !cms.policy || !cms.signature || !cms.key_pair_id) {
        console.log('[play] cms index missing bucket/policy')
        return
      }
      let streamId = session.contentId
      try {
        const obj = await jsonOrThrow<{
          data?: Array<{ streams_link?: string }>
          streams_link?: string
        }>(await this.transport.request({
          url: `${HOSTS.api}/content/v2/cms/objects/${session.contentId}`,
          headers,
        }))
        const link = obj.data?.[0]?.streams_link ?? obj.streams_link
        const match = typeof link === 'string' ? link.match(/\/videos\/([^/?]+)/) : null
        if (match?.[1]) streamId = match[1]
      } catch (error) {
        console.log(`[play] cms objects ${error instanceof Error ? error.message : error}`)
      }
      const query = `Signature=${encodeURIComponent(cms.signature)}&Policy=${encodeURIComponent(cms.policy)}&Key-Pair-Id=${encodeURIComponent(cms.key_pair_id)}`
      const ids = [...new Set([streamId, streamId.slice(0, 9), session.contentId])]
      let rec: { subtitles?: unknown; captions?: unknown } | undefined
      for (const id of ids) {
        const url = `${HOSTS.api}/cms/v2${cms.bucket}/videos/${id}/streams?${query}`
        const res = await this.transport.request({
          url,
          headers: { Accept: 'application/json, text/plain, */*' },
        })
        console.log(`[play] cms streams HTTP ${res.status} bucket=${cms.bucket} id=${id}`)
        if (res.status >= 400) continue
        const parsed = JSON.parse(res.text) as {
          data?: Array<{ subtitles?: unknown; captions?: unknown }>
          subtitles?: unknown
          captions?: unknown
        }
        rec = parsed.data?.[0] ?? parsed
        if (rec) break
      }
      if (!rec) return
      const subs = tracks(rec.subtitles as Parameters<typeof tracks>[0], 'en-US')
      const caps = tracks(rec.captions as Parameters<typeof tracks>[0], 'en-US')
      if (subs.length) session.subtitles = subs
      if (caps.length) session.captions = caps
      console.log(`[play] cms streams id=${streamId} subs=${session.subtitles.length} caps=${session.captions.length}`)
    } catch (error) {
      console.log(`[play] cms harvest ${error instanceof Error ? error.message : error}`)
    }
  }

  /** Web chrome play uses `/1/clean/` DASH plus sidecar ASS/VTT. TV samsung omits those
   *  maps; the same files are still on the clean manifest host. */
  private async harvestCleanManifest(
    session: PlaySession,
    json: PlayJson,
    headers: Record<string, string>,
  ): Promise<void> {
    if (!json.assetId || !json.token) return
    const clean = `${HOSTS.www}/playback/v2/manifest/${session.contentId}/static/${json.assetId}/1/clean/dash/manifest.mpd?playbackGuid=${encodeURIComponent(json.token)}`
    try {
      const res = await this.transport.request({ url: clean, headers })
      console.log(`[play] clean mpd HTTP ${res.status} asset=${json.assetId} len=${res.body.length} url=${session.manifestUrl.split('?')[0]}`)
      if (res.status >= 400) {
        console.log(`[play] clean mpd body ${res.text.slice(0, 160)}`)
        return
      }
      const xml = res.text
      const hrefs = [...xml.matchAll(/https?:[^"'<\s]+/gi)].map((m) => m[0].replace(/&amp;/g, '&'))
      const textFiles = hrefs.filter((u) => /\.(ass|ssa|vtt|srt)(\?|$)/i.test(u))
      const sets = [...xml.matchAll(/<AdaptationSet\b[^>]*>/g)].map((m) => m[0])
      const mimes = [...new Set([...xml.matchAll(/mimeType="([^"]+)"/gi)].map((m) => m[1] ?? ''))]
      console.log(`[play] clean mpd sets=${sets.length} mimes=${mimes.join(',') || 'none'} textFiles=${textFiles.length} ${sets.slice(0, 8).join(' | ')}`)
      const found: SubtitleTrack[] = []
      const caps: SubtitleTrack[] = []
      for (const href of textFiles) {
        const lang = href.match(/([a-z]{2}-[A-Z]{2})/g)?.at(-1) ?? 'und'
        const isCap = /closed-caption|caption/i.test(href)
        const track = { url: href, language: lang, format: href.includes('.ass') ? 'ass' : 'vtt' }
        if (isCap) caps.push(track)
        else found.push(track)
      }
      if (found.length) session.subtitles = found.map((t, i) => ({ ...t, isDefault: t.language === 'en-US' && i === found.findIndex((x) => x.language === 'en-US') }))
      if (caps.length) session.captions = caps
    } catch (error) {
      console.log(`[play] clean mpd ${error instanceof Error ? error.message : error}`)
    }
  }

  async ensureLiveToken(session: PlaySession): Promise<PlaySession> {
    if (this.liveSessionId === session.id && session.token && session.manifestUrl) return session
    console.warn(`[play] taking live token for ${session.contentId}`)
    const fresh = await this.resolve(session.contentId, session.id)
    Object.assign(session, fresh)
    session.rewritten = undefined
    session.previewCache = undefined
    return session
  }

  async fetchManifest(
    session: PlaySession,
    url = session.manifestUrl,
    refresh = true,
  ): Promise<{ contentType: string; body: string }> {
    const lang = session.hardSubs.find((track) => track.url === url)?.language
    if (refresh) await this.ensureLiveToken(session)
    const target = lang
      ? session.hardSubs.find((track) => track.language === lang)?.url ?? session.manifestUrl
      : session.manifestUrl
    const first = await this.fetchManifestOnce(session, target)
    if (first.status < 400) return this.manifestResult(first)
    if (!refresh || (first.status !== 401 && first.status !== 403)) {
      throw new CrError(first.status, first.text, `manifest HTTP ${first.status}`)
    }
    console.warn(`[play] manifest HTTP ${first.status}, re-minting ${session.contentId}`)
    const fresh = await this.resolve(session.contentId, session.id)
    Object.assign(session, fresh)
    session.rewritten = undefined
    session.previewCache = undefined
    const nextUrl = lang
      ? session.hardSubs.find((track) => track.language === lang)?.url ?? session.manifestUrl
      : session.manifestUrl
    const retry = await this.fetchManifestOnce(session, nextUrl)
    if (retry.status >= 400) throw new CrError(retry.status, retry.text, `manifest HTTP ${retry.status}`)
    return this.manifestResult(retry)
  }

  private async fetchManifestOnce(session: PlaySession, url: string) {
    const started = Date.now()
    const res = await this.transport.request({
      url,
      headers: isCdnUrl(url) ? session.cdnHeaders : session.headers,
      timeoutMs: 8_000,
    })
    console.log(`[play] manifest HTTP ${res.status} ${Date.now() - started}ms ${url.replace(/\?.*$/, '').slice(-72)}`)
    return res
  }

  private manifestResult(res: { headers: Record<string, string>; text: string }): { contentType: string; body: string } {
    return {
      contentType: res.headers['content-type'] ?? 'application/dash+xml',
      body: res.text,
    }
  }

  async fetchLicense(session: PlaySession, challenge: Buffer): Promise<Buffer> {
    await this.ensureLiveToken(session)
    const token = await this.auth.accessToken()
    const urls = [
      session.drmUrl,
      `${HOSTS.www}/license/v1/license/widevine`,
      HOSTS.license,
    ]
      .filter((value): value is string => !!value)
      .map((value) => value.replace(/[?&]specconform=true/gi, '').replace(/\?$/, ''))
      .filter((value, index, all) => all.indexOf(value) === index)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      Accept: 'application/json, application/octet-stream, */*',
      'X-Cr-Content-Id': session.contentId,
      'X-Cr-Video-Token': session.token,
      Origin: HOSTS.static,
      Referer: `${HOSTS.static}/`,
      'User-Agent': this.auth.profile === 'tv' ? TIZEN_UA : CHROME_UA,
    }
    console.log(`[license] challenge=${challenge.length}b first=${challenge.subarray(0, 8).toString('hex')} drmUrl=${session.drmUrl ?? 'none'}`)
    let lastError: CrError | undefined
    for (const url of urls) {
      const res = await this.transport.request({
        url,
        method: 'POST',
        headers,
        body: challenge,
      })
      const ctype = res.headers['content-type'] ?? ''
      console.log(`[license] ${res.status} ${url.replace('https://', '')} ctype=${ctype} raw=${res.body.length}b head=${res.body.subarray(0, 12).toString('hex')}`)
      if (res.status >= 400) {
        console.warn(`[license] ${shortBody(res.text)}`)
        lastError = new CrError(res.status, res.text, `license HTTP ${res.status}`)
        continue
      }
      const unwrapped = unwrapLicenseResponse(res.body, ctype)
      console.log(`[license] unwrapped=${unwrapped.length}b head=${unwrapped.subarray(0, 12).toString('hex')}`)
      return unwrapped
    }
    throw lastError ?? new Error('Crunchyroll did not return a Widevine license')
  }

  async fetchBinary(
    session: PlaySession,
    url: string,
    extra?: Record<string, string>,
  ): Promise<{ contentType: string; body: Buffer; status: number; headers: Record<string, string> }> {
    const ranged = !!extra && Object.keys(extra).some((key) => key.toLowerCase() === 'range')
    const isPreview = !ranged && (url === session.previewUrl || /\.bif(\?|$)/i.test(url))
    if (isPreview && session.previewCache?.url === url) {
      return {
        status: 200,
        contentType: session.previewCache.contentType,
        body: session.previewCache.body,
        headers: {
          'content-type': session.previewCache.contentType,
          'content-length': String(session.previewCache.body.length),
        },
      }
    }
    const jobKey = isPreview ? `${session.id}|${url}` : ''
    if (jobKey) {
      const pending = this.binaryJobs.get(jobKey)
      if (pending) return pending
    }
    const job = this.fetchBinaryOnce(session, url, extra, isPreview)
    if (jobKey) {
      this.binaryJobs.set(jobKey, job)
      void job.finally(() => this.binaryJobs.delete(jobKey))
    }
    return job
  }

  /** Stream a video/audio segment immediately instead of waiting for its complete Buffer. */
  async fetchStream(
    session: PlaySession,
    url: string,
    extra?: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const headers = { ...(isCdnUrl(url) ? session.cdnHeaders : session.headers), ...extra }
    if (!this.transport.stream) return this.fetchBinary(session, url, extra)
    const res = await this.transport.stream({ url, headers, signal })
    if (res.status >= 400) {
      console.warn(`[cdn] ${res.status} ${res.headers['content-type'] ?? ''} ${url.split('?')[0]?.slice(-80)}`)
    }
    return {
      status: res.status,
      contentType: res.headers['content-type'] ?? 'application/octet-stream',
      body: res.body,
      headers: res.headers,
    }
  }

  private async fetchBinaryOnce(
    session: PlaySession,
    url: string,
    extra: Record<string, string> | undefined,
    isPreview: boolean,
  ): Promise<{ contentType: string; body: Buffer; status: number; headers: Record<string, string> }> {
    const headers = {
      ...(isCdnUrl(url) ? session.cdnHeaders : session.headers),
      ...extra,
    }
    const res = await this.transport.request({ url, headers, timeoutMs: isPreview ? 20_000 : undefined })
    const contentType = res.headers['content-type'] ?? 'application/octet-stream'
    if (res.status >= 400) {
      console.warn(`[cdn] ${res.status} ${contentType} ${url.split('?')[0]?.slice(-80)}`)
    } else if (isPreview) {
      session.previewCache = { url, contentType, body: res.body }
      console.log(`[play] preview bytes=${res.body.length} magic=${res.body.subarray(0, 4).toString('hex')}`)
    }
    return {
      status: res.status,
      contentType,
      body: res.body,
      headers: res.headers,
    }
  }

  async release(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    // Keep a failed deletion in memory and persisted storage. Forgetting it
    // locally would make restart cleanup impossible and could leak a remote
    // stream slot until Crunchyroll expires it.
    await this.deleteToken(session)
    this.sessions.delete(id)
    if (this.liveSessionId === id) this.liveSessionId = undefined
    this.persistTokens()
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.release(id)))
  }

  private async releaseOldest(): Promise<void> {
    // Izumi resolves dub + sub in parallel. Max-1 deleted the chosen GUID before Shaka
    // could GET /manifest, which looks like a hang (error 1003) in the webview.
    const max = 8
    if (this.sessions.size < max) return
    const sorted = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt)
    while (sorted.length >= max) {
      const oldest = sorted.shift()
      if (oldest) await this.release(oldest.id)
    }
  }

  private persistTokens(): void {
    const stored = loadSession()
    if (!stored) return
    stored.activePlays = [...this.sessions.values()].filter((session) => !!session.token).map((session) => ({
      contentId: session.contentId,
      token: session.token,
    }))
    saveSession(stored)
  }

  private releasePersistedLeaks(): Promise<void> {
    if (this.persistedLeaksJob) return this.persistedLeaksJob
    const job = this.releasePersistedLeaksOnce()
    this.persistedLeaksJob = job
    void job.catch(() => {
      if (this.persistedLeaksJob === job) this.persistedLeaksJob = undefined
    })
    return job
  }

  private async releasePersistedLeaksOnce(): Promise<void> {
    const stored = loadSession()
    const leftover = stored?.activePlays ?? []
    if (!leftover.length) return
    const failed: typeof leftover = []
    for (const item of leftover) {
      try {
        await this.deleteToken({
          id: '',
          contentId: item.contentId,
          token: item.token,
          manifestUrl: '',
          videoContainer: 'dash',
          headers: {},
          cdnHeaders: {},
          subtitles: [],
          captions: [],
          hardSubs: [],
          versions: [],
          createdAt: 0,
        })
      } catch {
        failed.push(item)
      }
    }
    if (stored) {
      stored.activePlays = failed
      saveSession(stored)
    }
    if (failed.length) throw new Error(`Could not release ${failed.length} previous Crunchyroll stream session${failed.length === 1 ? '' : 's'}`)
  }

  private async deleteToken(session: PlaySession): Promise<void> {
    if (!session.token) return
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const urls = profile === 'web'
      ? [
          `${HOSTS.www}/playback/v1/token/${session.contentId}/${session.token}`,
          `${HOSTS.play}/v1/token/${session.contentId}/${session.token}`,
        ]
      : [`${HOSTS.play}/v1/token/${session.contentId}/${session.token}`]
    const headers = crHeaders({ profile, authorization: `Bearer ${token}` })
    let lastError: unknown
    for (const url of urls) {
      try {
        const res = await this.transport.request({ url, method: 'DELETE', headers })
        // A missing/expired token is already released. Authentication, rate
        // limit, and server failures are not proof that the remote grant died.
        if (res.status < 400 || (res.status < 500 && ![401, 403, 420, 429].includes(res.status))) return
        lastError = new CrError(res.status, res.text, `Crunchyroll stream release failed (${res.status})`)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Crunchyroll stream release failed')
  }


  private pruneDeferredSessions(): void {
    const deferred = [...this.sessions.values()]
      .filter((session) => !session.token)
      .sort((a, b) => a.createdAt - b.createdAt)
    while (deferred.length > 16) {
      const stale = deferred.shift()
      if (stale) this.sessions.delete(stale.id)
    }
  }
}
