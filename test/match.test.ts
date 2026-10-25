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
import { dropImageSets, forceStaticVod, initialPlaybackUrl, keepAdaptiveLadder, keepHighestVideo, keepOfflineVideo, resolveCdnUrl, rewriteManifest, splitCdnBase } from '../src/cr/proxy.js'
import { firstPreviewUrl, PlayService, versionsOf, type PlaySession } from '../src/cr/play.js'
import { cdnHeaders, crHeaders, isCdnUrl, isCrunchyrollHost, mediaHeaders } from '../src/cr/headers.js'
import { makeResponse, type CrRequest, type CrTransport } from '../src/cr/http.js'
import type { Auth } from '../src/cr/auth.js'
import { saveSession } from '../src/storage.js'

// Never let PlayService lifecycle tests touch the developer's real saved session.
process.env.CR_SOURCE_DATA = `${process.env.TEMP ?? process.cwd()}\\cr-source-test-${process.pid}`

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
    cdnHeaders: {},
    subtitles: [],
    captions: [],
    hardSubs: [],
    versions: [],
    createdAt: 0,
  } as PlaySession
  const xml = '<MPD><BaseURL>https://vod.crunchyrollcdn.com/a/</BaseURL></MPD>'
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session, 'proxy')
  assert.equal(out, '<MPD><BaseURL>http://127.0.0.1:17871/v/sess/cdn/</BaseURL></MPD>')
  assert.equal(session.cdnBase, 'https://vod.crunchyrollcdn.com/a/')
})

test('signed BaseURL query stays off the path so CloudFront segments resolve', () => {
  const session = {
    id: 'sess',
    contentId: 'ep',
    token: 't',
    manifestUrl: 'https://www.crunchyroll.com/playback/v2/manifest/x',
    videoContainer: 'dash',
    headers: {},
    cdnHeaders: {},
    subtitles: [],
    captions: [],
    hardSubs: [],
    versions: [],
    createdAt: 0,
  } as PlaySession
  const signed = 'https://vod.crunchyrollcdn.com/a/?t=exp=1~acl=/a/*~hmac=x'
  assert.deepEqual(splitCdnBase(signed), { base: 'https://vod.crunchyrollcdn.com/a/', query: '?t=exp=1~acl=/a/*~hmac=x' })
  const xml = `<MPD><BaseURL>${signed}</BaseURL><SegmentTemplate media="$RepresentationID$/seg.m4s?t=exp=1~hmac=x"/></MPD>`
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session, 'proxy')
  assert.equal(session.cdnBase, 'https://vod.crunchyrollcdn.com/a/')
  assert.equal(session.cdnQuery, '?t=exp=1~acl=/a/*~hmac=x')
  assert.match(out, /\/v\/sess\/cdn\//)
  assert.doesNotMatch(out, /\?t=exp/)
  assert.equal(
    resolveCdnUrl(session, 'audio/init-file.mp4', '?t=stale'),
    'https://vod.crunchyrollcdn.com/a/audio/init-file.mp4?t=exp=1~acl=/a/*~hmac=x',
  )
})

test('CDN signature is retained when it lives on SegmentTemplate instead of BaseURL', () => {
  const session = {
    id: 'sess', contentId: 'ep', token: 't', manifestUrl: 'https://example/manifest.mpd',
    videoContainer: 'dash', headers: {}, cdnHeaders: {}, subtitles: [], captions: [],
    hardSubs: [], versions: [], createdAt: 0,
  } as PlaySession
  const xml = '<MPD><BaseURL>https://vod.crunchyrollcdn.com/static/ep/dash/</BaseURL>'
    + '<SegmentTemplate initialization="$RepresentationID$/init.mp4?t=exp=9~acl=/static/ep/*~hmac=abc"/></MPD>'
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session, 'proxy')

  assert.doesNotMatch(out, /\?t=exp/)
  assert.equal(session.cdnQuery, '?t=exp=9~acl=/static/ep/*~hmac=abc')
  assert.equal(
    resolveCdnUrl(session, 'video/init.mp4'),
    'https://vod.crunchyrollcdn.com/static/ep/dash/video/init.mp4?t=exp=9~acl=/static/ep/*~hmac=abc',
  )
})

