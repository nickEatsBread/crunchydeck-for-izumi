import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSubtitleFont, looksLikeFont, subtitleFont, subtitleFonts } from '../src/cr/fonts.js'

const TTF = Buffer.from([0, 1, 0, 0, 0, 12, 0, 128, 0, 3, 0, 64, 1, 2, 3])

test('every family is listed under the play session', () => {
  const fonts = subtitleFonts('http://127.0.0.1:17871/v/abc')
  assert.ok(fonts.length > 60)
  assert.deepEqual(fonts.find((font) => font.family === 'Arial Bold'), { family: 'Arial Bold', url: 'http://127.0.0.1:17871/v/abc/fonts/arialbd.ttf' })
})

test('only listed files are served', () => {
  assert.equal(isSubtitleFont('trebuc.ttf'), true)
  for (const file of ['../session.json', 'trebuc.ttf/..', 'evil.ttf', '']) assert.equal(isSubtitleFont(file), false, file)
})

test('an error page is not a font', () => {
  assert.equal(looksLikeFont(TTF), true)
  assert.equal(looksLikeFont(Buffer.from('<!DOCTYPE HTML PUBLIC')), false)
})

test('a font is downloaded once and then read from disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cr-fonts-'))
  try {
    let calls = 0
    const fetcher = (async (url: string) => {
      calls++
      assert.match(String(url), /\/libass-fonts\/trebuc\.ttf$/)
      return new Response(TTF)
    }) as unknown as typeof fetch
    const [a, b] = await Promise.all([subtitleFont('trebuc.ttf', fetcher, root), subtitleFont('trebuc.ttf', fetcher, root)])
    assert.equal(calls, 1)
    assert.deepEqual(a, TTF)
    assert.deepEqual(b, TTF)
    assert.deepEqual(readFileSync(join(root, 'trebuc.ttf')), TTF)
    assert.deepEqual(await subtitleFont('trebuc.ttf', fetcher, root), TTF)
    assert.equal(calls, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed or non-font download is not cached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cr-fonts-'))
  try {
    let calls = 0
    const down = (async () => {
      calls++
      return new Response('bad gateway', { status: 502 })
    }) as unknown as typeof fetch
    await assert.rejects(subtitleFont('arial.ttf', down, root), /HTTP 502/)
    // Not asked for again straight away.
    await assert.rejects(subtitleFont('arial.ttf', down, root), /failed recently/)
    assert.equal(calls, 1)
    const html = (async () => new Response('<!DOCTYPE HTML PUBLIC')) as unknown as typeof fetch
    await assert.rejects(subtitleFont('georgia.ttf', html, root), /not a font/)
    await assert.rejects(subtitleFont('../x.ttf', html, root), /unknown subtitle font/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
