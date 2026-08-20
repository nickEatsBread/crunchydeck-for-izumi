import { Auth, type AccountStatus, type DeviceCode } from './cr/auth.js'
import { Catalog, type EpisodeHit, type SearchHit } from './cr/catalog.js'
import { tryChromeTransport } from './cr/chrome.js'
import { FetchTransport, type CrTransport } from './cr/http.js'
import { PlayService, type PlaySession } from './cr/play.js'
import { proxyUrl } from './cr/proxy.js'
import { loadSession } from './storage.js'
import type { ClientProfile } from './cr/constants.js'

export interface VideoSource {
  url: string
  type: 'mp4' | 'm3u8' | 'dash'
  quality: string
  server?: string
  audio?: 'sub' | 'dub'
  subtitleMode?: 'soft' | 'hard'
  subtitles: Array<{ url: string; language: string; isDefault?: boolean }>
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
  readonly play: PlayService
  baseUrl = 'http://127.0.0.1:17871'

  private constructor(transport: CrTransport) {
    this.transport = transport
    this.auth = new Auth(transport, loadSession())
    this.catalog = new Catalog(transport, this.auth)
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

  async pollDeviceCode(deviceCode: string) {
    const result = await this.auth.pollDeviceCode(deviceCode)
    if (!result.pending) await this.syncChromeProfile()
    return result
  }

  logout(): void {
    this.auth.logout()
  }

  search(query: string, dub: boolean, year?: number): Promise<SearchHit[]> {
    return this.catalog.search(query, dub, year)
  }

  episodes(id: string): Promise<EpisodeHit[]> {
    return this.catalog.episodes(id)
  }

  async episodeServer(episodeId: string, preferredSub = 'en-US'): Promise<EpisodeServer> {
    const session = await this.play.resolve(episodeId)
    const url = proxyUrl(this.baseUrl, session)
    const audio: 'sub' | 'dub' = session.audioLocale?.startsWith('ja') ? 'sub' : 'dub'
    const subtitles = [...session.subtitles, ...session.captions]
      .filter((track) => track.url)
      .map((track) => ({
        url: `${this.baseUrl}/v/${session.id}/asset?u=${encodeURIComponent(track.url)}`,
        language: track.language,
        isDefault: track.language === preferredSub || track.isDefault,
      }))
    const type = session.videoContainer === 'hls' ? 'm3u8' : 'dash'
    return {
      server: 'Crunchyroll',
      headers: {
        Referer: 'https://www.crunchyroll.com/',
        Origin: 'https://www.crunchyroll.com',
      },
      videoSources: [
        {
          url,
          type,
          quality: 'adaptive',
          server: 'Crunchyroll',
          audio,
          subtitleMode: 'soft',
          subtitles,
        },
      ],
    }
  }

  session(id: string): PlaySession | undefined {
    return this.play.get(id)
  }

  async close(): Promise<void> {
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