test('direct manifest mode keeps signed CDN media on Chromium networking', () => {
  const session = {
    id: 'sess', contentId: 'ep', token: 't', manifestUrl: 'https://example/manifest.mpd',
    videoContainer: 'dash', headers: {}, cdnHeaders: {}, subtitles: [], captions: [],
    hardSubs: [], versions: [], createdAt: 0,
  } as PlaySession
  const signed = 'https://vod.crunchyrollcdn.com/static/ep/dash/?Policy=p&Key-Pair-Id=k&Signature=s'
  const xml = `<MPD type="dynamic" minimumUpdatePeriod="PT2S"><BaseURL>${signed}</BaseURL>`
    + '<SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s?Policy=p&amp;Key-Pair-Id=k&amp;Signature=s"/></MPD>'
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session, 'direct')

  assert.match(out, new RegExp(signed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(out, /SegmentTemplate media=/)
  assert.doesNotMatch(out, /127\.0\.0\.1/)
  assert.match(out, /type="static"/)
  assert.doesNotMatch(out, /minimumUpdatePeriod/)
})

test('SegmentBase file URLs retain their filename and use the range-aware asset proxy', () => {
  const session = {
    id: 'segment-base', contentId: 'ep', token: 't', manifestUrl: 'https://example/manifest.mpd',
    videoContainer: 'dash', headers: {}, cdnHeaders: {}, subtitles: [], captions: [],
    hardSubs: [], versions: [], createdAt: 0,
  } as PlaySession
  const file = 'https://vod.example.crunchyrollcdn.com/show/video/1080/video.mp4?t=exp%3D1~acl%3D%2Fshow%2F*~hmac%3Dabc'
  const xml = `<MPD><AdaptationSet mimeType="video/mp4"><Representation height="1080" bandwidth="1">`
    + `<BaseURL>${file}</BaseURL><SegmentBase indexRange="100-200"/></Representation></AdaptationSet></MPD>`
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session)

  assert.match(out, /\/v\/segment-base\/asset\?u=/)
  assert.match(out, /SegmentBase indexRange="100-200"/)
  assert.equal(decodeURIComponent(out.match(/asset\?u=([^<]+)/)?.[1] ?? ''), file)
  assert.doesNotMatch(out, /<BaseURL>http:\/\/127\.0\.0\.1:17871\/v\/segment-base\/cdn\/<\/BaseURL>/)
})

