import { Auth, type AccountStatus, type CrProfile, type DeviceCode, type DeviceFlowState } from './cr/auth.js'
import { Catalog, type EpisodeHit, type SearchHit } from './cr/catalog.js'
import { Content } from './cr/content.js'
import { tryChromeTransport } from './cr/chrome.js'
import { FetchTransport, type CrTransport } from './cr/http.js'
import { PlayService, type PlaySession } from './cr/play.js'
import { initialPlaybackUrl } from './cr/proxy.js'
import { loadSession } from './storage.js'
import type { ClientProfile } from './cr/constants.js'

export interface VideoSource {
  url: string
  type: 'mp4' | 'm3u8' | 'dash'
  quality: string
  server?: string
  audio?: 'sub' | 'dub'
  audioLang?: string
  subtitleMode?: 'soft' | 'hard'
  subtitles: Array<{
    url: string
    language: string
    isDefault?: boolean
    kind?: 'subtitles' | 'captions'
    switchUrl?: string
  }>
  audioTracks?: Array<{
    url?: string
    language: string
    switchUrl?: string
  }>
  previewUrl?: string
  drm?: {
    keySystem: string
    licenseUrl: string
    releaseUrl?: string
    videoRobustness?: string
    audioRobustness?: string
  }
  /** LAN-safe, capability-tokened equivalent used by Izumi Watch Together guests. */
  share?: VideoSource
}

export interface EpisodeServer {
  server: string
  headers: Record<string, string>
  videoSources: VideoSource[]
}

export class CrunchyrollApp {
  readonly transport: CrTransport
  readonly auth: Auth
  readonly catalog: Catalog
  readonly content: Content
  readonly play: PlayService
  baseUrl = 'http://127.0.0.1:17871'
  shareBaseUrl = ''
  partyBaseUrl = ''

  private constructor(transport: CrTransport) {
    this.transport = transport
    this.auth = new Auth(transport, loadSession())
    this.catalog = new Catalog(transport, this.auth)
    this.content = new Content(transport, this.auth)
    this.play = new PlayService(transport, this.auth)
  }

  static async create(): Promise<CrunchyrollApp> {
    const prefer = (process.env.CR_HTTP ?? 'chrome').toLowerCase()
    let transport: CrTransport | null = null
    if (prefer !== 'fetch') transport = await tryChromeTransport()
    if (!transport) transport = new FetchTransport()
    const app = new CrunchyrollApp(transport)
    if ('setProfile' in transport && typeof (transport as { setProfile?: (p: ClientProfile) => Promise<void> }).setProfile === 'function') {
      await (transport as { setProfile: (p: ClientProfile) => Promise<void> }).setProfile(app.auth.profile)
    }
    console.log(`[cr] http transport: ${transport.name}`)
    return app
  }

  status(): AccountStatus & { benefits: string[] } {
    return { ...this.auth.status(), benefits: this.auth.benefits() }
  }

  async loginEtpRt(value: string) {
    const status = await this.auth.loginEtpRt(value)
    await this.syncChromeProfile()
    return status
  }

  async loginPassword(username: string, password: string) {
    const status = await this.auth.loginPassword(username, password)
    await this.syncChromeProfile()
    return status
  }

  requestDeviceCode(): Promise<DeviceCode> {
    return this.auth.requestDeviceCode()
  }

  deviceStatus(): DeviceFlowState {
    return this.auth.deviceStatus()
  }

  async pollDeviceCode(deviceCode?: string) {
    const result = await this.auth.pollDeviceCode(deviceCode)
    if (!result.pending) await this.syncChromeProfile()
    return result
  }

  logout(): void {
    this.auth.logout()
    this.profileCache = undefined
  }

  private profileCache: { at: number; profiles: CrProfile[] } | undefined

  /** The account's profiles, cached for half a minute; undefined when signed out. */
  async accountProfiles(): Promise<CrProfile[] | undefined> {
    if (!this.auth.status().authenticated) return undefined
    if (this.profileCache && Date.now() - this.profileCache.at < 30_000) return this.profileCache.profiles
    const profiles = await this.auth.profiles()
    this.profileCache = { at: Date.now(), profiles }
    // One profile: nothing to choose.
    if (profiles.length <= 1) this.auth.markProfileChosen()
    return profiles
  }

  profileChosen(): boolean {
    return this.auth.profileChosen
  }

  async switchProfile(profileId: string): Promise<AccountStatus> {
    const status = await this.auth.switchProfile(profileId)
    this.profileCache = undefined
    // The last profile's rows, progress and audio preference must not answer for the new one.
    this.content.invalidate()
    return status
  }

  search(query: string, dub: boolean, year?: number): Promise<SearchHit[]> {
    return this.catalog.search(query, dub, year)
  }

