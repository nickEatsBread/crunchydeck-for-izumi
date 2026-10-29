// Crunchyroll's catalogue in the Stremio addon protocol, served by the local service under
// /stremio/. izumi (and any Stremio client) reads it like an addon: catalogs for the home feed and
// hero, metas with every season's episodes, and streams. Extras for izumi ride in an `izumi` field
// that other clients ignore: ratings, Sub | Dub, playheads, the watchlist and where to report
// progress.
import type { CrunchyrollApp, VideoSource } from './app.js'
import { CRUNCHYROLL_ICON } from './brand.js'
import { curationUrl, pickImage, type CrCategory, type CrPanel, type CrSeason, type CrSeriesMetadata, type HeroCard } from './cr/content.js'
import type { EpisodeItem, SeasonItem } from './cr/catalog.js'
import { DEFAULT_LOCALE } from './cr/constants.js'
import { anilistGraphQl, politeGraphQl, TrackIdService, type TrackIds } from './cr/anime-ids.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './storage.js'

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
  izumi?: {
    playhead?: number; durationSec?: number; progress?: number; watched?: boolean; premium?: boolean
    /** The AniList (and MyAnimeList) entry this episode is, and its number there, for tracking. */
    track?: TrackIds
  }
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
    /** A series' seasons in Crunchyroll's order, with Crunchyroll's titles (see meta()). */
    seasons?: Array<{ number: number; title: string }>
  }
}

export interface CatalogEntry {
  type: 'series' | 'movie'
  id: string
  name: string
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[]; izumi?: { images?: Record<string, string> } }>
  izumi?: {
    hero?: true; continue?: true; home?: boolean; homeFilters?: boolean; browse?: boolean
    /** Lists the catalog in izumi's drawer as its own screen; `extra` opens it on that extra's options. */
    menu?: { label: string; icon?: 'bookmark' | 'history' | 'calendar' | 'list'; extra?: string }
  }
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
    // Opaque art as JPEG: the automatic format serves these as PNG, whose decode froze the Deck's
    // banner for ~70 ms a slide (JPEG: ~33 ms, no dropped frame). The logo needs its transparency.
    background: curationUrl(card.wideImage, 1920, 'jpeg') ?? curationUrl(card.tallImage, 1200, 'jpeg'),
    poster: curationUrl(card.tallImage, 480, 'jpeg'),
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

/** One version of every season, in Crunchyroll's order: Crunchyroll can list a season once per dub.
 *  A season's `versions` name its dubs; a listing without them is grouped by season number, so a
 *  season in another audio under the same number counts as a dub. The preferred audio wins, else
 *  the original, else the first listed. Different seasons sharing a number are all kept. */
export function pickSeasons(seasons: SeasonItem[], audio: string): SeasonItem[] {
  const linked = (season: SeasonItem) => new Set((season.versions ?? []).flatMap((version) => (version.guid && version.guid !== season.id && seasons.some((other) => other.id === version.guid) ? [version.guid] : [])))
  return seasons.filter((season) => {
    const dubs = linked(season)
    const group = dubs.size
      ? seasons.filter((other) => other === season || dubs.has(other.id))
      : seasons.filter((other) => (other.season_number ?? 1) === (season.season_number ?? 1) && !linked(other).size)
    const original = group.find((other) => other.versions?.some((version) => version.guid === other.id && version.original)) ?? group[0]
    return season.audio_locale === (group.some((other) => other.audio_locale === audio) ? audio : original?.audio_locale)
  })
}

/** The `season` each picked season's videos carry: Crunchyroll's number, unless two seasons share one
 *  (a second cour, a recap or a cut listed under the same number). A Stremio client groups episodes
 *  by that number, so the seasons would merge into one; then all are numbered in Crunchyroll's order. */
export function seasonNumbers(seasons: SeasonItem[]): number[] {
  const numbers = seasons.map((season) => season.season_number ?? 1)
  return new Set(numbers).size === numbers.length ? numbers : numbers.map((_number, index) => index + 1)
}

/** The profile's subtitle language as the stream's default track. '' turns subtitles off; a language
 *  the episode does not offer (or only burned in, under a dub) leaves the default as it was. */
export function withSubtitle(source: VideoSource, language: string | undefined): VideoSource {
  // No preference (unset reads as '') keeps the stream's own default, English, rather than turning
  // subtitles off: Japanese audio with no subtitles is the worse surprise.
  if (!language) return source
  const pick = source.subtitles.find((track) => track.language === language && track.kind !== 'captions' && (!track.switchUrl || source.audio === 'sub'))
  if (!pick) return source
  return {
    ...source,
    subtitles: source.subtitles.map((track) => ({ ...track, isDefault: track === pick })),
    ...(source.share ? { share: withSubtitle(source.share, language) } : {}),
  }
}

