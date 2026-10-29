import { DEFAULT_LOCALE, HOSTS, type ClientProfile } from './constants.js'
import { crHeaders } from './headers.js'
import { jsonOrThrow, type CrTransport } from './http.js'
import { makeMediaId, pickVersionGuid, seasonTitleVariants, yearMatches, yearOf } from './match.js'
import type { Auth } from './auth.js'

export interface SearchHit {
  id: string
  title: string
  url?: string
  subOrDub?: 'sub' | 'dub'
}

export interface EpisodeHit {
  id: string
  number: number
  title?: string
  url?: string
  sourceTitle?: string
}

export interface EpisodePlaybackMeta {
  audioLocale?: string
  versions: Array<{ language: string; guid: string }>
}

interface CmsList<T> {
  data?: T[]
  items?: T[]
}

interface SeriesItem {
  id?: string
  title?: string
  type?: string
  linked_resource?: { type?: string; id?: string }
}

export interface SeasonItem {
  id: string
  title?: string
  season_number?: number
  audio_locale?: string
  identifier?: string
  series_id?: string
  /** The season in each audio (its dubs), by season id. */
  versions?: Array<{ audio_locale?: string; guid?: string; original?: boolean }>
}

export interface EpisodeItem {
  id: string
  title?: string
  description?: string
  episode_number?: number
  sequence_number?: number
  season_number?: number
  duration_ms?: number
  audio_locale?: string
  is_clip?: boolean
  is_premium_only?: boolean
  episode_air_date?: string
  upload_date?: string
  versions?: Array<{ audio_locale?: string; guid?: string; original?: boolean }>
  images?: { thumbnail?: Array<Array<{ source?: string; width?: number; height?: number }>> }
}

function listOf<T>(payload: CmsList<T> | undefined): T[] {
  return payload?.data ?? payload?.items ?? []
}

function apiBase(profile: ClientProfile): string {
  return profile === 'tv' ? HOSTS.api : HOSTS.www
}

export class Catalog {
  private seasonCache = new Map<string, { at: number; seasons: SeasonItem[] }>()
  private jsonCache = new Map<string, { expiresAt: number; value: unknown }>()
  private jsonJobs = new Map<string, Promise<unknown>>()
  private playbackMeta = new Map<string, EpisodePlaybackMeta>()

  constructor(
    private transport: CrTransport,
    private auth: Auth,
  ) {}

  /** Coalesce Izumi's simultaneous Sub/Dub calls and keep hot catalogue data local. */
  private async cachedJson<T>(url: string, headers: Record<string, string>, ttlMs = 5 * 60_000): Promise<T> {
    const cached = this.jsonCache.get(url)
    if (cached && cached.expiresAt > Date.now()) return cached.value as T
    const pending = this.jsonJobs.get(url)
    if (pending) return pending as Promise<T>
    const job = (async () => jsonOrThrow<T>(await this.transport.request({ url, headers })))()
      .then((value) => {
        this.jsonCache.set(url, { expiresAt: Date.now() + ttlMs, value })
        return value
      })
    this.jsonJobs.set(url, job)
    try {
      return await job
    } finally {
      this.jsonJobs.delete(url)
    }
  }

  async search(query: string, dub: boolean, year?: number): Promise<SearchHit[]> {
    const q = query.trim()
    if (!q) return []
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const audio = dub ? 'en-US' : 'ja-JP'
    const url =
      `${apiBase(profile)}/content/v2/discover/search?q=${encodeURIComponent(q)}` +
      `&n=20&start=0&type=series,movie_listing&locale=${DEFAULT_LOCALE}`
    console.log(`[cr] search ${profile} ${url}`)
    const json = await this.cachedJson<{ data?: Array<{ type?: string; items?: SeriesItem[] }> }>(
      url,
      crHeaders({ profile, authorization: `Bearer ${token}` }),
    )
    const series = (json.data ?? []).flatMap((bucket) => bucket.items ?? []).filter((item) => item.id && item.title)
    const hits: SearchHit[] = []
    const seen = new Set<string>()
    const top = series.slice(0, 5)
    const seasonLists = await Promise.all(
      top.map(async (item) => ({ item, seasons: await this.seasons(item.id!).catch(() => [] as SeasonItem[]) })),
    )
    for (const { item, seasons } of seasonLists) {
      const seriesId = item.id!
      const usable = seasons.length ? seasons : [{ id: seriesId, title: item.title, season_number: 1 }]
      for (const season of usable) {
        const seasonNumber = season.season_number ?? 1
        if (!yearMatches(year, yearOf(undefined))) continue
        const titles = seasonTitleVariants(item.title ?? seriesId, seasonNumber, season.title)
        for (const title of titles) {
          const id = makeMediaId(seriesId, season.id, audio)
          const key = `${id}|${title}`
          if (seen.has(key)) continue
          seen.add(key)
          hits.push({
            id,
            title,
            url: `${HOSTS.www}/series/${seriesId}`,
            subOrDub: dub ? 'dub' : 'sub',
          })
        }
      }
    }
    return hits
  }

