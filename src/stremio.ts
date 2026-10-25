// Crunchyroll's catalogue in the Stremio addon protocol, served by the local service under
// /stremio/. izumi (and any Stremio client) reads it like an addon: catalogs for the home feed and
// hero, metas with every season's episodes, and streams. Extras for izumi ride in an `izumi` field
// that other clients ignore: ratings, Sub | Dub, playheads, the watchlist and where to report
// progress.
import type { CrunchyrollApp } from './app.js'
import { CRUNCHYROLL_ICON } from './brand.js'
import { curationUrl, pickImage, type CrPanel, type CrSeriesMetadata, type HeroCard } from './cr/content.js'
import type { EpisodeItem, SeasonItem } from './cr/catalog.js'
import { DEFAULT_LOCALE } from './cr/constants.js'

export const ADDON_ID = 'crunchyroll.izumi.catalog'
const PREFIX = 'cr:'

export interface StremioVideo {
  id: string
  title: string
  season?: number
  episode?: number
  released?: string
  overview?: string
  thumbnail?: string
  izumi?: { playhead?: number; durationSec?: number; progress?: number; watched?: boolean; premium?: boolean }
}

export interface StremioMeta {
  id: string
  type: 'series' | 'movie'
  name: string
  poster?: string
  posterShape?: 'poster' | 'landscape'
  background?: string
  logo?: string
  description?: string
  genres?: string[]
  releaseInfo?: string
  videos?: StremioVideo[]
  izumi?: {
    rating?: string
    audio?: string
    /** A Continue Watching card: the episode to resume and how far along it is. */
    continue?: { videoId: string; label: string; remainingSec?: number; progress?: number }
    /** An episode card that isn't resumable (recent episodes): its label. */
    episode?: { videoId: string; label: string }
    upNext?: { videoId: string; label: string; playhead: number }
    watchlist?: boolean
    watchlistUrl?: string
    isNew?: boolean
  }
}

export interface CatalogEntry {
  type: 'series' | 'movie'
  id: string
  name: string
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>
  izumi?: { hero?: true; continue?: true }
}

/** "TV-14" → "14+", "16" → "16+"; the locale-correct extended rating wins (as Crunchy Deck shows it). */
export function ratingOf(meta: Pick<CrSeriesMetadata, 'maturity_ratings' | 'extended_maturity_rating'> | undefined): string | undefined {
  const raw = meta?.extended_maturity_rating?.rating ?? meta?.maturity_ratings?.[0]
  if (!raw) return undefined
  const value = String(raw).replace(/^[A-Za-z]+-/, '')
  return /^\d+$/.test(value) ? `${value}+` : value
}

export function audioLabel(meta: { is_subbed?: boolean; is_dubbed?: boolean } | undefined): string | undefined {
  const parts = [meta?.is_subbed ? 'Sub' : '', meta?.is_dubbed ? 'Dub' : ''].filter(Boolean)
  return parts.length ? parts.join(' | ') : undefined
}

export function episodeLabel(season: number | undefined, episode: number | string | undefined): string {
  return [season != null ? `S${season}` : '', episode != null && episode !== '' ? `E${episode}` : ''].filter(Boolean).join(' ')
}

// As Crunchy Deck prints them: "slice-of-life" reads "Slice Of Life".
const titleCase = (value: string) => value.replace(/[-_]+/g, ' ').replace(/(^|\s)(\w)/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())

function seriesFields(meta: CrSeriesMetadata | undefined) {
  return {
    genres: meta?.tenant_categories?.slice(0, 4).map(titleCase),
    releaseInfo: meta?.series_launch_year ? String(meta.series_launch_year) : undefined,
  }
}

/** One catalogue item. Episode panels (Continue Watching, recent episodes) become their series,
 *  shown with the episode's still, label and progress. */
