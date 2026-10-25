// Crunchyroll's own catalogue for the signed-in profile: the home feed and its curated hero,
// browse, search, series objects, playheads, up-next and the watchlist. The calls follow
// Crunchy Deck (electron/cr/*.ts), which reads the same endpoints with the same TV client.
import { DEFAULT_LOCALE, HOSTS, type ClientProfile } from './constants.js'
import { crHeaders } from './headers.js'
import { jsonOrThrow, type CrTransport } from './http.js'
import type { Auth } from './auth.js'

/** Image variants: Crunchyroll returns arrays of arrays of sizes. */
export type CrImages = Record<string, Array<Array<{ source?: string; width?: number; height?: number }>> | undefined>

export interface CrPanel {
  id: string
  type?: string
  title?: string
  description?: string
  slug_title?: string
  images?: CrImages
  playhead?: number
  fully_watched?: boolean
  new?: boolean
  series_metadata?: CrSeriesMetadata
  movie_listing_metadata?: CrSeriesMetadata
  movie_metadata?: CrEpisodeMetadata & { movie_listing_id?: string; movie_listing_title?: string }
  episode_metadata?: CrEpisodeMetadata
}

export interface CrSeriesMetadata {
  episode_count?: number
  season_count?: number
  is_dubbed?: boolean
  is_subbed?: boolean
  is_mature?: boolean
  series_launch_year?: number
  tenant_categories?: string[]
  maturity_ratings?: string[]
  extended_maturity_rating?: { rating?: string; system?: string }
  audio_locales?: string[]
}

export interface CrEpisodeMetadata {
  series_id?: string
  series_title?: string
  season_id?: string
  season_number?: number
  episode_number?: number
  episode?: string
  duration_ms?: number
  episode_air_date?: string
  is_premium_only?: boolean
  is_dubbed?: boolean
  is_subbed?: boolean
  maturity_ratings?: string[]
}

export interface FeedRow {
  id: string
  title: string
  kind: string
  link?: string
  ids?: string[]
}

export interface HeroCard {
  contentId: string
  title: string
  description?: string
  wideImage?: string
  tallImage?: string
  logoImage?: string
}

export interface Playhead {
  playhead: number
  fullyWatched: boolean
}

/** The home-feed panels worth a row, as Crunchy Deck keeps them (feed order). */
const ROW_TYPES = new Set([
  'recommendations', 'history', 'watchlist', 'recent_episodes', 'browse', 'series', 'music_video', 'because_you_watched',
])

const CURATION = 'https://imgsrv.crunchyroll.com/cdn-cgi/image/format=auto'

/** A curated (HeroMediaCard) image path at a given width. */
export function curationUrl(path: string | undefined, width: number): string | undefined {
  return path ? `${CURATION},width=${width}${path.startsWith('/') ? '' : '/'}${path}` : undefined
}

/** The smallest variant at least `width` wide (or the largest there is). */
export function pickImage(images: CrImages | undefined, kind: string, width: number): string | undefined {
  const variants = images?.[kind]?.[0]?.filter((v) => v.source) ?? []
  if (!variants.length) return undefined
  const sorted = [...variants].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  return (sorted.find((v) => (v.width ?? 0) >= width) ?? sorted[sorted.length - 1])?.source
}

/** Walks the server-driven /f/v1/home tree for its curated HeroMediaCards, de-duplicated. */
export function heroCards(tree: unknown): HeroCard[] {
  const cards: HeroCard[] = []
  const seen = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const props = record.props as Record<string, unknown> | undefined
    if (record.type === 'HeroMediaCard' && props && typeof props.contentId === 'string') {
      if (!seen.has(props.contentId)) {
        seen.add(props.contentId)
        cards.push({
          contentId: props.contentId,
          title: String(props.title ?? ''),
          description: typeof props.description === 'string' ? props.description : undefined,
          wideImage: typeof props.wideImage === 'string' ? props.wideImage : undefined,
          tallImage: typeof props.tallImage === 'string' ? props.tallImage : undefined,
          logoImage: typeof props.logoImage === 'string' ? props.logoImage : undefined,
        })
      }
    }
    for (const value of Object.values(record)) walk(value)
  }
  walk(tree)
  return cards
}