test('token remint preserves the local session object used by CDN routing', async () => {
  let playCount = 0
  const remoteLifecycle: string[] = []
  const transport: CrTransport = {
    name: 'test',
    async request(request: CrRequest) {
      if ((request.method ?? 'GET') === 'DELETE') {
        remoteLifecycle.push('delete')
        return makeResponse(204, request.url, {}, Buffer.alloc(0))
      }
      if (/\/play$/.test(request.url)) {
        remoteLifecycle.push('play')
        playCount += 1
        const body = Buffer.from(JSON.stringify({
          url: `https://www.crunchyroll.com/playback/v2/manifest/episode/static/asset/${playCount}/clean/dash/manifest.mpd`,
          token: `token-${playCount}`,
          videoContainer: 'dash',
          audioLocale: 'ja-JP',
          versions: [
            { audio_locale: 'ja-JP', guid: 'episode' },
            { audio_locale: 'en-US', guid: 'episode-dub' },
          ],
        }))
        return makeResponse(200, request.url, { 'content-type': 'application/json' }, body)
      }
      throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`)
    },
  }
  const auth = {
    profile: 'tv',
    accessToken: async () => 'access-token',
  } as unknown as Auth
  const play = new PlayService(transport, auth)
  const original = await play.resolve('episode')
  remoteLifecycle.length = 0
  const reminted = await play.resolve('episode', original.id)

  assert.deepEqual(remoteLifecycle, ['delete', 'play'])
  assert.strictEqual(reminted, original)
  assert.strictEqual(play.get(original.id), original)
  rewriteManifest(
    '<MPD><BaseURL>https://vod.crunchyrollcdn.com/static/episode/</BaseURL></MPD>',
    'http://127.0.0.1:17871',
    original,
  )
  assert.equal(
    resolveCdnUrl(play.get(original.id)!, 'video/init-file.mp4'),
    'https://vod.crunchyrollcdn.com/static/episode/video/init-file.mp4',
  )
})

test('concurrent episode resolves serialize and release the previous live token before minting another', async () => {
  const remoteLifecycle: string[] = []
  const transport: CrTransport = {
    name: 'test',
    async request(request: CrRequest) {
      if ((request.method ?? 'GET') === 'DELETE') {
        remoteLifecycle.push(`delete:${request.url.includes('token-one') ? 'one' : 'unknown'}`)
        return makeResponse(204, request.url, {}, Buffer.alloc(0))
      }
      if (/\/play$/.test(request.url)) {
        const contentId = request.url.includes('/episode-two/') ? 'two' : 'one'
        remoteLifecycle.push(`play:${contentId}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        return makeResponse(200, request.url, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
          url: `https://www.crunchyroll.com/playback/v2/manifest/episode-${contentId}/static/asset/1/clean/dash/manifest.mpd`,
          token: `token-${contentId}`,
          videoContainer: 'dash',
          audioLocale: 'ja-JP',
          versions: [
            { audio_locale: 'ja-JP', guid: `episode-${contentId}` },
            { audio_locale: 'en-US', guid: `episode-${contentId}-dub` },
          ],
        })))
      }
      throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`)
    },
  }
  const auth = { profile: 'tv', accessToken: async () => 'access-token' } as unknown as Auth
  const play = new PlayService(transport, auth)
  const first = play.defer('episode-one')
  const second = play.defer('episode-two')

  await Promise.all([play.ensureLiveToken(first), play.ensureLiveToken(second)])

  assert.deepEqual(remoteLifecycle, ['play:one', 'delete:one', 'play:two'])
  assert.equal(first.token, '')
  assert.equal(second.token, 'token-two')
})

test('a failed remote release never mints an overlapping episode token or forgets the old one', async () => {
  let playCount = 0
  const remoteLifecycle: string[] = []
  const transport: CrTransport = {
    name: 'test',
    async request(request: CrRequest) {
      if ((request.method ?? 'GET') === 'DELETE') {
        remoteLifecycle.push('delete-failed')
        return makeResponse(503, request.url, {}, Buffer.from('temporarily unavailable'))
      }
      if (/\/play$/.test(request.url)) {
        playCount += 1
        remoteLifecycle.push(`play:${playCount}`)
        return makeResponse(200, request.url, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
          url: `https://www.crunchyroll.com/playback/v2/manifest/episode/static/asset/${playCount}/clean/dash/manifest.mpd`,
          token: `token-${playCount}`,
          videoContainer: 'dash',
          audioLocale: 'ja-JP',
          versions: [
            { audio_locale: 'ja-JP', guid: 'episode' },
            { audio_locale: 'en-US', guid: 'episode-dub' },
          ],
        })))
      }
      throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`)
    },
  }
  const auth = { profile: 'tv', accessToken: async () => 'access-token' } as unknown as Auth
  const play = new PlayService(transport, auth)
  const first = await play.resolve('episode-one')
  const second = play.defer('episode-two')

  await assert.rejects(play.ensureLiveToken(second), /release failed/)

  assert.deepEqual(remoteLifecycle, ['play:1', 'delete-failed'])
  assert.equal(first.token, 'token-1')
  assert.equal(second.token, '')
})

test('deferred picker rows do not mint a Crunchyroll play token until selected', async () => {
  let playCount = 0
  const transport: CrTransport = {
    name: 'test',
    async request(request: CrRequest) {
      if ((request.method ?? 'GET') === 'DELETE') {
        return makeResponse(204, request.url, {}, Buffer.alloc(0))
      }
      if (/\/play$/.test(request.url)) {
        playCount += 1
        return makeResponse(200, request.url, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
          url: 'https://www.crunchyroll.com/playback/v2/manifest/episode/static/asset/1/clean/dash/manifest.mpd',
          token: 'selected-token',
          videoContainer: 'dash',
          audioLocale: 'ja-JP',
          versions: [
            { audio_locale: 'ja-JP', guid: 'episode' },
            { audio_locale: 'en-US', guid: 'episode-dub' },
          ],
        })))
      }
      throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`)
    },
  }
  const auth = { profile: 'tv', accessToken: async () => 'access-token' } as unknown as Auth
  const play = new PlayService(transport, auth)
  const session = play.defer('episode', {
    audioLocale: 'ja-JP',
    versions: [
      { language: 'ja-JP', guid: 'episode' },
      { language: 'en-US', guid: 'episode-dub' },
    ],
  })

  assert.equal(playCount, 0)
  assert.equal(session.token, '')
  assert.equal(session.versions.length, 2)

  await play.ensureLiveToken(session)
  assert.equal(playCount, 1)
  assert.equal(session.token, 'selected-token')
})

