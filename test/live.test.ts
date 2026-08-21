import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CrunchyrollApp } from '../src/app.js'
import { listen } from '../src/server.js'

function etpFromCookies(path: string): string | undefined {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('#') || !line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 7) continue
      if ((parts[0] ?? '').toLowerCase().includes('crunchyroll') && parts[5] === 'etp_rt') return parts[6]
    }
  } catch {
    return undefined
  }
}

const cookiesPath = process.env.CR_COOKIES_FILE ?? String.raw`C:\Users\Student\Downloads\cookies (9).txt`
const etp = process.env.CR_ETP_RT || etpFromCookies(cookiesPath)

const maybe = etp ? test : test.skip

maybe('live: etp_rt login, search, episodes, play, izumi provider contract', async (t) => {
  process.env.CR_HTTP = process.env.CR_HTTP ?? 'fetch'
  const app = await CrunchyrollApp.create()
  await app.play.closeAll()
  const server = await listen(app, 0)
  t.after(async () => {
    await app.play.closeAll()
    await server.close()
    await app.close()
  })

  const status = await app.loginEtpRt(etp!)
  assert.equal(status.authenticated, true)
  assert.ok(status.accountId)

  const manifest = await fetch(`${app.baseUrl}/index.json`)
  assert.equal(manifest.ok, true)
  const manifestJson = await manifest.json() as { type: string; main: string }
  assert.equal(manifestJson.type, 'onlinestream-provider')

  const searchRes = await fetch(`${app.baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'My Hero Academia', dub: false, year: 2016 }),
  })
  assert.equal(searchRes.ok, true)
  const search = await searchRes.json() as { results: Array<{ id: string; title: string }> }
  assert.ok(search.results.length > 0)
  const season1 = search.results.find((row) => row.title === 'My Hero Academia') ?? search.results[0]
  assert.ok(season1)

  const episodesRes = await fetch(`${app.baseUrl}/api/episodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: season1.id }),
  })
  assert.equal(episodesRes.ok, true)
  const episodes = await episodesRes.json() as { episodes: Array<{ id: string; number: number }> }
  const ep1 = episodes.episodes.find((row) => row.number === 1)
  assert.ok(ep1, 'season should include episode 1')

  const playRes = await fetch(`${app.baseUrl}/api/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: ep1.id }),
  })
  const playText = await playRes.text()
  if (playText.includes('TOO_MANY_ACTIVE_STREAMS')) {
    t.diagnostic('play skipped: Crunchyroll concurrent-stream slot is already in use')
  } else {
    assert.equal(playRes.ok, true, playText)
    const serverPayload = JSON.parse(playText) as {
      videoSources: Array<{ url: string; type: string; subtitles: unknown[]; drm?: { licenseUrl?: string } }>
    }
    const source = serverPayload.videoSources[0]
    assert.ok(source, 'play should return a video source')
    assert.ok(source.url.includes('/v/'))
    assert.equal(source.type, 'dash')
    assert.ok(source.drm?.licenseUrl?.includes('/license'), 'DASH sources must carry a license proxy')

    const mpdRes = await fetch(source.url)
    const mpd = await mpdRes.text()
    assert.equal(mpdRes.ok, true, mpd)
    assert.match(mpd, /<MPD/)
    assert.match(mpd, /127\.0\.0\.1/)
  }

  const providerJs = await (await fetch(`${app.baseUrl}/provider.js`)).text()
  const provider = new Function(`${providerJs}\nreturn new Provider()`)() as {
    getSettings: () => Promise<{ episodeServers: string[]; supportsDub: boolean }>
    search: (opts: { query: string; dub: boolean }) => Promise<Array<{ id: string; title: string }>>
    findEpisodes: (id: string) => Promise<Array<{ id: string; number: number }>>
    findEpisodeServer: (episode: { id: string }, server: string) => Promise<{ videoSources: Array<{ url: string }> }>
  }
  const settings = await provider.getSettings()
  assert.equal(settings.supportsDub, true)
  const results = await provider.search({ query: 'My Hero Academia', dub: false })
  assert.ok(results.length > 0)
  const eps = await provider.findEpisodes(results[0]!.id)
  const first = eps.find((row) => row.number === 1)
  assert.ok(first)
  try {
    const played = await provider.findEpisodeServer({ id: first.id }, 'Crunchyroll')
    assert.ok(played.videoSources[0]?.url.includes('/v/'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('TOO_MANY_ACTIVE_STREAMS')) throw error
    t.diagnostic('provider play skipped: Crunchyroll concurrent-stream slot is already in use')
  }
})
