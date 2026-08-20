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

interface SeasonItem {
  id: string
  title?: string
  season_number?: number
  audio_locale?: string
  identifier?: string
  series_id?: string
}

interface EpisodeItem {
  id: string
  title?: string
  episode_number?: number
  sequence_number?: number
  audio_locale?: string
  is_clip?: boolean
  episode_air_date?: string
  upload_date?: string
  versions?: Array<{ audio_locale?: string; guid?: string; original?: boolean }>
  images?: { thumbnail?: Array<Array<{ source?: string }>> }
}

function listOf<T>(payload: CmsList<T> | undefined): T[] {
  return payload?.data ?? payload?.items ?? []
}

function apiBase(profile: ClientProfile): string {
  return profile === 'tv' ? HOSTS.api : HOSTS.www
}

export class Catalog {
  private seasonCache = new Map<string, { at: number; seasons: SeasonItem[] }>()

  constructor(
    private transport: CrTransport,
    private auth: Auth,
  ) {}

  async search(query: string, dub: boolean, year?: number): Promise<SearchHit[]> {
    const q = query.trim()
    if (!q) return []
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const audio = dub ? 'en-US' : 'ja-JP'
    const url =
      `${apiBase(profile)}/content/v2/discover/search?q=${encodeURIComponent(q)}` +
      `&n=20&start=0&type=series,movie_listing&locale=${DEFAULT_LOCALE}`
    const json = await jsonOrThrow<{ data?: Array<{ type?: string; items?: SeriesItem[] }> }>(
      await this.transport.request({
        url,
        headers: crHeaders({ profile, authorization: `Bearer ${token}` }),
      }),
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

  async seasons(seriesId: string): Promise<SeasonItem[]> {
    const cached = this.seasonCache.get(seriesId)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.seasons
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const json = await jsonOrThrow<CmsList<SeasonItem>>(
      await this.transport.request({
        url: `${apiBase(profile)}/content/v2/cms/series/${encodeURIComponent(seriesId)}/seasons?locale=${DEFAULT_LOCALE}`,
        headers: crHeaders({ profile, authorization: `Bearer ${token}` }),
      }),
    )
    const seasons = listOf(json).filter((season) => season.id)
    this.seasonCache.set(seriesId, { at: Date.now(), seasons })
    return seasons
  }

  async episodes(mediaId: string): Promise<EpisodeHit[]> {
    const { seriesId, seasonId, audio } = split(mediaId)
    const token = await this.auth.accessToken()
    const profile = this.auth.profile
    const json = await jsonOrThrow<CmsList<EpisodeItem>>(
      await this.transport.request({
        url: `${apiBase(profile)}/content/v2/cms/seasons/${encodeURIComponent(seasonId)}/episodes?locale=${DEFAULT_LOCALE}`,
        headers: crHeaders({ profile, authorization: `Bearer ${token}` }),
      }),
    )
    const sourceTitle = await this.seasonTitle(seriesId, seasonId)
    const out: EpisodeHit[] = []
    for (const episode of listOf(json)) {
      if (!episode.id || episode.is_clip) continue
      const number = Number(episode.episode_number ?? episode.sequence_number)
      if (!Number.isFinite(number) || number <= 0) continue
      const guid = pickVersionGuid(episode.versions, episode.id, audio)
      out.push({
        id: guid,
        number,
        title: episode.title,
        url: `${HOSTS.www}/watch/${guid}`,
        sourceTitle,
      })
    }
    out.sort((a, b) => a.number - b.number)
    return out
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