test('an immediate deferred selection awaits persisted token cleanup before play', async () => {
  saveSession({
    profile: 'tv',
    deviceId: 'test-device',
    activePlays: [{ contentId: 'leftover-episode', token: 'leftover-token' }],
  })
  const lifecycle: string[] = []
  const transport: CrTransport = {
    name: 'test',
    async request(request: CrRequest) {
      if ((request.method ?? 'GET') === 'DELETE') {
        lifecycle.push('delete-start')
        await new Promise((resolve) => setTimeout(resolve, 25))
        lifecycle.push('delete-end')
        return makeResponse(204, request.url, {}, Buffer.alloc(0))
      }
      if (/\/play$/.test(request.url)) {
        lifecycle.push('play')
        return makeResponse(200, request.url, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
          url: 'https://www.crunchyroll.com/playback/v2/manifest/episode/static/asset/1/clean/dash/manifest.mpd',
          token: 'fresh-token',
          videoContainer: 'dash',
          audioLocale: 'ja-JP',
        })))
      }
      if (/\/content\/v2\/cms\/objects\//.test(request.url)) {
        return makeResponse(200, request.url, { 'content-type': 'application/json' }, Buffer.from('{"data":[]}'))
      }
      throw new Error(`unexpected request ${request.method ?? 'GET'} ${request.url}`)
    },
  }
  const auth = { profile: 'tv', accessToken: async () => 'access-token' } as unknown as Auth
  const play = new PlayService(transport, auth)
  const session = play.defer('episode')

  await play.ensureLiveToken(session)

  assert.deepEqual(lifecycle, ['delete-start', 'delete-end', 'play'])
})

test('CDN headers always send Referer and never Authorization', () => {
  const tv = cdnHeaders('tv')
  const web = cdnHeaders('web')
  assert.equal(tv.Referer, 'https://www.crunchyroll.com/')
  assert.equal(tv.Origin, 'https://www.crunchyroll.com')
  assert.equal(tv.Authorization, undefined)
  assert.equal(web.Authorization, undefined)
  assert.equal(tv['Accept-Encoding'], 'identity')
  assert.equal(isCdnUrl('https://vod-cf-us-west-2.crunchyrollcdn.com/x'), true)
  assert.equal(isCdnUrl('https://beta-api.crunchyroll.com/x'), false)
})

test('firstPreviewUrl picks a BIF/sprite URL out of the play JSON map', () => {
  assert.equal(
    firstPreviewUrl({ 'en-US': { url: 'https://cdn.example/preview.bif' }, none: { url: '' } }),
    'https://cdn.example/preview.bif',
  )
  assert.equal(
    firstPreviewUrl({
      'zh-HK': { url: 'https://cdn.example/zh.bif' },
      'en-US': { url: 'https://cdn.example/en.bif' },
    }),
    'https://cdn.example/en.bif',
  )
})

test('versionsOf keeps each Crunchyroll audio locale with its episode GUID', () => {
  const versions = versionsOf({
    audioLocale: 'ja-JP',
    versions: [
      { audio_locale: 'ja-JP', guid: 'sub', original: true },
      { audio_locale: 'en-US', guid: 'dub' },
      { audio_locale: 'es-419', guid: 'latam' },
      { audio_locale: 'none', guid: 'skip' },
    ],
  }, 'sub', 'ja-JP')
  assert.deepEqual(versions, [
    { language: 'ja-JP', guid: 'sub' },
    { language: 'en-US', guid: 'dub' },
    { language: 'es-419', guid: 'latam' },
  ])
})