export function stripPrefix(id: string): string | undefined {
  return id.startsWith(PREFIX) && id.length > PREFIX.length ? id.slice(PREFIX.length) : undefined
}

/** `skip=24&search=one%20piece&genre=Action` → {skip: 24, search: "one piece", genre: "Action"}. */
export function parseExtra(extra: string | undefined): { skip: number; search?: string; genre?: string; season?: string } {
  const params = new URLSearchParams(extra ?? '')
  const skip = Number(params.get('skip') ?? 0)
  const search = params.get('search') ?? undefined
  const genre = params.get('genre') ?? undefined
  const season = params.get('season') ?? undefined
  return { skip: Number.isFinite(skip) && skip > 0 ? Math.floor(skip) : 0, ...(search ? { search } : {}), ...(genre ? { genre } : {}), ...(season ? { season } : {}) }
}

/** Crunchyroll's categories as its Categories screen lists them, for the manifest while (or when)
 *  the live list cannot be read. */
export const FALLBACK_CATEGORIES: CrCategory[] = [
  { id: 'action', title: 'Action' },
  { id: 'adventure', title: 'Adventure' },
  { id: 'comedy', title: 'Comedy' },
  { id: 'drama', title: 'Drama' },
  { id: 'fantasy', title: 'Fantasy' },
  { id: 'music', title: 'Music' },
  { id: 'romance', title: 'Romance' },
  { id: 'sci-fi', title: 'Sci-Fi' },
  { id: 'seinen', title: 'Seinen' },
  { id: 'shojo', title: 'Shojo' },
  { id: 'shonen', title: 'Shonen' },
  { id: 'slice-of-life', title: 'Slice of life' },
  { id: 'sports', title: 'Sports' },
  { id: 'supernatural', title: 'Supernatural' },
  { id: 'thriller', title: 'Thriller' },
]

/** The id of an option title a client sent back (a `genre`, a `season`): the listed one's, else its slug. */
export function optionId(title: string, options: Array<{ id: string; title: string }>): string {
  const key = title.trim().toLowerCase()
  return options.find((option) => option.title.toLowerCase() === key)?.id ?? key.replace(/\s+/g, '-')
}

/** The `categories=` id of the category title a client sent back as `genre`. */
export function categoryId(title: string, categories: CrCategory[]): string {
  return optionId(title, [...categories, ...FALLBACK_CATEGORIES])
}

/** The season a date falls in, titled as Crunchyroll titles it ("Fall 2026"): the manifest's only
 *  season while (or when) the live list cannot be read. Its slug is the season's tag. */
export function seasonTitleOf(date: Date): string {
  return `${['Winter', 'Spring', 'Summer', 'Fall'][Math.floor(date.getMonth() / 3)]} ${date.getFullYear()}`
}

/** The most seasons izumi's Simulcasts screen offers. */
const SEASON_OPTIONS = 16

/** Crunchyroll episodes a History page reads. */
const HISTORY_PAGE = 100

/** The listings that page (`skip`) and narrow to a category (`genre`): izumi's Browse sorts. */
const PAGED: Record<string, { name: string; sort: 'popularity' | 'newly_added' | 'alphabetical'; seasonal?: boolean }> = {
  'cr-popular': { name: 'Popular', sort: 'popularity' },
  'cr-newest': { name: 'New', sort: 'newly_added' },
  'cr-simulcast': { name: 'Simulcast season', sort: 'popularity', seasonal: true },
  'cr-alphabetical': { name: 'A–Z', sort: 'alphabetical' },
}

/** How long a meta waits for AniList on a series it has not placed yet: not at all. The lookup runs
 *  on in the background and the next meta carries its ids; izumi finds the title by name until then. */
const TRACK_WAIT_MS = 0

function trackIdService(): TrackIdService {
  const file = () => join(dataDir(), 'anime-ids.json')
  return new TrackIdService(
    politeGraphQl(anilistGraphQl()),
    () => JSON.parse(readFileSync(file(), 'utf8')),
    (all) => writeFileSync(file(), JSON.stringify(all), 'utf8'),
  )
}

export class StremioCatalog {
  private trackIds?: TrackIdService
  private categories?: CrCategory[]
  private categoriesJob?: Promise<void>
  private seasons?: CrSeason[]
  private seasonsJob?: Promise<void>
  /** The locale the category and season lists were read in. */
  private listsLocale?: string
  /** History pages by Crunchyroll page while a client pages by titles shown (`skip`): the page that
   *  follows each skip handed out, and the series listed so far. A skip of 0 starts it over. */
  private history?: { next: Map<number, number>; seen: Set<string> }
  constructor(private app: CrunchyrollApp) {}

