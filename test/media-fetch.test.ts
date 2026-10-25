import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MediaGateway, mediaCacheKey, nextSegmentUrl } from '../src/cr/media-fetch.js'

test('nextSegmentUrl increments a padded fragment name', () => {
  assert.equal(
    nextSegmentUrl('https://vod.crunchyrollcdn.com/dash/video/seg-001.m4s?t=exp=1'),
    'https://vod.crunchyrollcdn.com/dash/video/seg-002.m4s?t=exp=1',
  )
  assert.equal(nextSegmentUrl('https://vod.crunchyrollcdn.com/dash/video/init-file.mp4'), undefined)
})

test('MediaGateway coalesces concurrent identical loads into one upstream fetch', async () => {
  const gateway = new MediaGateway()
  let loads = 0
  const load = async () => {
    loads += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return {
      status: 200,
      contentType: 'video/mp4',
      body: Buffer.from('abcd'),
      headers: { 'content-type': 'video/mp4' },
    }
  }
  const key = mediaCacheKey('https://cdn/seg-1.m4s')
  const [a, b] = await Promise.all([gateway.fetch(key, load), gateway.fetch(key, load)])
  assert.equal(loads, 1)
  assert.equal(Buffer.isBuffer(a.body) && a.body.toString(), 'abcd')
  assert.equal(Buffer.isBuffer(b.body) && b.body.toString(), 'abcd')
  const cached = await gateway.fetch(key, load)
  assert.equal(loads, 1)
  assert.equal(Buffer.isBuffer(cached.body) && cached.body.toString(), 'abcd')
})

test('MediaGateway does not cache error responses', async () => {
  const gateway = new MediaGateway()
  let loads = 0
  const key = mediaCacheKey('https://cdn/missing.m4s')
  const load = async () => {
    loads += 1
    return { status: 404, contentType: 'text/plain', body: Buffer.from('no'), headers: {} }
  }
  await gateway.fetch(key, load)
  await gateway.fetch(key, load)
  assert.equal(loads, 2)
})