export function metaPreview(panel: CrPanel): StremioMeta | undefined {
  const series = panel.series_metadata ?? panel.movie_listing_metadata
  if (panel.type === 'series' || panel.type === 'movie_listing') {
    return {
      id: PREFIX + panel.id,
      type: panel.type === 'series' ? 'series' : 'movie',
      name: panel.title ?? panel.id,
      poster: pickImage(panel.images, 'poster_tall', 360),
      background: pickImage(panel.images, 'poster_wide', 1280),
      description: panel.description,
      ...seriesFields(series),
      izumi: { rating: ratingOf(series), audio: audioLabel(series), ...(panel.new ? { isNew: true } : {}) },
    }
  }
  const episode = panel.episode_metadata ?? panel.movie_metadata
  const owner = panel.episode_metadata?.series_id ?? panel.movie_metadata?.movie_listing_id
  if (!episode || !owner) return undefined
  const label = panel.episode_metadata ? episodeLabel(episode.season_number, episode.episode_number ?? episode.episode) : ''
  const durationSec = episode.duration_ms ? episode.duration_ms / 1000 : undefined
  const playhead = panel.playhead ?? 0
  const resumable = playhead > 0 && !panel.fully_watched
  const still = pickImage(panel.images, 'thumbnail', 640)
  return {
    id: PREFIX + owner,
    type: panel.episode_metadata ? 'series' : 'movie',
    name: panel.episode_metadata?.series_title ?? panel.movie_metadata?.movie_listing_title ?? panel.title ?? owner,
    poster: still,
    posterShape: 'landscape',
    background: still,
    description: panel.description,
    izumi: {
      ...(resumable
        ? {
          continue: {
            videoId: PREFIX + panel.id,
            label,
            ...(durationSec ? { remainingSec: Math.max(0, Math.round(durationSec - playhead)), progress: Math.min(1, playhead / durationSec) } : {}),
          },
        }
        : { episode: { videoId: PREFIX + panel.id, label } }),
      ...(panel.new ? { isNew: true } : {}),
    },
  }
}

/** A curated hero card: wide art, poster and the transparent title logo. */
export function heroMeta(card: HeroCard): StremioMeta {
  return {
    id: PREFIX + card.contentId,
    type: 'series',
    name: card.title,
    background: curationUrl(card.wideImage, 1920) ?? curationUrl(card.tallImage, 1200),
    poster: curationUrl(card.tallImage, 480),
    logo: curationUrl(card.logoImage, 600),
    description: card.description,
  }
}

/** A featured title's facts line (age rating, Sub | Dub, genres), from its catalogue object. */
export function withFacts(meta: StremioMeta, panel: CrPanel | undefined): StremioMeta {
  const series = panel?.series_metadata ?? panel?.movie_listing_metadata
  if (!series) return meta
  const rating = ratingOf(series)
  const audio = audioLabel(series)
  return {
    ...meta,
    ...seriesFields(series),
    izumi: { ...meta.izumi, ...(rating ? { rating } : {}), ...(audio ? { audio } : {}) },
  }
}

/** A featured title the viewer has started: its banner says Continue and resumes that episode. */
export function withResume(meta: StremioMeta, next: { panel: CrPanel; playhead: number; fullyWatched: boolean } | undefined): StremioMeta {
  if (!next || next.fullyWatched || !(next.playhead > 0)) return meta
  const episode = next.panel.episode_metadata ?? next.panel.movie_metadata
  const durationSec = episode?.duration_ms ? episode.duration_ms / 1000 : undefined
  return {
    ...meta,
    izumi: {
      ...meta.izumi,
      continue: {
        videoId: PREFIX + next.panel.id,
        label: next.panel.episode_metadata ? episodeLabel(episode?.season_number, episode?.episode_number ?? episode?.episode) : '',
        // At least 1%, so a resume point always reads as one.
        progress: durationSec ? Math.max(0.01, Math.min(1, next.playhead / durationSec)) : 0.01,
        ...(durationSec ? { remainingSec: Math.max(0, Math.round(durationSec - next.playhead)) } : {}),
      },
    },
  }
}

