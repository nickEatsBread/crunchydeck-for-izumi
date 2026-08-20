import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  makeMediaId,
  parseMediaId,
  pickVersionGuid,
  seasonFromTitle,
  seasonTitleVariants,
  yearMatches,
} from '../src/cr/match.js'
import { rewriteManifest } from '../src/cr/proxy.js'
import type { PlaySession } from '../src/cr/play.js'
import { crHeaders, isCrunchyrollHost, mediaHeaders } from '../src/cr/headers.js'

test('seasonFromTitle reads common anime season labels', () => {
  assert.equal(seasonFromTitle('My Hero Academia 2nd Season'), 2)
  assert.equal(seasonFromTitle('My Hero Academia Season 3'), 3)
  assert.equal(seasonFromTitle('Boku no Hero Academia S4'), 4)
  assert.equal(seasonFromTitle('My Hero Academia'), undefined)
  assert.equal(seasonFromTitle('Final Season'), 99)
})

test('season 1 variants omit the season marker so Izumi can match the base title', () => {
  const titles = seasonTitleVariants('My Hero Academia', 1, 'Season 1')
  assert.deepEqual(titles, ['My Hero Academia'])
})

test('later seasons include number variants Izumi identity-matches', () => {
  const titles = seasonTitleVariants('My Hero Academia', 2, 'Season 2')
  assert.ok(titles.includes('My Hero Academia Season 2'))
  assert.ok(titles.includes('My Hero Academia 2nd Season'))
  assert.ok(titles.includes('My Hero Academia 2'))
})

test('pickVersionGuid prefers the requested audio locale then original', () => {
  const versions = [
    { audio_locale: 'en-US', guid: 'dub' },
    { audio_locale: 'ja-JP', guid: 'sub', original: true },
  ]
  assert.equal(pickVersionGuid(versions, 'fallback', 'ja-JP'), 'sub')
  assert.equal(pickVersionGuid(versions, 'fallback', 'en-US'), 'dub')
  assert.equal(pickVersionGuid(undefined, 'fallback', 'ja-JP'), 'fallback')
})

test('media ids round-trip', () => {
  const id = makeMediaId('SERIES', 'SEASON', 'ja-JP')
  assert.deepEqual(parseMediaId(id), { seriesId: 'SERIES', seasonId: 'SEASON', audio: 'ja-JP' })
})

test('yearMatches allows a one-year slop and treats missing as unknown', () => {
  assert.equal(yearMatches(2016, 2016), true)
  assert.equal(yearMatches(2016, 2017), true)
  assert.equal(yearMatches(2016, 2019), false)
  assert.equal(yearMatches(2016, undefined), true)
})

test('TV headers are the Tizen UA without Chrome client hints', () => {
  const headers = crHeaders({ profile: 'tv', authorization: 'Bearer x' })
  assert.match(headers['User-Agent'] ?? '', /SMART-TV/)
  assert.equal(headers['Authorization'], 'Bearer x')
  assert.equal(headers['sec-ch-ua'], undefined)
})

test('web headers match the live Chrome HAR client hints', () => {
  const headers = crHeaders({ profile: 'web' })
  assert.match(headers['User-Agent'] ?? '', /Chrome\/151/)
  assert.equal(headers['Origin'], 'https://www.crunchyroll.com')
  assert.ok(headers['sec-ch-ua']?.includes('Google Chrome'))
})

test('media headers keep Referer for CDN hotlink protection', () => {
  const headers = mediaHeaders('web', 'tok')
  assert.equal(headers.Referer, 'https://www.crunchyroll.com/')
  assert.equal(headers.Authorization, 'Bearer tok')
})

test('isCrunchyrollHost covers API, play, and CDN hosts', () => {
  assert.equal(isCrunchyrollHost('https://www.crunchyroll.com/auth/v1/token'), true)
  assert.equal(isCrunchyrollHost('https://cr-play-service.prd.crunchyrollsvc.com/v1/x'), true)
  assert.equal(isCrunchyrollHost('https://vod-fy-mod.crunchyrollcdn.com/a.mp4'), true)
  assert.equal(isCrunchyrollHost('https://example.com'), false)
})

test('manifest rewrite points BaseURL at a path-prefix CDN proxy', () => {
  const session = {
    id: 'sess',
    contentId: 'ep',
    token: 't',
    manifestUrl: 'https://www.crunchyroll.com/playback/v2/manifest/x',
    videoContainer: 'dash',
    headers: {},
    subtitles: [],
    captions: [],
    createdAt: 0,
  } as PlaySession
  const xml = '<MPD><BaseURL>https://vod.crunchyrollcdn.com/a/</BaseURL></MPD>'
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session)
  assert.equal(out, '<MPD><BaseURL>http://127.0.0.1:17871/v/sess/cdn/</BaseURL></MPD>')
  assert.equal(session.cdnBase, 'https://vod.crunchyrollcdn.com/a/')
})
