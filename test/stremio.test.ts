import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Content, feedRows, heroCards, panels, pickImage } from '../src/cr/content.js'
import type { CrRequest, CrTransport } from '../src/cr/http.js'
import { audioLabel, categoryId, episodeLabel, FALLBACK_CATEGORIES, heroMeta, metaPreview, parseExtra, pickSeasons, ratingOf, StremioCatalog, stripPrefix, videoOf, withFacts, withResume } from '../src/stremio.js'

const images = (kind: string) => ({ [kind]: [[{ source: `https://img/${kind}/320`, width: 320 }, { source: `https://img/${kind}/640`, width: 640 }, { source: `https://img/${kind}/1920`, width: 1920 }]] })

test('feed rows keep Crunchy Deck panel types, put Continue Watching first and get stable ids', () => {
  const rows = feedRows({
    data: [
      { response_type: 'watchlist', resource_type: 'dynamic_collection', title: 'My Watchlist', link: '/content/v2/discover/acct/watchlist' },
      { response_type: 'hero_carousel', title: 'Hero', ids: ['x'] },
      { response_type: 'recommendations', title: 'For you', ids: ['a', 'b'] },
      { response_type: 'history', resource_type: 'dynamic_collection', title: 'Continue Watching', link: '/content/v2/discover/acct/history' },
      { response_type: 'recommendations', title: 'More for you', ids: ['c'] },
      { response_type: 'browse', title: 'Empty', ids: [] },
    ],
  })
  assert.deepEqual(rows.map((row) => [row.id, row.title]), [
    ['cr-history', 'Continue Watching'],
    ['cr-watchlist', 'My Watchlist'],
    ['cr-recommendations', 'For you'],
    ['cr-recommendations-2', 'More for you'],
  ])
})

test('hero cards are collected from the server-driven tree once each', () => {
  const tree = { a: [{ type: 'HeroMediaCard', props: { contentId: 'G1', title: 'One', logoImage: '/logo.png', wideImage: '/wide.jpg' } }], b: { type: 'HeroMediaCard', props: { contentId: 'G1', title: 'dup' } } }
  const cards = heroCards(tree)
  assert.equal(cards.length, 1)
  const meta = heroMeta(cards[0]!)
  assert.equal(meta.id, 'cr:G1')
  assert.equal(meta.logo, 'https://imgsrv.crunchyroll.com/cdn-cgi/image/format=auto,width=600/logo.png')
  assert.equal(meta.background, 'https://imgsrv.crunchyroll.com/cdn-cgi/image/format=jpeg,width=1920/wide.jpg')
})

test('a featured title carries its rating, Sub | Dub and genres', () => {
  const meta = heroMeta({ contentId: 'G1', title: 'One' })
  const [panel] = panels([{ id: 'G1', type: 'series', series_metadata: { is_subbed: true, is_dubbed: true, maturity_ratings: ['TV-14'], tenant_categories: ['drama', 'romance'] } }])
  const out = withFacts(meta, panel)
  assert.deepEqual([out.genres, out.izumi], [['Drama', 'Romance'], { rating: '14+', audio: 'Sub | Dub' }])
  assert.equal(withFacts(meta, undefined), meta)
})

test('a featured title the viewer started resumes from the banner', () => {
  const meta = heroMeta({ contentId: 'G1', title: 'One' })
  const [panel] = panels([{ id: 'E2', type: 'episode', episode_metadata: { series_id: 'G1', season_number: 1, episode_number: 2, duration_ms: 1_200_000 } }])
  assert.deepEqual(withResume(meta, { panel: panel!, playhead: 300, fullyWatched: false }).izumi?.continue, { videoId: 'cr:E2', label: 'S1 E2', progress: 0.25, remainingSec: 900 })
  assert.equal(withResume(meta, { panel: panel!, playhead: 0, fullyWatched: false }), meta)
  assert.equal(withResume(meta, { panel: panel!, playhead: 1200, fullyWatched: true }), meta)
})

test('images pick the smallest variant wide enough', () => {
  assert.equal(pickImage(images('thumbnail'), 'thumbnail', 600), 'https://img/thumbnail/640')
  assert.equal(pickImage(images('thumbnail'), 'thumbnail', 4000), 'https://img/thumbnail/1920')
  assert.equal(pickImage(undefined, 'thumbnail', 600), undefined)
})

test('ratings, Sub | Dub and episode labels read like Crunchy Deck', () => {
  assert.equal(ratingOf({ maturity_ratings: ['TV-14'] }), '14+')
  assert.equal(ratingOf({ extended_maturity_rating: { rating: '16' }, maturity_ratings: ['TV-14'] }), '16+')
  assert.equal(ratingOf({ maturity_ratings: ['TV-MA'] }), 'MA')
  assert.equal(audioLabel({ is_subbed: true, is_dubbed: true }), 'Sub | Dub')
  assert.equal(audioLabel({ is_subbed: true }), 'Sub')
  assert.equal(audioLabel({}), undefined)
  assert.equal(episodeLabel(2, 1), 'S2 E1')
})

