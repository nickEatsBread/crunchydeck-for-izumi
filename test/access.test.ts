import assert from 'node:assert/strict'
import { test } from 'node:test'
import { izumiOrigin, localAccess, loopbackHost } from '../src/access.js'

test('only loopback host names pass, whatever the port', () => {
  assert.equal(loopbackHost('127.0.0.1:17871'), true)
  assert.equal(loopbackHost('localhost:17871'), true)
  assert.equal(loopbackHost('[::1]:17871'), true)
  assert.equal(loopbackHost('evil.example:17871'), false)
  assert.equal(loopbackHost('127.0.0.1.nip.io:17871'), false)
  assert.equal(loopbackHost(undefined), false)
})

test('izumi webview and dev origins are recognised', () => {
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:1420', 'http://127.0.0.1:3420']) {
    assert.equal(izumiOrigin(origin), true, origin)
  }
  for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'file://']) {
    assert.equal(izumiOrigin(origin), false, origin)
  }
})

test('a web page cannot drive the account or mint a play session', () => {
  const host = '127.0.0.1:17871'
  assert.deepEqual(localAccess({ host, origin: 'https://evil.example' }, '/api/logout'), { ok: false, reason: 'Only izumi can use this service.' })
  assert.equal(localAccess({ host, 'sec-fetch-site': 'cross-site' }, '/api/play').ok, false)
  assert.equal(localAccess({ host: 'rebound.evil.example:17871' }, '/__izumi/settings').ok, false)
})

test('izumi, the service page and native clients get through', () => {
  const host = '127.0.0.1:17871'
  assert.deepEqual(localAccess({ host, origin: 'tauri://localhost' }, '/api/search'), { ok: true, corsOrigin: 'tauri://localhost' })
  assert.deepEqual(localAccess({ host, origin: 'http://127.0.0.1:17871' }, '/api/login/device'), { ok: true, corsOrigin: 'http://127.0.0.1:17871' })
  assert.deepEqual(localAccess({ host }, '/__izumi/settings'), { ok: true })
  // Media under a random session id stays readable by plain <video>/<img> loads.
  assert.deepEqual(localAccess({ host, 'sec-fetch-site': 'cross-site' }, '/v/abc/cdn/seg.m4s'), { ok: true })
})