/** The feed's rows: kept panel types, Continue Watching (history) first, the rest in feed order.
 *  Row ids follow the panel type (`cr-watchlist`, `cr-recommendations-2`) so they stay stable while
 *  the feed reorders. */
export function feedRows(feed: unknown): FeedRow[] {
  const list = ((feed as { data?: unknown[] })?.data ?? []) as Array<Record<string, unknown>>
  const seen = new Map<string, number>()
  const rows: Array<{ order: number; row: FeedRow }> = []
  list.forEach((panel, order) => {
    const kind = panel.response_type
    if (typeof kind !== 'string' || !ROW_TYPES.has(kind) || typeof panel.title !== 'string') return
    const row: FeedRow = { id: '', title: panel.title, kind }
    if (panel.resource_type === 'dynamic_collection' && typeof panel.link === 'string') row.link = panel.link
    else if (Array.isArray(panel.ids)) row.ids = (panel.ids as unknown[]).filter((id): id is string => typeof id === 'string')
    if (!row.link && !row.ids?.length) return
    const n = (seen.get(kind) ?? 0) + 1
    seen.set(kind, n)
    row.id = n === 1 ? `cr-${kind}` : `cr-${kind}-${n}`
    rows.push({ order, row })
  })
  rows.sort((a, b) => (a.row.kind === 'history' ? 0 : 1) - (b.row.kind === 'history' ? 0 : 1) || a.order - b.order)
  return rows.map(({ row }) => row)
}

function apiBase(profile: ClientProfile): string {
  return profile === 'tv' ? HOSTS.api : HOSTS.www
}

export class Content {
  private cache = new Map<string, { at: number; value: unknown }>()

  constructor(
    private transport: CrTransport,
    private auth: Auth,
  ) {}

