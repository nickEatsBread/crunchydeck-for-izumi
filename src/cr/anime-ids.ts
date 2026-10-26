// Crunchyroll episodes → AniList and MyAnimeList entries, so izumi can track them on the viewer's
// lists. Crunchyroll's seasons don't follow AniList's: one Crunchyroll season can hold two cours that
// AniList keeps apart (or the reverse), season numbers skip, and dubs, recaps and films sit between.
// What both agree on is when each episode first aired. So the franchise's AniList entries are
// collected along their sequel and prequel links, and each episode goes to the entry that was airing
// on its air date: by AniList's own airing schedule where it has one, else by its place in the run.
import { normalizeTitle, titleWords } from './match.js'

export interface CrEpisodeRef {
  /** The video's id in the Stremio meta. */
  key: string
  season?: number
  number?: number
  airDate?: string
}

export interface TrackIds {
  anilist: number
  mal?: number
  /** The episode's number on that entry. */
  episode: number
}

export interface AniEntry {
  id: number
  idMal?: number | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  start?: number
  end?: number
  titles: string[]
  schedule: Array<{ episode: number; at: number }>
  related: number[]
  /** Sequels and prequels only: the franchise's main run. */
  sequels?: number[]
  /** Reached from the series by sequels and prequels alone (not through a side story). */
  chain?: boolean
}

const DAY = 86_400_000
const WINDOW_SLACK = 3 * DAY
const SCHEDULE_SLACK = 2 * DAY
/** Episodes run weekly; an entry with no end date ends this long after its last episode would. */
const WEEK = 7 * DAY
const SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA'])
/** Aired one-offs (a final chapter, a TV special): used only where no series entry was airing. */
const ONE_OFF_FORMATS = new Set(['SPECIAL', 'OVA'])

const dateOf = (date: { year?: number | null; month?: number | null; day?: number | null } | null | undefined): number | undefined =>
  date?.year ? Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1) : undefined

const airTime = (value: string | undefined): number | undefined => {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : undefined
}

/** When an entry stops taking episodes: its end date, else (still airing) never, else a run's length. */
function windowEnd(entry: AniEntry): number {
  if (entry.end) return entry.end
  if (entry.status === 'RELEASING' || entry.status === 'NOT_YET_RELEASED' || entry.status === 'HIATUS') return Infinity
  return (entry.start ?? 0) + Math.max(0, (entry.episodes ?? 13) - 1) * WEEK + 2 * WEEK
}

function covers(entry: AniEntry, time: number): boolean {
  return entry.start !== undefined && time >= entry.start - WINDOW_SLACK && time <= windowEnd(entry) + WINDOW_SLACK
}

function scheduled(entry: AniEntry, time: number): number | undefined {
  let best: { episode: number; gap: number } | undefined
  for (const node of entry.schedule) {
    const gap = Math.abs(node.at - time)
    if (gap <= SCHEDULE_SLACK && (!best || gap < best.gap)) best = { episode: node.episode, gap }
  }
  return best?.episode
}