export function videoOf(episode: EpisodeItem & { number: number; guid: string }, season: number | undefined, playhead?: { playhead: number; fullyWatched: boolean }): StremioVideo {
  const durationSec = episode.duration_ms ? Math.round(episode.duration_ms / 1000) : undefined
  return {
    id: PREFIX + episode.guid,
    title: episode.title ?? `Episode ${episode.number}`,
    season,
    episode: episode.number,
    released: episode.episode_air_date ?? episode.upload_date,
    overview: episode.description,
    thumbnail: pickImage(episode.images as never, 'thumbnail', 640),
    izumi: {
      durationSec,
      ...(playhead ? {
        playhead: playhead.playhead,
        watched: playhead.fullyWatched,
        progress: playhead.fullyWatched ? 1 : durationSec ? Math.min(1, playhead.playhead / durationSec) : undefined,
      } : {}),
      ...(episode.is_premium_only ? { premium: true } : {}),
    },
  }
}

/** One season per number: Crunchyroll lists a season once per dub. The preferred audio wins. */
export function pickSeasons(seasons: SeasonItem[], audio: string): SeasonItem[] {
  const byNumber = new Map<number, SeasonItem>()
  for (const season of seasons) {
    const n = season.season_number ?? 1
    const current = byNumber.get(n)
    if (!current || (season.audio_locale === audio && current.audio_locale !== audio)) byNumber.set(n, season)
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([, season]) => season)
}

export function stripPrefix(id: string): string | undefined {
  return id.startsWith(PREFIX) && id.length > PREFIX.length ? id.slice(PREFIX.length) : undefined
}

/** `skip=24&search=one%20piece` → {skip: 24, search: "one piece"}. */
export function parseExtra(extra: string | undefined): { skip: number; search?: string } {
  const params = new URLSearchParams(extra ?? '')
  const skip = Number(params.get('skip') ?? 0)
  const search = params.get('search') ?? undefined
  return { skip: Number.isFinite(skip) && skip > 0 ? Math.floor(skip) : 0, ...(search ? { search } : {}) }
}

const PAGED: Record<string, { name: string; sort: 'popularity' | 'newly_added'; seasonal?: boolean }> = {
  'cr-popular': { name: 'Popular', sort: 'popularity' },
  'cr-newest': { name: 'New', sort: 'newly_added' },
  'cr-simulcast': { name: 'Simulcast season', sort: 'popularity', seasonal: true },
}

export class StremioCatalog {
  constructor(private app: CrunchyrollApp) {}

  private signedIn(): boolean {
    return this.app.auth.status().authenticated
  }