  private async request<T>(path: string, init: { method?: string; body?: unknown; ttlMs?: number; host?: string } = {}): Promise<T> {
    const profile = this.auth.profile
    const url = path.startsWith('http') ? path : `${init.host ?? apiBase(profile)}${path}`
    const method = init.method ?? 'GET'
    const cached = method === 'GET' && init.ttlMs ? this.cache.get(url) : undefined
    if (cached && Date.now() - cached.at < init.ttlMs!) return cached.value as T
    const token = await this.auth.accessToken()
    const res = await this.transport.request({
      url,
      method,
      headers: crHeaders({
        profile,
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { contentType: 'application/json' } : {}),
      }),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    const value = res.status === 204 || !res.body.length ? (undefined as T) : await jsonOrThrow<T>(res)
    if (method === 'GET' && init.ttlMs) this.cache.set(url, { at: Date.now(), value })
    return value
  }

  private account(): string {
    const id = this.auth.status().accountId
    if (!id) throw new Error('Not signed in to Crunchyroll.')
    return id
  }

  /** Forgets cached lists that change with what the user just did (watching, the watchlist). */
  invalidate(): void {
    this.cache.clear()
  }

  async preferredAudio(): Promise<string> {
    try {
      const profile = await this.request<{ preferred_content_audio_language?: string }>('/accounts/v1/me/profile', { ttlMs: 10 * 60_000 })
      return profile?.preferred_content_audio_language || 'ja-JP'
    } catch {
      return 'ja-JP'
    }
  }

  async homeRows(): Promise<FeedRow[]> {
    const audio = await this.preferredAudio()
    const feed = await this.request(
      `/content/v2/discover/${this.account()}/home_feed?start=0&n=100&preferred_audio_language=${audio}&locale=${DEFAULT_LOCALE}`,
      { ttlMs: 60_000 },
    )
    return feedRows(feed)
  }

  async rowItems(row: FeedRow): Promise<CrPanel[]> {
    const path = row.link ?? `/content/v2/cms/objects/${row.ids!.map(encodeURIComponent).join(',')}?locale=${DEFAULT_LOCALE}`
    const json = await this.request<{ data?: unknown[]; items?: unknown[] }>(path, { ttlMs: 60_000 })
    return panels(json?.data ?? json?.items)
  }

  async hero(): Promise<HeroCard[]> {
    try {
      const tree = await this.request(`${HOSTS.www}/f/v1/home?locale=${DEFAULT_LOCALE}`, { ttlMs: 10 * 60_000 })
      const cards = heroCards(tree)
      if (cards.length) return cards
    } catch {
      // Fall back to the season's popular simulcasts, as Crunchy Deck does.
    }
    const simulcasts = await this.browse({ sort: 'popularity', seasonal: true, n: 12 })
    return simulcasts.map((item) => ({ contentId: item.id, title: item.title ?? '', description: item.description }))
  }

  async browse(opts: { sort?: 'popularity' | 'newly_added' | 'alphabetical'; seasonal?: boolean; start?: number; n?: number; categories?: string }): Promise<CrPanel[]> {
    const params = new URLSearchParams({
      n: String(opts.n ?? 24),
      start: String(opts.start ?? 0),
      sort_by: opts.sort ?? 'popularity',
      type: 'series',
      locale: DEFAULT_LOCALE,
    })
    if (opts.categories) params.set('categories', opts.categories)
    if (opts.seasonal) {
      const tag = await this.currentSeason()
      if (tag) params.set('seasonal_tag', tag)
    }
    const json = await this.request<{ data?: unknown[] }>(`/content/v2/discover/browse?${params}`, { ttlMs: 10 * 60_000 })
    return panels(json?.data)
  }

  async currentSeason(): Promise<string | undefined> {
    const json = await this.request<{ data?: Array<{ id?: string }> }>(`/content/v2/discover/seasonal_tags?locale=${DEFAULT_LOCALE}`, { ttlMs: 60 * 60_000 })
    return json?.data?.[0]?.id
  }

  async search(query: string): Promise<CrPanel[]> {
    if (!query.trim()) return []
    const json = await this.request<{ data?: Array<{ items?: unknown[] }> | unknown[] }>(
      `/content/v2/discover/search?q=${encodeURIComponent(query)}&n=60&start=0&type=series,movie_listing&locale=${DEFAULT_LOCALE}`,
      { ttlMs: 5 * 60_000 },
    )
    const data = json?.data ?? []
    const flat = (data as Array<{ items?: unknown[] }>).flatMap((group) => (group && Array.isArray(group.items) ? group.items : [group]))
    return panels(flat)
  }

  async object(id: string): Promise<CrPanel | undefined> {
    const json = await this.request<{ data?: unknown[] }>(`/content/v2/cms/objects/${encodeURIComponent(id)}?locale=${DEFAULT_LOCALE}`, { ttlMs: 10 * 60_000 })
    return panels(json?.data)[0]
  }

  /** Several catalogue objects in one request, by id. */
  async objects(ids: string[]): Promise<Map<string, CrPanel>> {
    const out = new Map<string, CrPanel>()
    if (!ids.length) return out
    const json = await this.request<{ data?: unknown[] }>(
      `/content/v2/cms/objects/${ids.map(encodeURIComponent).join(',')}?locale=${DEFAULT_LOCALE}`,
      { ttlMs: 10 * 60_000 },
    )
    for (const panel of panels(json?.data)) out.set(panel.id, panel)
    return out
  }

  /** A movie listing's movies (usually one). */
  async movies(listingId: string): Promise<CrPanel[]> {
    const json = await this.request<{ data?: unknown[] }>(
      `/content/v2/cms/movie_listings/${encodeURIComponent(listingId)}/movies?locale=${DEFAULT_LOCALE}`,
      { ttlMs: 10 * 60_000 },
    )
    return panels(json?.data)
  }

  async playheads(contentIds: string[]): Promise<Map<string, Playhead>> {
    const out = new Map<string, Playhead>()
    for (let i = 0; i < contentIds.length; i += 50) {
      const batch = contentIds.slice(i, i + 50)
      const json = await this.request<{ data?: Array<{ content_id?: string; playhead?: number; fully_watched?: boolean }> }>(
        `/content/v2/${this.account()}/playheads?content_ids=${batch.map(encodeURIComponent).join(',')}&locale=${DEFAULT_LOCALE}`,
      )
      for (const item of json?.data ?? []) {
        if (item.content_id) out.set(item.content_id, { playhead: Number(item.playhead) || 0, fullyWatched: !!item.fully_watched })
      }
    }
    return out
  }

  /** Where to resume a series (or what follows an episode): the episode, its playhead, whether it's done. */
  async upNext(id: string): Promise<{ panel: CrPanel; playhead: number; fullyWatched: boolean } | undefined> {
    const json = await this.request<{ data?: Array<{ panel?: unknown; playhead?: number; fully_watched?: boolean }> }>(
      `/content/v2/discover/up_next/${encodeURIComponent(id)}?locale=${DEFAULT_LOCALE}`,
    )
    const first = json?.data?.[0]
    const panel = first?.panel ? panels([first.panel])[0] : undefined
    return panel ? { panel, playhead: Number(first?.playhead) || 0, fullyWatched: !!first?.fully_watched } : undefined
  }

  async setPlayhead(contentId: string, seconds: number): Promise<void> {
    if (!contentId || !(seconds >= 0)) return
    await this.request(`/content/v2/${this.account()}/playheads?locale=${DEFAULT_LOCALE}`, {
      method: 'POST',
      body: { content_id: contentId, playhead: Math.floor(seconds) },
    })
    this.invalidate()
  }

  async inWatchlist(contentId: string): Promise<boolean> {
    const json = await this.request<{ data?: unknown[] }>(`/content/v2/${this.account()}/watchlist?content_ids=${encodeURIComponent(contentId)}&locale=${DEFAULT_LOCALE}`)
    return (json?.data?.length ?? 0) > 0
  }

  async setWatchlist(contentId: string, on: boolean): Promise<void> {
    const account = this.account()
    if (on) {
      await this.request(`/content/v2/${account}/watchlist?locale=${DEFAULT_LOCALE}`, { method: 'POST', body: { content_id: contentId } })
    } else {
      await this.request(`/content/v2/${account}/watchlist/${encodeURIComponent(contentId)}?locale=${DEFAULT_LOCALE}`, { method: 'DELETE' })
    }
    this.invalidate()
  }

  async watchlist(): Promise<CrPanel[]> {
    const json = await this.request<{ data?: unknown[] }>(
      `/content/v2/discover/${this.account()}/watchlist?order=desc&n=100&start=0&sort_by=date_added&locale=${DEFAULT_LOCALE}`,
      { ttlMs: 60_000 },
    )
    return panels(json?.data)
  }
}

/** Feed, watchlist and history rows wrap their content in `.panel` and carry the playhead beside it. */
export function panels(list: unknown): CrPanel[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const outer = raw as Record<string, unknown>
    const inner = (outer.panel && typeof outer.panel === 'object' ? outer.panel : outer) as Record<string, unknown>
    if (typeof inner.id !== 'string') return []
    return [{
      ...(inner as unknown as CrPanel),
      ...(typeof outer.playhead === 'number' ? { playhead: outer.playhead } : {}),
      ...(typeof outer.fully_watched === 'boolean' ? { fully_watched: outer.fully_watched } : {}),
      ...(outer.new === true ? { new: true } : {}),
    }]
  })
}