  private signedIn(): boolean {
    return this.app.auth.status().authenticated
  }

  /** Reads the category list once a run, beside the home feed; the manifest never waits for it.
   *  A failed or empty read is tried again with the next manifest. */
  private loadCategories(): void {
    this.categoriesJob ??= this.app.content.categories().then(
      (list) => { if (list.length) this.categories = list; else this.categoriesJob = undefined },
      () => { this.categoriesJob = undefined },
    )
  }

  /** The simulcast seasons, read the same way: once a run, never waited for. */
  private loadSeasons(): void {
    this.seasonsJob ??= this.app.content.seasons().then(
      (list) => { if (list.length) this.seasons = list; else this.seasonsJob = undefined },
      () => { this.seasonsJob = undefined },
    )
  }

  /** One Crunchyroll page of the history, as the series not listed yet this session, latest first. */
  private async historyPage(skip: number): Promise<StremioMeta[]> {
    if (!skip) this.history = { next: new Map([[0, 1]]), seen: new Set() }
    const session = this.history
    const page = session?.next.get(skip)
    if (!session || !page) return []
    const metas = collect(await this.app.content.history(page, HISTORY_PAGE))
    const fresh = metas.filter((meta) => !session.seen.has(meta.id))
    // A page of series already listed is sent again, since an empty one would end the list; izumi
    // drops titles it already shows and reads on.
    const out = fresh.length ? fresh : metas
    for (const meta of out) session.seen.add(meta.id)
    if (out.length) session.next.set(skip + out.length, page + 1)
    return out
  }