  async manifest(): Promise<Record<string, unknown>> {
    const feed = this.signedIn() ? await this.app.content.homeRows().catch(() => []) : []
    const catalogs: CatalogEntry[] = [
      { type: 'series', id: 'cr-hero', name: 'Featured', izumi: { hero: true } },
      ...feed.map((row) => ({
        type: 'series' as const,
        id: row.id,
        name: row.title,
        ...(row.kind === 'history' ? { izumi: { continue: true as const } } : {}),
      })),
      ...Object.entries(PAGED).map(([id, row]) => ({ type: 'series' as const, id, name: row.name, extra: [{ name: 'skip' }] })),
      { type: 'series', id: 'cr-search', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
    ]
    return {
      id: ADDON_ID,
      version: '0.1.3',
      name: 'Crunchyroll',
      description: 'Your Crunchyroll home, watchlist and catalogue.',
      logo: CRUNCHYROLL_ICON,
      resources: ['catalog', 'meta', 'stream'],
      types: ['series', 'movie'],
      idPrefixes: [PREFIX],
      catalogs,
      behaviorHints: { configurable: false },
    }
  }

  async catalog(id: string, extra: string | undefined): Promise<StremioMeta[]> {
    if (!this.signedIn()) return []
    const { skip, search } = parseExtra(extra)
    const content = this.app.content
    if (id === 'cr-hero') {
      const cards = await content.hero()
      const [next, objects] = await Promise.all([
        Promise.all(cards.map((card) => content.upNext(card.contentId).catch(() => undefined))),
        content.objects(cards.map((card) => card.contentId)).catch(() => new Map<string, CrPanel>()),
      ])
      return cards.map((card, index) => withResume(withFacts(heroMeta(card), objects.get(card.contentId)), next[index]))
    }
    if (id === 'cr-search') return search ? collect(await content.search(search)) : []
    const paged = PAGED[id]
    if (paged) return collect(await content.browse({ sort: paged.sort, seasonal: paged.seasonal, start: skip, n: 24 }))
    const row = (await content.homeRows()).find((item) => item.id === id)
    return row ? collect(await content.rowItems(row)) : []
  }

  async meta(id: string, baseUrl: string): Promise<StremioMeta | undefined> {
    const contentId = stripPrefix(id)
    if (!contentId || !this.signedIn()) return undefined
    const content = this.app.content
    const object = await content.object(contentId)
    if (!object) return undefined
    const preview = metaPreview(object)
    if (!preview) return undefined
    const audio = await content.preferredAudio()
    const videos: StremioVideo[] = []
    const episodes: Array<{ episode: EpisodeItem & { number: number; guid: string }; season?: number }> = []
    if (object.type === 'series') {
      const seasons = pickSeasons(await this.app.catalog.seasons(contentId), audio)
      const lists = await Promise.all(seasons.map((season) => this.app.catalog.seasonEpisodes(season.id, audio)))
      seasons.forEach((season, index) => {
        for (const episode of lists[index] ?? []) episodes.push({ episode, season: season.season_number })
      })
    } else {
      const movies = await content.movies(contentId).catch(() => [])
      movies.forEach((movie, index) => episodes.push({
        episode: {
          id: movie.id,
          guid: movie.id,
          number: index + 1,
          title: movie.title,
          description: movie.description,
          duration_ms: movie.movie_metadata?.duration_ms,
          images: movie.images as EpisodeItem['images'],
        },
      }))
    }
    const playheads = await content.playheads(episodes.map(({ episode }) => episode.guid)).catch(() => new Map())
    for (const { episode, season } of episodes) videos.push(videoOf(episode, season, playheads.get(episode.guid)))
    const [upNext, inWatchlist] = await Promise.all([
      content.upNext(contentId).catch(() => undefined),
      content.inWatchlist(contentId).catch(() => undefined),
    ])
    const next = upNext && !upNext.fullyWatched ? upNext.panel : undefined
    return {
      ...preview,
      videos,
      izumi: {
        ...preview.izumi,
        ...(next ? {
          upNext: {
            videoId: PREFIX + next.id,
            label: episodeLabel(next.episode_metadata?.season_number, next.episode_metadata?.episode_number),
            playhead: upNext!.playhead,
          },
        } : {}),
        ...(inWatchlist !== undefined ? { watchlist: inWatchlist, watchlistUrl: `${baseUrl}/stremio/watchlist/${encodeURIComponent(id)}` } : {}),
      },
    }
  }

  /** The episode's stream: what the onlinestream `play` call returns, plus where to report progress. */
  async stream(id: string, baseUrl: string): Promise<Array<Record<string, unknown>>> {
    const episodeId = stripPrefix(id)
    if (!episodeId || !this.signedIn()) return []
    const server = await this.app.episodeServer(episodeId, DEFAULT_LOCALE, baseUrl)
    return server.videoSources.map((source) => ({
      ...source,
      name: 'Crunchyroll',
      title: 'Crunchyroll',
      behaviorHints: { notWebReady: true, proxyHeaders: { request: server.headers } },
      izumi: {
        onlinestream: true,
        headers: server.headers,
        progressUrl: `${baseUrl}/stremio/progress?video=${encodeURIComponent(id)}`,
      },
    }))
  }

  async progress(videoId: string, position: number): Promise<void> {
    const contentId = stripPrefix(videoId)
    if (contentId) await this.app.content.setPlayhead(contentId, position)
  }

  async setWatchlist(metaId: string, on: boolean): Promise<boolean> {
    const contentId = stripPrefix(metaId)
    if (!contentId) throw new Error('unknown title')
    await this.app.content.setWatchlist(contentId, on)
    return on
  }
}

function collect(panels: CrPanel[]): StremioMeta[] {
  const out: StremioMeta[] = []
  const seen = new Set<string>()
  for (const panel of panels) {
    const meta = metaPreview(panel)
    if (!meta || seen.has(meta.id)) continue
    seen.add(meta.id)
    out.push(meta)
  }
  return out
}