test('a series panel becomes a poster meta with rating, audio and genres', () => {
  const meta = metaPreview({
    id: 'G1', type: 'series', title: 'One', description: 'd', images: { ...images('poster_tall'), ...images('poster_wide') },
    series_metadata: { is_subbed: true, is_dubbed: true, tenant_categories: ['action', 'slice-of-life'], series_launch_year: 2020, maturity_ratings: ['TV-14'] },
  })
  assert.deepEqual(meta, {
    id: 'cr:G1', type: 'series', name: 'One', description: 'd',
    poster: 'https://img/poster_tall/640', background: 'https://img/poster_wide/1920',
    genres: ['Action', 'Slice Of Life'], releaseInfo: '2020',
    izumi: { rating: '14+', audio: 'Sub | Dub' },
  })
})

test('a history episode becomes a Continue Watching card for its series', () => {
  const [panel] = panels([{ playhead: 600, fully_watched: false, panel: {
    id: 'E9', type: 'episode', title: 'Ep', images: images('thumbnail'),
    episode_metadata: { series_id: 'G1', series_title: 'One', season_number: 2, episode_number: 1, duration_ms: 1_440_000 },
  } }])
  const meta = metaPreview(panel!)!
  assert.equal(meta.id, 'cr:G1')
  assert.equal(meta.name, 'One')
  assert.equal(meta.posterShape, 'landscape')
  assert.deepEqual(meta.izumi?.continue, { videoId: 'cr:E9', label: 'S2 E1', remainingSec: 840, progress: 600 / 1440 })
  const [done] = panels([{ playhead: 1440, fully_watched: true, panel: { ...panel, playhead: undefined } }])
  assert.deepEqual(metaPreview(done!)!.izumi?.episode, { videoId: 'cr:E9', label: 'S2 E1' })
})

test('one season per number, the preferred audio first', () => {
  const picked = pickSeasons([
    { id: 'en1', season_number: 1, audio_locale: 'en-US' },
    { id: 'ja1', season_number: 1, audio_locale: 'ja-JP' },
    { id: 'ja2', season_number: 2, audio_locale: 'ja-JP' },
    { id: 'de1', season_number: 1, audio_locale: 'de-DE' },
  ], 'ja-JP')
  assert.deepEqual(picked.map((season) => season.id), ['ja1', 'ja2'])
})

test('episodes carry their stills, durations and progress', () => {
  const video = videoOf(
    { id: 'E1', guid: 'E1', number: 3, title: 'Three', duration_ms: 1_420_000, images: images('thumbnail') as never, episode_air_date: '2024-01-01T00:00:00Z' },
    1,
    { playhead: 710, fullyWatched: false },
  )
  assert.equal(video.id, 'cr:E1')
  assert.equal(video.thumbnail, 'https://img/thumbnail/640')
  assert.deepEqual(video.izumi, { durationSec: 1420, playhead: 710, watched: false, progress: 0.5 })
})

test('extras and ids parse safely', () => {
  assert.deepEqual(parseExtra('skip=24&search=one%20piece'), { skip: 24, search: 'one piece' })
  assert.deepEqual(parseExtra('skip=-3'), { skip: 0 })
  assert.equal(stripPrefix('cr:G1'), 'G1')
  assert.equal(stripPrefix('tt123'), undefined)
  assert.equal(stripPrefix('cr:'), undefined)
})

test('a genre extra is decoded once, so a category title may hold "&"', () => {
  assert.deepEqual(parseExtra('genre=Slice%20of%20life&skip=48'), { skip: 48, genre: 'Slice of life' })
  assert.deepEqual(parseExtra('genre=Music%20%26%20Idols'), { skip: 0, genre: 'Music & Idols' })
})

test('a category title maps to its browse id: the live list, then the built-in one, then its slug', () => {
  const live = [{ id: 'isekai-id', title: 'Isekai' }]
  assert.equal(categoryId('isekai', live), 'isekai-id')
  assert.equal(categoryId('Slice of life', live), 'slice-of-life')
  assert.equal(categoryId('Sci-Fi', []), 'sci-fi')
  assert.equal(categoryId('Post Apocalyptic', []), 'post-apocalyptic')
})

/** A signed-in service over a fake Crunchyroll: answers by path, records every URL asked for. */
function fakeService(answer: (url: URL) => unknown) {
  const urls: URL[] = []
  const transport: CrTransport = {
    name: 'fake',
    async request(req: CrRequest) {
      const url = new URL(req.url)
      urls.push(url)
      const text = JSON.stringify(answer(url) ?? {})
      return { status: 200, url: req.url, headers: {}, body: Buffer.from(text), get text() { return text } }
    },
  }
  const auth = { profile: 'tv', accessToken: async () => 'token', status: () => ({ authenticated: true, accountId: 'acct' }) }
  const content = new Content(transport, auth as never)
  return { urls, content, catalog: new StremioCatalog({ auth, content } as never) }
}