test('keepHighestVideo drops lower rungs so the proxy does not ABR down', () => {
  const xml = `
    <AdaptationSet>
      <Representation id="v240" height="240" bandwidth="1"></Representation>
      <Representation id="v1080low" height="1080" bandwidth="4"></Representation>
      <Representation id="v1080" height="1080" bandwidth="8"></Representation>
      <Representation id="audio" bandwidth="2"></Representation>
    </AdaptationSet>`
  const out = keepHighestVideo(xml)
  assert.match(out, /v1080"/)
  assert.doesNotMatch(out, /v1080low/)
  assert.doesNotMatch(out, /v240/)
  assert.match(out, /audio/)
})

test('forceStaticVod stops live-style 2s manifest refreshes', () => {
  const xml = '<MPD type="dynamic" minimumUpdatePeriod="PT2S" mediaPresentationDuration="PT24M"></MPD>'
  const out = forceStaticVod(xml)
  assert.match(out, /type="static"/)
  assert.doesNotMatch(out, /minimumUpdatePeriod/)
})

test('initialPlaybackUrl starts on the clean MPD so the first Shaka GET is a cache hit', () => {
  const session = {
    id: 'sess',
    contentId: 'ep',
    token: 't',
    manifestUrl: 'https://example/manifest.mpd',
    videoContainer: 'dash',
    audioLocale: 'ja-JP',
    headers: {},
    cdnHeaders: {},
    subtitles: [],
    captions: [],
    hardSubs: [{ language: 'en-US', url: 'https://example/en.mpd' }],
    versions: [],
    createdAt: 0,
  } as PlaySession
  const url = initialPlaybackUrl('http://127.0.0.1:17871', session, 'en-US')
  assert.match(url, /\/v\/sess\/manifest\.mpd/)
  assert.doesNotMatch(url, /hard=/)
})

test('dropImageSets removes DASH thumbnail AdaptationSets so playback does not fetch tiles', () => {
  const xml = `
    <AdaptationSet mimeType="video/mp4" contentType="video"><Representation height="1080" bandwidth="8"></Representation></AdaptationSet>
    <AdaptationSet mimeType="image/jpeg" contentType="image"><Representation bandwidth="1"></Representation></AdaptationSet>`
  const out = dropImageSets(xml)
  assert.match(out, /video\/mp4/)
  assert.doesNotMatch(out, /image\/jpeg/)
  assert.doesNotMatch(out, /contentType="image"/)
})

test('keepHighestVideo keeps a single audio bitrate', () => {
  const xml = `
    <AdaptationSet mimeType="audio/mp4" lang="ja-JP">
      <Representation id="a64" bandwidth="64000"></Representation>
      <Representation id="a128" bandwidth="128000"></Representation>
      <Representation id="a96" bandwidth="96000"></Representation>
    </AdaptationSet>`
  const out = keepHighestVideo(xml)
  assert.match(out, /a128/)
  assert.doesNotMatch(out, /a64/)
  assert.doesNotMatch(out, /a96/)
})

test('keepAdaptiveLadder keeps one bitrate per height and one audio bitrate', () => {
  const xml = '<MPD><AdaptationSet mimeType="video/mp4">'
    + '<Representation id="1080-low" height="1080" bandwidth="6000000"></Representation>'
    + '<Representation id="1080-high" height="1080" bandwidth="9000000"></Representation>'
    + '<Representation id="720" height="720" bandwidth="4000000"></Representation>'
    + '</AdaptationSet><AdaptationSet mimeType="audio/mp4">'
    + '<Representation id="a64" bandwidth="64000"></Representation>'
    + '<Representation id="a128" bandwidth="128000"></Representation>'
    + '</AdaptationSet></MPD>'
  const out = keepAdaptiveLadder(xml)

  assert.doesNotMatch(out, /1080-low/)
  assert.match(out, /1080-high/)
  assert.match(out, /id="720"/)
  assert.doesNotMatch(out, /a64/)
  assert.match(out, /a128/)
})

test('keepOfflineVideo stores one video height so a download cannot walk the ladder', () => {
  const xml = '<MPD><AdaptationSet mimeType="video/mp4">'
    + '<Representation id="1080-high" height="1080" bandwidth="9000000"></Representation>'
    + '<Representation id="720" height="720" bandwidth="4000000"></Representation>'
    + '<Representation id="480" height="480" bandwidth="1500000"></Representation>'
    + '</AdaptationSet><AdaptationSet mimeType="audio/mp4">'
    + '<Representation id="a64" bandwidth="64000"></Representation>'
    + '<Representation id="a128" bandwidth="128000"></Representation>'
    + '</AdaptationSet></MPD>'

  const highest = keepOfflineVideo(xml)
  assert.match(highest, /1080-high/)
  assert.doesNotMatch(highest, /id="720"/)
  assert.doesNotMatch(highest, /id="480"/)
  assert.match(highest, /a128/)
  assert.doesNotMatch(highest, /a64/)

  const capped = keepOfflineVideo(xml, 480)
  assert.match(capped, /id="480"/)
  assert.doesNotMatch(capped, /1080-high/)
  assert.doesNotMatch(capped, /id="720"/)
})

test('offline manifest rewrite collapses the ladder before proxying', () => {
  const session = {
    id: 'dl', contentId: 'ep', token: 't', manifestUrl: 'https://example/manifest.mpd',
    videoContainer: 'dash', headers: {}, cdnHeaders: {}, subtitles: [], captions: [],
    hardSubs: [], versions: [], createdAt: 0,
  } as PlaySession
  const xml = '<MPD type="dynamic" minimumUpdatePeriod="PT2S"><BaseURL>https://vod.crunchyrollcdn.com/a/</BaseURL>'
    + '<AdaptationSet mimeType="video/mp4">'
    + '<Representation id="1080" height="1080" bandwidth="9"></Representation>'
    + '<Representation id="720" height="720" bandwidth="4"></Representation>'
    + '</AdaptationSet></MPD>'
  const out = rewriteManifest(xml, 'http://127.0.0.1:17871', session, { offline: { maxHeight: 720 } })
  assert.match(out, /type="static"/)
  assert.match(out, /id="720"/)
  assert.doesNotMatch(out, /id="1080"/)
  assert.match(out, /\/v\/dl\/cdn\//)
})