/** Each episode with an air date on the entry airing then. Pure: the entries come from AniList. */
export function assignEpisodes(entries: AniEntry[], episodes: CrEpisodeRef[]): Map<string, TrackIds> {
  const byStart = (a: AniEntry, b: AniEntry) => (a.start ?? 0) - (b.start ?? 0)
  const series = entries.filter((entry) => SERIES_FORMATS.has(entry.format ?? '') && entry.start !== undefined).sort(byStart)
  const oneOffs = entries.filter((entry) => ONE_OFF_FORMATS.has(entry.format ?? '') && entry.start !== undefined && entry.end !== undefined).sort(byStart)
  const groups = new Map<AniEntry, Array<{ ref: CrEpisodeRef; time: number; exact?: number }>>()
  const batched = uploadBatches(episodes)
  for (const ref of episodes) {
    const time = batched.has(ref.season) ? undefined : airTime(ref.airDate)
    if (time === undefined) continue
    let candidates = series.filter((entry) => covers(entry, time))
    // The main run wins over a side story airing alongside it (a short ONA, a spin-off).
    if (candidates.some((entry) => entry.chain)) candidates = candidates.filter((entry) => entry.chain)
    if (!candidates.length) candidates = oneOffs.filter((entry) => covers(entry, time))
    if (!candidates.length) continue
    // Two entries can overlap (a split cour announced as one): the one whose schedule has this
    // episode wins, else the one that started last before it.
    const exact = candidates.map((entry) => ({ entry, episode: scheduled(entry, time) })).find((hit) => hit.episode !== undefined)
    const entry = exact?.entry ?? candidates.filter((c) => (c.start ?? 0) <= time + WINDOW_SLACK).at(-1) ?? candidates[0]
    if (!entry) continue
    const group = groups.get(entry) ?? []
    group.push({ ref, time, exact: exact?.episode })
    groups.set(entry, group)
  }
  const result = new Map<string, TrackIds>()
  for (const [entry, group] of groups) {
    // In airing order; Crunchyroll's own number breaks a tie (two episodes on one day).
    group.sort((a, b) => a.time - b.time || (a.ref.number ?? 0) - (b.ref.number ?? 0))
    // A complete AniList schedule that gives every one of these episodes its own slot is the
    // entry's numbering as AniList and MyAnimeList count it (an episode 0 counted as 1, say).
    const complete = !!entry.episodes && entry.schedule.length === entry.episodes
    if (complete && group.every((item) => item.exact !== undefined) && new Set(group.map((item) => item.exact)).size === group.length) {
      for (const item of group) result.set(item.ref.key, { anilist: entry.id, ...(entry.idMal ? { mal: entry.idMal } : {}), episode: item.exact! })
      continue
    }
    // The same episode listed twice (a recap season repeating it): the copy in the season with
    // more of this entry's episodes is the one.
    const perSeason = new Map<number | undefined, number>()
    for (const item of group) perSeason.set(item.ref.season, (perSeason.get(item.ref.season) ?? 0) + 1)
    const copies = new Map<string, (typeof group)[number]>()
    for (const item of group) {
      const id = `${item.time}:${item.ref.number}`
      const held = copies.get(id)
      if (!held || (perSeason.get(item.ref.season) ?? 0) > (perSeason.get(held.ref.season) ?? 0)) copies.set(id, item)
    }
    const kept = new Set(copies.values())
    // Crunchyroll can split one long AniList entry into seasons that each count from 1: number them
    // on from the seasons before (by when they aired), as AniList does.
    const numberOf = new Map<(typeof group)[number], number>()
    const seasonsHere = [...perSeason].filter(([, count]) => count >= 3).map(([season]) => season)
    const starts = (season: number | undefined) => group.filter((item) => item.ref.season === season)
    const resets = seasonsHere.length >= 2 && seasonsHere.every((season) => Math.min(...starts(season).map((item) => item.ref.number ?? Infinity)) <= 1)
    let base = 0
    const ordered = resets ? [...seasonsHere].sort((a, b) => Math.min(...starts(a).map((i) => i.time)) - Math.min(...starts(b).map((i) => i.time))) : []
    const baseOf = new Map<number | undefined, number>()
    for (const season of ordered) { baseOf.set(season, base); base += perSeason.get(season) ?? 0 }
    for (const item of group) if (item.ref.number !== undefined) numberOf.set(item, (baseOf.get(item.ref.season) ?? 0) + item.ref.number)
    // The entry's run is the longest stretch whose numbers rise with the air dates. What falls out
    // of it is not one of its episodes: a recap numbered like the episode before it, a special
    // numbered 1, a remaster of old episodes dated years later.
    const run = new Set(risingRun(group.filter((item) => kept.has(item) && item.ref.number !== undefined && item.ref.number > 0), (item) => numberOf.get(item) ?? 0, (item) => perSeason.get(item.ref.season) ?? 0))
    // Crunchyroll numbers this entry's episodes either from 1 or on from earlier seasons (absolute):
    // shift them so the entry's first one is its episode 1.
    const offset = run.size ? Math.min(...[...run].map((item) => numberOf.get(item) ?? 0)) - 1 : 0
    const taken = new Set<number>()
    for (const item of group) {
      // Crunchyroll's numbering where it runs true; AniList's schedule (which can skip or double an
      // episode) only places an episode that has none, or which the run left out.
      const episode = run.has(item) ? (numberOf.get(item) ?? 0) - offset : item.exact
      if (episode === undefined || episode < 1 || (entry.episodes && episode > entry.episodes) || taken.has(episode)) continue
      taken.add(episode)
      result.set(item.ref.key, { anilist: entry.id, ...(entry.idMal ? { mal: entry.idMal } : {}), episode })
    }
  }
  placeByCount(series, episodes, result)
  return result
}