  episodes(id: string): Promise<EpisodeHit[]> {
    return this.catalog.episodes(id)
  }

  async episodeServer(
    episodeId: string,
    preferredSub = 'en-US',
    baseUrl = this.baseUrl,
  ): Promise<EpisodeServer> {
    const session = this.play.defer(episodeId, this.catalog.episodePlaybackMeta(episodeId))
    const source = this.videoSourceFrom(session, preferredSub, baseUrl)
    if (baseUrl === this.baseUrl && this.partyBaseUrl) {
      // A Watch Together guest shares the host's local play session. Only the host owns its
      // lifecycle: a guest leaving must not DELETE the session out from under everyone else.
      source.share = this.videoSourceFrom(session, preferredSub, this.partyBaseUrl, false)
    }
    return {
      server: 'Crunchyroll',
      headers: {
        Referer: 'https://www.crunchyroll.com/',
        Origin: 'https://www.crunchyroll.com',
      },
      videoSources: [source],
    }
  }

  sessionSource(id: string, preferredSub = 'en-US', baseUrl = this.baseUrl): VideoSource | undefined {
    const session = this.play.get(id)
    return session ? this.videoSourceFrom(session, preferredSub, baseUrl) : undefined
  }

  private videoSourceFrom(
    session: PlaySession,
    preferredSub = 'en-US',
    baseUrl = this.baseUrl,
    includeRelease = true,
  ): VideoSource {
    const url = initialPlaybackUrl(baseUrl, session, preferredSub)
    const audio: 'sub' | 'dub' = session.audioLocale?.startsWith('ja') ? 'sub' : 'dub'
    const proxyTrack = (track: { url: string; language: string; isDefault?: boolean }, kind: 'subtitles' | 'captions') => ({
      url: `${baseUrl}/v/${session.id}/asset?u=${encodeURIComponent(track.url)}`,
      language: track.language,
      isDefault: kind === 'subtitles' && (track.language === preferredSub || !!track.isDefault),
      kind,
    })
    const softLangs = new Set(session.subtitles.map((track) => track.language))
    const subtitles = [
      ...session.subtitles.filter((track) => track.url).map((track) => proxyTrack(track, 'subtitles')),
      ...session.captions.filter((track) => track.url).map((track) => proxyTrack(track, 'captions')),
      ...session.hardSubs
        .filter((track) => track.url && !softLangs.has(track.language))
        .map((track) => ({
          url: `${baseUrl}/v/${session.id}/manifest.mpd?hard=${encodeURIComponent(track.language)}`,
          language: track.language,
          kind: 'subtitles' as const,
          isDefault: track.language === preferredSub && audio === 'sub',
          switchUrl: `${baseUrl}/v/${session.id}/manifest.mpd?hard=${encodeURIComponent(track.language)}`,
        })),
    ]
    const audioTracks = session.versions.map((version) => ({
      language: version.language,
      switchUrl: `${baseUrl}/v/${session.id}/manifest.mpd?audio=${encodeURIComponent(version.language)}`,
    }))
    const type = session.videoContainer === 'hls' ? 'm3u8' : 'dash'
    const drm = type === 'dash'
      ? {
          keySystem: 'com.widevine.alpha',
          licenseUrl: `${baseUrl}/v/${session.id}/license`,
          releaseUrl: includeRelease ? `${baseUrl}/v/${session.id}/session` : undefined,
          refreshUrl: `${baseUrl}/v/${session.id}/source`,
          videoRobustness: 'SW_SECURE_CRYPTO',
          audioRobustness: 'SW_SECURE_CRYPTO',
        }
      : undefined
    return {
      url,
      type,
      quality: 'adaptive',
      server: 'Crunchyroll',
      audio,
      audioLang: session.audioLocale,
      subtitleMode: session.subtitles.length || session.captions.length ? 'soft' : 'hard',
      subtitles,
      audioTracks: audioTracks.length ? audioTracks : undefined,
      previewUrl: session.previewUrl
        ? `${baseUrl}/v/${session.id}/asset?u=${encodeURIComponent(session.previewUrl)}`
        : undefined,
      drm,
    }
  }

  session(id: string): PlaySession | undefined {
    return this.play.get(id)
  }

  async close(): Promise<void> {
    this.auth.shutdown()
    await this.play.closeAll()
    await this.transport.close?.()
  }

  private async syncChromeProfile(): Promise<void> {
    const transport = this.transport as { setProfile?: (p: ClientProfile) => Promise<void>; setEtpRt?: (v: string) => Promise<void> }
    await transport.setProfile?.(this.auth.profile)
    const etp = loadSession()?.etpRt
    if (etp) await transport.setEtpRt?.(etp)
  }
}
