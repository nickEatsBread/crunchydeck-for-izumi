import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  interpretDeviceToken,
  isInvalidGrant,
  mapDeviceCodeResponse,
  normalizeIntervalMs,
} from '../src/cr/device.js'
import { usesChromiumPage } from '../src/cr/chrome.js'

test('polling_interval from the Tizen client is milliseconds, not seconds', () => {
  assert.equal(normalizeIntervalMs(5000), 5000)
  assert.equal(normalizeIntervalMs(1000), 1000)
  assert.equal(normalizeIntervalMs(5), 5000)
  assert.equal(normalizeIntervalMs(30_000), 5000)
  assert.equal(normalizeIntervalMs(undefined), 5000)
})

test('device code mapping fills activate URL and embeds the user code', () => {
  const mapped = mapDeviceCodeResponse({
    device_code: 'dev',
    user_code: 'ABCD',
    expires_in: 300,
    polling_interval: 5000,
  })
  assert.equal(mapped.userCode, 'ABCD')
  assert.equal(mapped.intervalMs, 5000)
  assert.equal(mapped.verificationUri, 'https://www.crunchyroll.com/activate')
  assert.match(mapped.verificationUriComplete, /code=ABCD/)
})

test('empty HTTP 200 from /device/token is pending, matching crunchy-deck', () => {
  assert.equal(interpretDeviceToken(200, undefined, '').status, 'pending')
  assert.equal(interpretDeviceToken(200, {}, '').status, 'pending')
  assert.equal(interpretDeviceToken(200, { access_token: 'tok' }, '').status, 'ok')
})

test('authorization_pending and other 4xx stay pending so polling continues', () => {
  assert.equal(interpretDeviceToken(400, { error: 'authorization_pending' }, '{"error":"authorization_pending"}').status, 'pending')
  assert.equal(interpretDeviceToken(400, { error: 'slow_down' }, 'slow_down').status, 'slow_down')
  assert.equal(interpretDeviceToken(400, { error: 'expired_token' }, 'expired').status, 'expired')
})

test('invalid_grant is detected in CR oauth errors', () => {
  assert.equal(isInvalidGrant(new Error('Crunchyroll HTTP 400: {"error":"invalid_grant"}')), true)
  assert.equal(isInvalidGrant(new Error('nope')), false)
})

test('chromium page fetch is only used for www.crunchyroll.com, not beta-api', () => {
  assert.equal(usesChromiumPage('https://www.crunchyroll.com/auth/v1/token'), true)
  assert.equal(usesChromiumPage('https://www.crunchyroll.com/playback/v3/x/web/chrome/play'), true)
  assert.equal(usesChromiumPage('https://www.crunchyroll.com/playback/v2/manifest/x/static/y/0/en-US/dash/manifest.mpd'), true)
  assert.equal(usesChromiumPage('https://www.crunchyroll.com/static/preview.bif'), false)
  assert.equal(usesChromiumPage('https://beta-api.crunchyroll.com/content/v2/discover/search?q=x'), false)
  assert.equal(usesChromiumPage('https://cr-play-service.prd.crunchyrollsvc.com/v1/x'), false)
})