  async seasons(seriesId: string, locale = DEFAULT_LOCALE): Promise<SeasonItem[]> {
    const cacheKey = `${this.auth.profile}:${locale}:${seriesId}`
    const cached = this.seasonCache.get(cacheKey)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.seasons
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const url = `${apiBase(profile)}/content/v2/cms/series/${encodeURIComponent(seriesId)}/seasons?locale=${locale}`
    const json = await this.cachedJson<CmsList<SeasonItem>>(
      url,
      crHeaders({ profile, authorization: `Bearer ${token}` }),
    )
    const seasons = listOf(json).filter((season) => season.id)
    this.seasonCache.set(cacheKey, { at: Date.now(), seasons })
    return seasons
  }

  /** A season's playable episodes (no clips), in order, with every audio version remembered for
   *  playback. Returns each episode with the id of the version in `audio`. */
  async seasonEpisodes(seasonId: string, audio: string, locale = DEFAULT_LOCALE): Promise<Array<EpisodeItem & { number: number; guid: string }>> {
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const url = `${apiBase(profile)}/content/v2/cms/seasons/${encodeURIComponent(seasonId)}/episodes?locale=${locale}`
    const json = await this.cachedJson<CmsList<EpisodeItem>>(
      url,
      crHeaders({ profile, authorization: `Bearer ${token}` }),
    )
    const out: Array<EpisodeItem & { number: number; guid: string }> = []
    for (const episode of listOf(json)) {
      if (!episode.id || episode.is_clip) continue
      const number = Number(episode.episode_number ?? episode.sequence_number)
      if (!Number.isFinite(number) || number <= 0) continue
      const guid = pickVersionGuid(episode.versions, episode.id, audio)
      const versions = (episode.versions ?? [])
        .filter((version): version is { audio_locale: string; guid: string; original?: boolean } => !!version.audio_locale && !!version.guid)
        .map((version) => ({ language: version.audio_locale, guid: version.guid }))
      if (!versions.some((version) => version.guid === episode.id) && episode.audio_locale) {
        versions.unshift({ language: episode.audio_locale, guid: episode.id })
      }
      const meta = { audioLocale: versions.find((version) => version.guid === guid)?.language ?? audio, versions }
      this.playbackMeta.set(guid, meta)
      for (const version of versions) this.playbackMeta.set(version.guid, { audioLocale: version.language, versions })
      out.push({ ...episode, number, guid })
    }
    out.sort((a, b) => a.number - b.number)
    return out
  }

  async episodes(mediaId: string): Promise<EpisodeHit[]> {
    const { seriesId, seasonId, audio } = split(mediaId)
    const sourceTitle = await this.seasonTitle(seriesId, seasonId)
    const out: EpisodeHit[] = []
    for (const { guid, number, title } of await this.seasonEpisodes(seasonId, audio)) {
      out.push({
        id: guid,
        number,
        title,
        url: `${HOSTS.www}/watch/${guid}`,
        sourceTitle,
      })
    }
    return out
  }

  episodePlaybackMeta(contentId: string): EpisodePlaybackMeta | undefined {
    return this.playbackMeta.get(contentId)
  }

  private async seasonTitle(seriesId: string, seasonId: string): Promise<string> {
    try {
      const seasons = await this.seasons(seriesId)
      const season = seasons.find((item) => item.id === seasonId)
      const title = season?.title
      if (title && !/^season\s*\d+/i.test(title) && !/^final season$/i.test(title ?? '')) return title
      const token = await this.auth.accessToken()
      const profile = this.auth.profile
      const json = await jsonOrThrow<{ data?: Array<{ title?: string }> }>(
        await this.transport.request({
          url: `${apiBase(profile)}/content/v2/cms/objects/${encodeURIComponent(seriesId)}?locale=${DEFAULT_LOCALE}`,
          headers: crHeaders({ profile, authorization: `Bearer ${token}` }),
        }),
      )
      const seriesTitle = json.data?.[0]?.title
      if (!seriesTitle) return title ?? seriesId
      const n = season?.season_number ?? 1
      return n <= 1 ? seriesTitle : `${seriesTitle} Season ${n}`
    } catch {
      return seriesId
    }
  }
}

function split(id: string): { seriesId: string; seasonId: string; audio: string } {
  const [seriesId, seasonId, audio] = id.split('|')
  if (!seriesId || !seasonId) throw new Error('invalid Crunchyroll media id')
  return { seriesId, seasonId, audio: audio || 'ja-JP' }
}
