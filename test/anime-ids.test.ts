import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assignEpisodes, titleScore, type AniEntry, type CrEpisodeRef } from '../src/cr/anime-ids.js'

const DAY = 86_400_000
const at = (date: string) => Date.parse(`${date}T00:00:00Z`)
const iso = (time: number) => new Date(time).toISOString()
function entry(id: number, start: string, episodes: number, extra: Partial<AniEntry> = {}): AniEntry {
  const begin = at(start)
  return { id, idMal: id + 1000, format: 'TV', status: 'FINISHED', episodes, start: begin, end: begin + (episodes - 1) * 7 * DAY, titles: [], schedule: [], related: [], chain: true, ...extra }
}
/** Weekly episodes from `start`, numbered from `from`, in CR season `season`. */
function weekly(prefix: string, season: number, start: string, count: number, from = 1): CrEpisodeRef[] {
  return Array.from({ length: count }, (_, i) => ({ key: `${prefix}${i}`, season, number: from + i, airDate: iso(at(start) + i * 7 * DAY) }))
}
const tracked = (ids: Map<string, { anilist: number; episode: number }>, key: string) => {
  const t = ids.get(key)
  return t ? `${t.anilist}:${t.episode}` : undefined
}

describe('Crunchyroll episodes on AniList entries', () => {
  it('splits one Crunchyroll season over the two cours AniList keeps apart', () => {
    const cour1 = entry(1, '2022-04-09', 12)
    const cour2 = entry(2, '2022-10-01', 13)
    const eps = [...weekly('a', 1, '2022-04-09', 12), ...weekly('b', 1, '2022-10-01', 13, 13)]
    const ids = assignEpisodes([cour1, cour2], eps)
    assert.equal(tracked(ids, 'a0'), '1:1')
    assert.equal(tracked(ids, 'a11'), '1:12')
    assert.equal(tracked(ids, 'b0'), '2:1')
    assert.equal(tracked(ids, 'b12'), '2:13')
    assert.equal(ids.get('b0')?.mal, 1002)
  })

  it('follows a skipped Crunchyroll season number to the right entry by date', () => {
    const s1 = entry(1, '2024-01-06', 12)
    const s2 = entry(2, '2025-01-04', 13)
    const ids = assignEpisodes([s1, s2], [...weekly('a', 1, '2024-01-06', 12), ...weekly('c', 3, '2025-01-04', 13)])
    assert.equal(tracked(ids, 'c0'), '2:1')
    assert.equal(tracked(ids, 'c12'), '2:13')
  })

  it('keeps absolute numbering on a long-running entry and leaves out a remaster dated years later', () => {
    const long = entry(21, '1999-10-20', 0, { episodes: null, status: 'RELEASING', end: undefined })
    const eps = [...weekly('a', 1, '1999-10-20', 61), ...weekly('b', 4, '2001-03-14', 82, 62), ...weekly('r', 20, '2024-11-02', 21)]
    const ids = assignEpisodes([long], eps)
    assert.equal(tracked(ids, 'b0'), '21:62')
    assert.equal(tracked(ids, 'b81'), '21:143')
    assert.equal(tracked(ids, 'r0'), undefined)
  })

  it('leaves out a recap numbered like the episode before it', () => {
    // The recap week pushed the last episode back a week, as AniList's end date records.
    const s1 = entry(1, '2024-01-06', 12, { end: at('2024-01-06') + 12 * 7 * DAY })
    const eps = weekly('a', 1, '2024-01-06', 13)
    eps.forEach((ep, i) => { ep.number = i < 7 ? i + 1 : i })
    const ids = assignEpisodes([s1], eps)
    assert.equal(tracked(ids, 'a6'), '1:7')
    assert.equal(tracked(ids, 'a7'), undefined)
    assert.equal(tracked(ids, 'a8'), '1:8')
    assert.equal(tracked(ids, 'a12'), '1:12')
  })

  it('counts an episode 0 as AniList does when its schedule gives every episode a slot', () => {
    const start = at('2023-07-02')
    const s2 = entry(2, '2023-07-02', 13, { schedule: Array.from({ length: 13 }, (_, i) => ({ episode: i + 1, at: start + i * 7 * DAY + 15 * 3_600_000 })) })
    const eps = weekly('a', 2, '2023-07-03', 13, 0)
    const ids = assignEpisodes([s2], eps)
    assert.equal(tracked(ids, 'a0'), '2:1')
    assert.equal(tracked(ids, 'a12'), '2:13')
  })

  it('keeps Crunchyroll numbering where AniList\'s schedule is missing an episode', () => {
    const start = at('2019-04-06')
    const s1 = entry(1, '2019-04-06', 26, { schedule: Array.from({ length: 25 }, (_, i) => ({ episode: i + 1, at: start + (i < 24 ? i : i + 1) * 7 * DAY })) })
    const ids = assignEpisodes([s1], weekly('a', 1, '2019-04-06', 26))
    assert.equal(tracked(ids, 'a24'), '1:25')
    assert.equal(tracked(ids, 'a25'), '1:26')
  })

  it('keeps the copy in the main season when a special season repeats an episode', () => {
    const s1 = entry(1, '2019-07-05', 24)
    const main = weekly('a', 1, '2019-07-05', 24)
    const repeat: CrEpisodeRef = { key: 'x', season: 6, number: 12, airDate: main[11]!.airDate }
    const ids = assignEpisodes([s1], [...main, repeat])
    assert.equal(tracked(ids, 'a11'), '1:12')
    assert.equal(tracked(ids, 'x'), undefined)
  })

  it('names a series by its shared words, not by a single common one', () => {
    assert.equal(titleScore('Frieren: Beyond Journey\'s End', ['Frieren: Beyond Journey’s End']), 1)
    assert.ok(titleScore('Black Clover', ['Black Bullet']) <= 0.5)
  })

  it('numbers on across Crunchyroll seasons that each count from 1 within one long AniList entry', () => {
    const long = entry(918, '2006-04-04', 99, { end: at('2008-03-27') })
    const ids = assignEpisodes([long], [...weekly('a', 1, '2006-04-04', 49), ...weekly('b', 2, '2007-04-05', 50)])
    assert.equal(tracked(ids, 'a48'), '918:49')
    assert.equal(tracked(ids, 'b0'), '918:50')
    assert.equal(tracked(ids, 'b49'), '918:99')
  })

  it('places a season whose Crunchyroll dates are upload dates by its episode count and order', () => {
    const s1 = entry(1, '2019-01-09', 12)
    const s2 = entry(2, '2021-01-08', 11)
    const late = weekly('b', 2, '2022-03-01', 11).map((ep) => ({ ...ep, airDate: iso(at('2022-03-01')) }))
    const ids = assignEpisodes([s1, s2], [...weekly('a', 1, '2019-01-09', 12), ...late])
    assert.equal(tracked(ids, 'b0'), '2:1')
    assert.equal(tracked(ids, 'b10'), '2:11')
  })

  it('keeps the main run over a side story airing in the same weeks', () => {
    const main = entry(1, '2025-01-10', 24, { end: at('2025-06-20') })
    const side = entry(9, '2025-04-04', 12, { format: 'ONA', chain: false })
    const ids = assignEpisodes([main, side], weekly('a', 2, '2025-01-10', 24))
    assert.equal(tracked(ids, 'a23'), '1:24')
  })

  it('places a season dated in one upload batch by count, not by the batch date', () => {
    const first = entry(1, '2012-10-06', 26)
    const second = entry(2, '2014-04-04', 24)
    const batch = weekly('a', 1, '2014-04-04', 26).map((ep) => ({ ...ep, airDate: iso(at('2014-04-04')) }))
    const ids = assignEpisodes([first, second], [...batch, ...weekly('b', 2, '2014-04-04', 24)])
    assert.equal(tracked(ids, 'a0'), '1:1')
    assert.equal(tracked(ids, 'b0'), '2:1')
  })
})