  async manifest(): Promise<Record<string, unknown>> {
    const signedIn = this.signedIn()
    if (signedIn) {
      // Their titles follow the display language: after a switch they are read again.
      const locale = await this.app.content.locale()
      if (locale !== this.listsLocale) {
        this.listsLocale = locale
        this.categoriesJob = this.seasonsJob = undefined
      }
      this.loadCategories()
      this.loadSeasons()
    }
    const feed = signedIn ? await this.app.content.homeRows().catch(() => []) : []
    const categories = this.categories ?? FALLBACK_CATEGORIES
    const images = Object.fromEntries(categories.flatMap((category) => (category.image ? [[category.title, category.image]] : [])))
    // izumi's Categories screen shows a category's artwork behind it (an extra field other clients skip).
    const genre = { name: 'genre', options: categories.map((category) => category.title), ...(Object.keys(images).length ? { izumi: { images } } : {}) }
    const catalogs: CatalogEntry[] = [
      { type: 'series', id: 'cr-hero', name: 'Featured', izumi: { hero: true } },
      ...feed.map((row) => ({
        type: 'series' as const,
        id: row.id,
        name: row.title,
        ...(row.kind === 'history' ? { izumi: { continue: true as const } } : {}),
      })),
      // The categories are for Browse: izumi offers no Home row per category, and A–Z stays off Home.
      ...Object.entries(PAGED).map(([id, row]) => ({ type: 'series' as const, id, name: row.name, extra: [{ name: 'skip' }, genre], izumi: { homeFilters: false, ...(id === 'cr-alphabetical' ? { home: false } : {}) } })),
      // Drawer screens, as Crunchy Deck has them: izumi pages them, and they stay off Home and Browse.
      { type: 'series', id: 'cr-watchlist-all', name: 'Watchlist', extra: [{ name: 'skip' }], izumi: { home: false, browse: false, menu: { label: 'Watchlist', icon: 'bookmark' } } },
      { type: 'series', id: 'cr-history-all', name: 'History', extra: [{ name: 'skip' }], izumi: { home: false, browse: false, menu: { label: 'History', icon: 'history' } } },
      {
        type: 'series',
        id: 'cr-seasons',
        name: 'Simulcasts',
        extra: [{ name: 'skip' }, { name: 'season', options: this.seasons?.slice(0, SEASON_OPTIONS).map((season) => season.title) ?? [seasonTitleOf(new Date())] }],
        izumi: { home: false, browse: false, menu: { label: 'Simulcasts', icon: 'calendar', extra: 'season' } },
      },
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
    const { skip, search, genre, season } = parseExtra(extra)
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
    if (id === 'cr-watchlist-all') return collect(await content.watchlist(skip))
    if (id === 'cr-history-all') return this.historyPage(skip)
    if (id === 'cr-seasons') {
      const seasonalTag = season ? optionId(season, this.seasons ?? await content.seasons().catch(() => [])) : undefined
      return collect(await content.browse({ sort: 'popularity', seasonal: true, seasonalTag, start: skip, n: 24 }))
    }
    const paged = PAGED[id]
    if (paged) {
      const categories = genre ? categoryId(genre, this.categories ?? []) : undefined
      return collect(await content.browse({ sort: paged.sort, seasonal: paged.seasonal, start: skip, n: 24, categories }))
    }
    const row = (await content.homeRows()).find((item) => item.id === id)
    return row ? collect(await content.rowItems(row)) : []
  }

  async meta(id: string, baseUrl: string): Promise<StremioMeta | undefined> {
    const contentId = stripPrefix(id)
    if (!contentId || !this.signedIn()) return undefined
    const content = this.app.content
    // What needs only the id starts at once: the page waits on the slowest call, not on their sum.
    const upNextP = content.upNext(contentId).catch(() => undefined)
    const watchlistP = content.inWatchlist(contentId).catch(() => undefined)
    // A series' seasons need only the id too: asked beside the object rather than after it (one
    // Crunchyroll round trip less). For a film the answer goes unused.
    const localeP = content.locale()
    const seasonsP = localeP.then((locale) => this.app.catalog.seasons(contentId, locale))
    seasonsP.catch(() => {})
    const [object, audio, locale] = await Promise.all([content.object(contentId), content.preferredAudio(), localeP])
    if (!object) return undefined
    const preview = metaPreview(object)
    if (!preview) return undefined
    const videos: StremioVideo[] = []
    const episodes: Array<{ episode: EpisodeItem & { number: number; guid: string }; season?: number }> = []
    let seasonList: Array<{ number: number; title: string }> | undefined
    if (object.type === 'series') {
      const seasons = pickSeasons(await seasonsP, audio)
      const lists = await Promise.all(seasons.map((season) => this.app.catalog.seasonEpisodes(season.id, audio, locale)))
      const numbers = seasonNumbers(seasons)
      // izumi.seasons: [{ number, title }] per season, in Crunchyroll's order. `number` is the
      // `season` its videos carry, `title` Crunchyroll's own name for it ("Season N" when it has none).
      seasonList = seasons.map((season, index) => ({ number: numbers[index]!, title: season.title || `Season ${numbers[index]}` }))
      lists.forEach((list, index) => {
        for (const episode of list) episodes.push({ episode, season: numbers[index] })
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
    // Each episode's AniList and MyAnimeList entry, so izumi can track it (cr/anime-ids.ts).
    if (object.type === 'series' && preview.name) {
      this.trackIds ??= trackIdService()
      const refs = videos.map((video) => ({ key: video.id, season: video.season, number: video.episode, airDate: video.released }))
      const ids = await this.trackIds.get(contentId, preview.name, refs, TRACK_WAIT_MS).catch(() => undefined)
      if (ids) for (const video of videos) {
        const track = ids.get(video.id)
        if (track) video.izumi = { ...video.izumi, track }
      }
    }
    const [upNext, inWatchlist] = await Promise.all([upNextP, watchlistP])
    const next = upNext && !upNext.fullyWatched ? upNext.panel : undefined
    return {
      ...preview,
      videos,
      izumi: {
        ...preview.izumi,
        ...(seasonList ? { seasons: seasonList } : {}),
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

  /** The episode's stream: what the onlinestream `play` call returns, plus where to report progress
   *  and the episode's skip markers (`izumi.skip`, left out when it has none). */
  async stream(id: string, baseUrl: string): Promise<Array<Record<string, unknown>>> {
    const episodeId = stripPrefix(id)
    if (!episodeId || !this.signedIn()) return []
    // A play is coming: the licence server's connection opens while the stream is read.
    this.app.play.warmLicense()
    // The markers are asked beside the play session, so the stream waits on the slower of the two.
    const [server, skip, subtitle] = await Promise.all([
      this.app.episodeServer(episodeId, DEFAULT_LOCALE, baseUrl),
      this.app.content.markers(episodeId),
      this.app.content.preferences().then((prefs) => prefs.subtitleLanguage, () => undefined),
    ])
    return server.videoSources.map((source) => ({
      ...withSubtitle(source, subtitle),
      name: 'Crunchyroll',
      title: 'Crunchyroll',
      behaviorHints: { notWebReady: true, proxyHeaders: { request: server.headers } },
      izumi: {
        onlinestream: true,
        headers: server.headers,
        progressUrl: `${baseUrl}/stremio/progress?video=${encodeURIComponent(id)}`,
        ...(skip.length ? { skip } : {}),
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
