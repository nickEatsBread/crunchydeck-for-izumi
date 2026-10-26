// Scratch evaluation: how Crunchyroll episodes land on AniList entries (see src/cr/anime-ids.ts).
// tsx scripts/eval-anime-ids.ts <crdata.json> — crdata from the Stremio meta of each series.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { anilistGraphQl, franchiseEntries, assignEpisodes, type CrEpisodeRef } from '../src/cr/anime-ids.js'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Array<{ query: string; name?: string; videos?: Array<{ season?: number; episode?: number; released?: string; title?: string }> }>
const base = anilistGraphQl()
// AniList answers cached on disk (ANILIST_CACHE), so a rerun asks only what changed.
const cacheFile = process.env.ANILIST_CACHE
const cache: Record<string, unknown> = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
let last = 0
const graphql: typeof base = async (q, v) => {
  const id = JSON.stringify([q, v])
  if (id in cache) return cache[id] as Record<string, unknown>
  const answer = await live(q, v)
  cache[id] = answer
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(cache))
  return answer
}
const live: typeof base = async (q, v) => {
  const wait = last + 800 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  last = Date.now()
  for (let attempt = 0; ; attempt++) {
    try { return await base(q, v) } catch (e) {
      if (attempt > 3) throw e
      await new Promise((r) => setTimeout(r, 61_000))
    }
  }
}
const only = process.argv[3]
// MyAnimeList ids each Crunchyroll season's episodes should land on, in airing order.
const EXPECTED: Record<string, Record<number, number[]>> = {
  'Frieren': { 1: [52991], 2: [59978] },
  'Solo Leveling': { 1: [52299], 3: [58567] },
  'Jujutsu Kaisen': { 1: [40748], 2: [51009], 5: [57658] },
  'Chainsaw Man': { 1: [44511] },
  'SPY x FAMILY': { 1: [50265, 50602], 2: [53887], 3: [59027] },
  'Mushoku Tensei': { 1: [39535, 45576, 50360], 2: [51179, 55888] },
  'Attack on Titan': { 1: [16498], 2: [25777], 3: [35760, 38524] },
  'Demon Slayer': { 1: [38000], 4: [49926], 5: [47778], 6: [51019], 7: [55701] },
  'Re:ZERO': { 3: [39587, 42203], 4: [54857] },
  'Dr. STONE': { 1: [38691], 2: [40852], 4: [48549, 55644], 5: [57592, 61322, 62568] },
  'Kaguya-sama': { 1: [37999], 2: [40591], 3: [43608] },
  'My Hero Academia': { 1: [31964], 2: [33486], 3: [36456], 4: [42603, 38408], 5: [41587], 6: [56685, 49918], 8: [54789] },
  'Overlord': { 1: [29803], 2: [35073], 3: [37675], 4: [48895] },
  'That Time I Got Reincarnated as a Slime': { 1: [37430], 2: [39551, 41487], 3: [53580] },
  'One Piece': { 1: [21], 4: [21], 27: [21] },
  'DAN DA DAN': { 1: [57334], 2: [60543] },
  'Oshi no Ko': { 1: [52034], 2: [55791] },
  'The Apothecary Diaries': { 1: [54492], 2: [58514] },
  'BLUE LOCK': { 1: [49596], 3: [54865] },
  'Vinland Saga': { 1: [37521], 2: [49387] },
  'Fire Force': { 1: [38671], 2: [40956], 3: [51818, 59229] },
  'Black Clover': { 1: [34572], 4: [34572] },
  'Hells Paradise': { 1: [46569], 2: [55825] },
  'Mob Psycho 100': { 1: [32182], 2: [37510], 3: [50172] },
  'Tower of God': { 1: [40221], 2: [52635] },
  'Bocchi the Rock': { 1: [47917] },
  'Sword Art Online': { 1: [11757], 3: [21881], 4: [36474], 5: [39597, 40540] },
}
let checked = 0
const wrong: string[] = []
for (const show of data) {
  if (!show.videos?.length || !show.name) continue
  if (only && !show.query.toLowerCase().includes(only.toLowerCase())) continue
  const refs: CrEpisodeRef[] = show.videos.map((v, i) => ({ key: String(i), season: v.season, number: v.episode, airDate: v.released }))
  const times = refs.map((r) => Date.parse(r.airDate ?? '')).filter(Number.isFinite)
  const entries = await franchiseEntries(graphql, show.name, times.length ? Math.min(...times) : undefined)
  const map = assignEpisodes(entries, refs)
  const byId = new Map(entries.map((e) => [e.id, e]))
  console.log(`\n# ${show.name}  (${entries.length} AniList entries)`)
  const seasons = new Map<number | undefined, CrEpisodeRef[]>()
  for (const r of refs) seasons.set(r.season, [...(seasons.get(r.season) ?? []), r])
  for (const [season, list] of seasons) {
    const parts = new Map<number, number[]>()
    let missing = 0
    for (const r of list) {
      const t = map.get(r.key)
      if (!t) { missing++; continue }
      parts.set(t.anilist, [...(parts.get(t.anilist) ?? []), t.episode])
    }
    const desc = [...parts].map(([id, eps]) => {
      const e = byId.get(id)
      return `AL${id}/MAL${e?.idMal ?? '-'} "${(e?.titles[0] ?? '').slice(0, 34)}" e${Math.min(...eps)}-${Math.max(...eps)} (${eps.length})`
    }).join(' | ')
    const want = EXPECTED[show.query]?.[season ?? -1]
    if (want) {
      checked++
      const got = [...parts.keys()].map((id) => byId.get(id)?.idMal)
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${show.query} S${season}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
    }
    console.log(`  CR S${season} ${list.length} eps (${(list[0].airDate ?? '').slice(0, 10)}): ${desc || '—'}${missing ? `  unmapped ${missing}` : ''}`)
  }
}
console.log(`
${checked - wrong.length}/${checked} seasons on the expected MyAnimeList entries`)
for (const line of wrong) console.log(`  WRONG ${line}`)