/** Seasons whose episodes Crunchyroll dated by upload, all on a day or two: their dates say
 *  nothing about when each aired. */
function uploadBatches(episodes: CrEpisodeRef[]): Set<number | undefined> {
  const dates = new Map<number | undefined, { count: number; days: Set<string> }>()
  for (const ref of episodes) {
    const day = ref.airDate?.slice(0, 10)
    if (!day) continue
    const season = dates.get(ref.season) ?? { count: 0, days: new Set<string>() }
    season.count++
    season.days.add(day)
    dates.set(ref.season, season)
  }
  return new Set([...dates].filter(([, { count, days }]) => count >= 4 && days.size * 3 <= count).map(([season]) => season))
}

/** Seasons the dates placed nowhere (Crunchyroll listing an upload date years after the broadcast):
 *  an entry no other season took, with that many episodes, where the season numbers put it. */
function placeByCount(series: AniEntry[], episodes: CrEpisodeRef[], result: Map<string, TrackIds>): void {
  const bySeason = new Map<number, CrEpisodeRef[]>()
  for (const ref of episodes) if (ref.season !== undefined) bySeason.set(ref.season, [...(bySeason.get(ref.season) ?? []), ref])
  const used = new Set([...result.values()].map((track) => track.anilist))
  const startOf = new Map(series.map((entry) => [entry.id, entry.start ?? 0]))
  const seasonStarts = (season: number) => (bySeason.get(season) ?? [])
    .map((ref) => result.get(ref.key)?.anilist).filter((id): id is number => id !== undefined).map((id) => startOf.get(id) ?? 0)
  const numbers = [...bySeason.keys()].sort((a, b) => a - b)
  for (const season of numbers) {
    const refs = bySeason.get(season) ?? []
    const numbered = refs.filter((ref) => ref.number !== undefined && ref.number > 0)
    const placed = refs.filter((ref) => result.has(ref.key)).length
    if (numbered.length < 3 || placed > refs.length * 0.3) continue
    const distinct = new Set(numbered.map((ref) => ref.number)).size
    const after = Math.max(-Infinity, ...numbers.filter((n) => n < season).flatMap(seasonStarts))
    const before = Math.min(Infinity, ...numbers.filter((n) => n > season).flatMap(seasonStarts))
    const entry = series.find((candidate) => !used.has(candidate.id) && !!candidate.episodes
      && Math.abs(candidate.episodes - distinct) <= 1 && (candidate.start ?? 0) > after && (candidate.start ?? 0) < before)
    if (!entry) continue
    used.add(entry.id)
    const first = Math.min(...numbered.map((ref) => ref.number!))
    const taken = new Set<number>()
    for (const ref of numbered) {
      const episode = ref.number! - first + 1
      if (result.has(ref.key) || episode > (entry.episodes ?? Infinity) || taken.has(episode)) continue
      taken.add(episode)
      result.set(ref.key, { anilist: entry.id, ...(entry.idMal ? { mal: entry.idMal } : {}), episode })
    }
  }
}

/** The longest subsequence (in the given order) whose episode numbers strictly rise. Of two equal
 *  numbers the one from the bigger season stays (a stray copy in a special season), else the first
 *  (a recap listed after the episode it repeats). */
function risingRun<T>(items: T[], numberOf: (item: T) => number, weight: (item: T) => number): T[] {
  const numbers = items.map(numberOf)
  const tails: number[] = []
  const previous: number[] = new Array(items.length).fill(-1)
  numbers.forEach((value, index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((numbers[tails[mid] ?? 0] ?? 0) < value) low = mid + 1
      else high = mid
    }
    const held = tails[low]
    if (held !== undefined && numbers[held] === value && weight(items[index]!) <= weight(items[held]!)) return
    if (low > 0) previous[index] = tails[low - 1] ?? -1
    tails[low] = index
  })
  const run: T[] = []
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index] ?? -1) {
    const item = items[index]
    if (item) run.unshift(item)
  }
  return run
}