test('the paged listings carry skip and a genre extra; the rest stay as they were', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise((resolve) => { release = resolve })
  const { content, catalog } = fakeService(() => ({}))
  content.homeRows = async () => [{ id: 'cr-history', title: 'Continue Watching', kind: 'history', link: '/x' }]
  content.categories = () => pending as never

  // The first manifest does not wait for the category list: it lists the built-in one.
  const first = (await catalog.manifest()).catalogs as Array<{ id: string; extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }> }>
  const paged = first.filter((entry) => entry.extra?.some((item) => item.name === 'skip'))
  assert.deepEqual(paged.map((entry) => entry.id), ['cr-popular', 'cr-newest', 'cr-simulcast', 'cr-alphabetical'])
  for (const entry of paged) {
    assert.ok(!entry.extra!.some((item) => item.isRequired))
    assert.deepEqual(entry.extra!.find((item) => item.name === 'genre')?.options, FALLBACK_CATEGORIES.map((category) => category.title))
  }
  assert.equal(first.find((entry) => entry.id === 'cr-hero')?.extra, undefined)
  assert.equal(first.find((entry) => entry.id === 'cr-history')?.extra, undefined)
  assert.deepEqual(first.find((entry) => entry.id === 'cr-search')?.extra, [{ name: 'search', isRequired: true }])

  // Once read, the live list is what later manifests offer.
  release([{ id: 'action', title: 'Action' }, { id: 'isekai-id', title: 'Isekai' }])
  await new Promise((resolve) => setImmediate(resolve))
  const later = (await catalog.manifest()).catalogs as Array<{ id: string; extra?: Array<{ name: string; options?: string[] }> }>
  assert.deepEqual(later.find((entry) => entry.id === 'cr-newest')?.extra?.find((item) => item.name === 'genre')?.options, ['Action', 'Isekai'])
})

test('a failed category read leaves the built-in list and is tried again', async () => {
  const { content, catalog } = fakeService(() => ({}))
  let reads = 0
  content.homeRows = async () => []
  content.categories = async () => { reads++; throw new Error('offline') }
  const options = async () => ((await catalog.manifest()).catalogs as Array<{ id: string; extra?: Array<{ name: string; options?: string[] }> }>)
    .find((entry) => entry.id === 'cr-popular')?.extra?.find((item) => item.name === 'genre')?.options
  assert.equal((await options())?.length, FALLBACK_CATEGORIES.length)
  await new Promise((resolve) => setImmediate(resolve))
  await options()
  assert.equal(reads, 2)
})

test('a listing narrowed to a category asks Crunchyroll browse for it, keeping the sort and paging', async () => {
  const { urls, catalog } = fakeService((url) => (url.pathname.endsWith('/discover/categories')
    ? { data: [{ id: 'isekai-id', localization: { title: 'Isekai' } }] }
    : url.pathname.endsWith('/seasonal_tags') ? { data: [{ id: 'fall-2026' }] }
    : { data: [{ id: 'G1', type: 'series', title: 'One' }] }))
  const browse = () => urls.filter((url) => url.pathname.endsWith('/discover/browse')).at(-1)!.searchParams

  const metas = await catalog.catalog('cr-popular', 'genre=Slice%20of%20life&skip=24')
  assert.deepEqual(metas.map((meta) => meta.id), ['cr:G1'])
  assert.deepEqual([browse().get('categories'), browse().get('sort_by'), browse().get('start')], ['slice-of-life', 'popularity', '24'])

  await catalog.catalog('cr-alphabetical', 'skip=48')
  assert.deepEqual([browse().get('categories'), browse().get('sort_by'), browse().get('start')], [null, 'alphabetical', '48'])

  await catalog.catalog('cr-simulcast', 'genre=Action')
  assert.deepEqual([browse().get('categories'), browse().get('seasonal_tag')], ['action', 'fall-2026'])

  // A category only the live list knows maps to its id once the manifest has read the list.
  await catalog.manifest()
  await new Promise((resolve) => setImmediate(resolve))
  await catalog.catalog('cr-newest', 'genre=Isekai')
  assert.deepEqual([browse().get('categories'), browse().get('sort_by')], ['isekai-id', 'newly_added'])
})

test('a category backdrop is the variant nearest a Deck screen, from either answer shape', async () => {
  const { categoryImage } = await import('../src/cr/content.js')
  const v = (width: number) => ({ source: `https://img.example/${width}.jpg`, width })
  assert.equal(categoryImage({ background: [v(640), v(1280), v(1920)] }), 'https://img.example/1280.jpg')
  assert.equal(categoryImage({ background: [[v(480), v(1440)]] }), 'https://img.example/1440.jpg')
  assert.equal(categoryImage({ background: [{ source: 'http://img.example/x.jpg', width: 1280 }] }), undefined)
  assert.equal(categoryImage(undefined), undefined)
})
