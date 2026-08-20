import { HOSTS, PLAY_PLATFORM } from './constants.js'
import { CrError } from './errors.js'
import { cdnHeaders, crHeaders, isCdnUrl, mediaHeaders } from './headers.js'
import { jsonOrThrow, type CrTransport } from './http.js'
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
  /** Original DASH BaseURL (CDN). Relative SegmentTemplate paths resolve against this. */
  cdnBase?: string
  drmName?: string
  drmUrl?: string
  audioLocale?: string
  headers: Record<string, string>
  cdnHeaders: Record<string, string>
  subtitles: SubtitleTrack[]
  captions: SubtitleTrack[]
  createdAt: number
}

interface PlayJson {
  url?: string
  token?: string
  videoContainer?: string
  audioLocale?: string
  hardSubs?: Record<string, { url?: string; hlang?: string }>
  subtitles?: Record<string, { url?: string; language?: string; format?: string }>
  captions?: Record<string, { url?: string; language?: string; format?: string }>
  drm?: { name?: string; drmUrl?: string }
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

function tracks(
  map: Record<string, { url?: string; language?: string; format?: string }> | undefined,
  preferred: string,
): SubtitleTrack[] {
  if (!map) return []
  const out: SubtitleTrack[] = []
  for (const [key, value] of Object.entries(map)) {
    if (!value?.url || key === 'none') continue
    const language = value.language ?? key
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

export class PlayService {
  private sessions = new Map<string, PlaySession>()

  constructor(
    private transport: CrTransport,
    private auth: Auth,
  ) {}

  get(id: string): PlaySession | undefined {
    return this.sessions.get(id)
  }

  async resolve(contentId: string): Promise<PlaySession> {
    await this.releasePersistedLeaks()
    await this.releaseOldest()
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const headers = crHeaders({
      profile,
      authorization: `Bearer ${token}`,
      extra: { Accept: '*/*' },
    })
    let lastError: unknown
    let json: PlayJson | undefined
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
            await this.closeAll()
          }
        }
      }
    }
    if (!json?.url || !json.token) {
      if (lastError instanceof CrError) throw lastError
      throw lastError instanceof Error ? lastError : new Error('Crunchyroll did not return a playable stream')
    }
    const id = crypto.randomUUID()
    const session: PlaySession = {
      id,
      contentId,
      token: json.token,
      manifestUrl: json.url,
      videoContainer: json.videoContainer ?? 'dash',
      drmName: json.drm?.name,
      drmUrl: json.drm?.drmUrl,
      audioLocale: json.audioLocale,
      headers: mediaHeaders(profile, token),
      cdnHeaders: cdnHeaders(profile),
      subtitles: tracks(json.subtitles, 'en-US'),
      captions: tracks(json.captions, 'en-US'),
      createdAt: Date.now(),
    }
    this.sessions.set(id, session)
    this.persistTokens()
    return session
  }

  async fetchManifest(session: PlaySession): Promise<{ contentType: string; body: string }> {
    const res = await this.transport.request({
      url: session.manifestUrl,
      headers: isCdnUrl(session.manifestUrl) ? session.cdnHeaders : session.headers,
    })
    if (res.status >= 400) throw new CrError(res.status, res.text, `manifest HTTP ${res.status}`)
    return {
      contentType: res.headers['content-type'] ?? 'application/dash+xml',
      body: res.text,
    }
  }

  async fetchBinary(
    session: PlaySession,
    url: string,
    extra?: Record<string, string>,
  ): Promise<{ contentType: string; body: Buffer; status: number; headers: Record<string, string> }> {
    const headers = {
      ...(isCdnUrl(url) ? session.cdnHeaders : session.headers),
      ...extra,
    }
    const res = await this.transport.request({ url, headers })
    const contentType = res.headers['content-type'] ?? 'application/octet-stream'
    if (res.status >= 400) {
      console.warn(`[cdn] ${res.status} ${contentType} ${url.split('?')[0]?.slice(-80)}`)
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
    this.sessions.delete(id)
    this.persistTokens()
    await this.deleteToken(session).catch(() => {})
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.release(id)))
  }

  private async releaseOldest(): Promise<void> {
    const max = 1
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
    stored.activePlays = [...this.sessions.values()].map((session) => ({
      contentId: session.contentId,
      token: session.token,
    }))
    saveSession(stored)
  }

  private async releasePersistedLeaks(): Promise<void> {
    const stored = loadSession()
    const leftover = stored?.activePlays ?? []
    if (!leftover.length) return
    if (stored) {
      stored.activePlays = []
      saveSession(stored)
    }
    for (const item of leftover) {
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
        createdAt: 0,
      }).catch(() => {})
    }
  }

  private async deleteToken(session: PlaySession): Promise<void> {
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const urls = profile === 'web'
      ? [
          `${HOSTS.www}/playback/v1/token/${session.contentId}/${session.token}`,
          `${HOSTS.play}/v1/token/${session.contentId}/${session.token}`,
        ]
      : [`${HOSTS.play}/v1/token/${session.contentId}/${session.token}`]
    const headers = crHeaders({ profile, authorization: `Bearer ${token}` })
    for (const url of urls) {
      const res = await this.transport.request({ url, method: 'DELETE', headers })
      if (res.status < 400 || res.status === 404) return
    }
  }
}