/** How well a candidate's titles name the series (0..1): shared meaningful words. */
export function titleScore(series: string, titles: string[]): number {
  const wanted = new Set(titleWords(series))
  if (!wanted.size) return 0
  let best = 0
  for (const title of titles) {
    if (normalizeTitle(title) === normalizeTitle(series)) return 1
    const words = new Set(titleWords(title))
    if (!words.size) continue
    let shared = 0
    for (const word of wanted) if (words.has(word)) shared++
    best = Math.max(best, shared / Math.max(wanted.size, words.size))
  }
  return best
}

// ---- AniList ---------------------------------------------------------------------------------

const ANILIST = 'https://graphql.anilist.co'
const FIELDS = `id idMal format status episodes
  startDate { year month day } endDate { year month day }
  title { romaji english native } synonyms
  airingSchedule(perPage: 50) { nodes { episode airingAt } }
  relations { edges { relationType node { id } } }`

interface RawMedia {
  id: number
  idMal?: number | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
  synonyms?: string[] | null
  airingSchedule?: { nodes?: Array<{ episode: number; airingAt: number }> | null } | null
  relations?: { edges?: Array<{ relationType?: string | null; node?: { id: number } | null }> | null } | null
}

export type GraphQl = (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>

export const anilistGraphQl = (fetchImpl: typeof fetch = fetch): GraphQl => async (query, variables) => {
  const res = await fetchImpl(ANILIST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`AniList answered ${res.status}`)
  const body = await res.json() as { data?: Record<string, unknown> }
  return body.data
}

function entryOf(media: RawMedia): AniEntry {
  return {
    id: media.id,
    idMal: media.idMal,
    format: media.format,
    status: media.status,
    episodes: media.episodes,
    start: dateOf(media.startDate),
    end: dateOf(media.endDate),
    titles: [media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms ?? [])].filter((t): t is string => !!t),
    schedule: (media.airingSchedule?.nodes ?? []).map((node) => ({ episode: node.episode, at: node.airingAt * 1000 })),
    sequels: (media.relations?.edges ?? [])
      .filter((edge) => edge.relationType === 'SEQUEL' || edge.relationType === 'PREQUEL')
      .map((edge) => edge.node?.id)
      .filter((id): id is number => typeof id === 'number'),
    related: (media.relations?.edges ?? [])
      // Sequels and prequels; side stories and alternative versions too (a second series told
      // alongside, an alternate-timeline season): the air dates still decide what each episode is.
      .filter((edge) => FOLLOWED_RELATIONS.has(edge.relationType ?? ''))
      .map((edge) => edge.node?.id)
      .filter((id): id is number => typeof id === 'number'),
  }
}

