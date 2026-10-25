import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feedRows, heroCards, panels, pickImage } from '../src/cr/content.js'
import { audioLabel, episodeLabel, heroMeta, metaPreview, parseExtra, pickSeasons, ratingOf, stripPrefix, videoOf, withFacts, withResume } from '../src/stremio.js'

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
  assert.equal(meta.background, 'https://imgsrv.crunchyroll.com/cdn-cgi/image/format=auto,width=1920/wide.jpg')
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