const MAX_ENTRIES = 60
const FOLLOWED_RELATIONS = new Set(['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'ALTERNATIVE'])
/** A name match airing within this of the series' first episode is the series, over a closer name. */
const ROOT_NEAR = 400 * DAY

/** The series' AniList franchise: the best-named entry that aired around its first episode, then
 *  everything reachable from it by sequel and prequel links. */
export async function franchiseEntries(graphql: GraphQl, series: string, firstAir?: number): Promise<AniEntry[]> {
  const search = await graphql(`query ($search: String) { Page(perPage: 10) { media(search: $search, type: ANIME) { ${FIELDS} } } }`, { search: series })
  const found = ((search?.Page as { media?: RawMedia[] } | undefined)?.media ?? []).map(entryOf)
  const ranked = found
    .map((entry) => ({ entry, score: titleScore(series, entry.titles) }))
    // More than half its words: two-word titles sharing one ("Black Clover", "Black Bullet") differ.
    .filter((hit) => hit.score >= 0.5)
    // A remake shares the name: the one airing nearest the series' first episode is the series.
    .sort((a, b) => b.score - a.score || distance(a.entry, firstAir) - distance(b.entry, firstAir))
  // A franchise's later entries share its name ("Code Geass: Rozé of the Recapture" for a series
  // that began in 2006): of the names that match, the one that aired when the series began.
  const near = ranked.find((hit) => distance(hit.entry, firstAir) <= ROOT_NEAR)
  const root = near?.entry ?? ranked[0]?.entry
  if (!root) return []
  const entries = new Map<number, AniEntry>([[root.id, root]])
  let frontier = root.related.filter((id) => !entries.has(id))
  while (frontier.length && entries.size < MAX_ENTRIES) {
    const page = await graphql(`query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${FIELDS} } } }`, { ids: frontier })
    const media = ((page?.Page as { media?: RawMedia[] } | undefined)?.media ?? []).map(entryOf)
    const next = new Set<number>()
    for (const entry of media) {
      entries.set(entry.id, entry)
      for (const id of entry.related) if (!entries.has(id)) next.add(id)
    }
    frontier = [...next].filter((id) => !entries.has(id))
  }
  // The main run: what sequel and prequel links alone reach from the series.
  const chain = [root.id]
  for (let i = 0; i < chain.length; i++) {
    const entry = entries.get(chain[i]!)
    if (entry) entry.chain = true
    for (const id of entry?.sequels ?? []) if (entries.has(id) && !chain.includes(id)) chain.push(id)
  }
  return [...entries.values()]
}

const distance = (entry: AniEntry, time: number | undefined) =>
  time === undefined || entry.start === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(entry.start - time)

/** Track ids for every episode of a series that AniList can place. */
export async function resolveTrackIds(graphql: GraphQl, series: string, episodes: CrEpisodeRef[]): Promise<Map<string, TrackIds>> {
  const times = episodes.map((ref) => airTime(ref.airDate)).filter((t): t is number => t !== undefined)
  const firstAir = times.length ? Math.min(...times) : undefined
  const entries = await franchiseEntries(graphql, series, firstAir)
  return entries.length ? assignEpisodes(entries, episodes) : new Map()
}

// ---- Service: AniList asked once per series, the answer kept on disk -------------------------

const REFRESH_MS = 7 * DAY
const REQUEST_GAP_MS = 700

/** AniList allows a few dozen requests a minute: one at a time, spaced, and a 429 waits as told. */
export function politeGraphQl(graphql: GraphQl, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): GraphQl {
  let queue: Promise<unknown> = Promise.resolve()
  let last = 0
  return (query, variables) => {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = last + REQUEST_GAP_MS - Date.now()
        if (wait > 0) await sleep(wait)
        last = Date.now()
        try {
          return await graphql(query, variables)
        } catch (error) {
          const limited = error instanceof Error && /\b429\b/.test(error.message)
          if (!limited || attempt >= 2) throw error
          await sleep(61_000)
        }
      }
    })
    queue = run.catch(() => undefined)
    return run
  }
}

interface Stored { size: number; at: number; ids: Record<string, [number, number | null, number]> }

export class TrackIdService {
  private stored: Record<string, Stored>
  private pending = new Map<string, Promise<Map<string, TrackIds>>>()

  constructor(private graphql: GraphQl, private load: () => Record<string, Stored> = () => ({}), private save: (all: Record<string, Stored>) => void = () => {}) {
    try { this.stored = this.load() } catch { this.stored = {} }
  }

  private known(seriesId: string, size: number): Map<string, TrackIds> | undefined {
    const hit = this.stored[seriesId]
    if (!hit || hit.size !== size || Date.now() - hit.at > REFRESH_MS) return undefined
    return new Map(Object.entries(hit.ids).map(([key, [anilist, mal, episode]]) => [key, { anilist, ...(mal ? { mal } : {}), episode }]))
  }

  /** The series' track ids: at once when known, else resolved in the background and waited for up
   *  to `waitMs` (a meta should not wait on AniList long; the next one has them). */
  async get(seriesId: string, series: string, episodes: CrEpisodeRef[], waitMs: number): Promise<Map<string, TrackIds> | undefined> {
    const known = this.known(seriesId, episodes.length)
    if (known) return known
    let job = this.pending.get(seriesId)
    if (!job) {
      job = resolveTrackIds(this.graphql, series, episodes).then((ids) => {
        this.stored[seriesId] = {
          size: episodes.length,
          at: Date.now(),
          ids: Object.fromEntries([...ids].map(([key, t]) => [key, [t.anilist, t.mal ?? null, t.episode]])),
        }
        try { this.save(this.stored) } catch { /* the in-memory answer still serves */ }
        return ids
      }).finally(() => this.pending.delete(seriesId))
      this.pending.set(seriesId, job)
      job.catch(() => undefined)
    }
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs))
    return Promise.race([job.catch(() => undefined), timeout])
  }
}
