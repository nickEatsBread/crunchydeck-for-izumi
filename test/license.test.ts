import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unwrapLicenseResponse } from '../src/cr/license.js'

test('unwraps Crunchyroll JSON {license: base64} into raw Widevine bytes', () => {
  const raw = Buffer.from([0x08, 0x01, 0x12, 0x04, 0xde, 0xad, 0xbe, 0xef])
  const json = Buffer.from(JSON.stringify({ license: raw.toString('base64') }))
  assert.deepEqual(unwrapLicenseResponse(json, 'application/json'), raw)
})

test('unwraps the wrapped {status, license} payload Crunchyroll actually returns', () => {
  const raw = Buffer.from([0x08, 0x05, 0x12, 0x02, 0xaa, 0xbb])
  const json = Buffer.from(JSON.stringify({ status: 'OK', license: raw.toString('base64') }))
  assert.deepEqual(unwrapLicenseResponse(json, 'application/json; charset=utf-8'), raw)
})

test('passes through already-raw octet-stream licenses', () => {
  const raw = Buffer.from([0x00, 0x01, 0x02, 0xff])
  assert.deepEqual(unwrapLicenseResponse(raw, 'application/octet-stream'), raw)
})

test('surfaces a JSON error from the license proxy', () => {
  const json = Buffer.from(JSON.stringify({ error: 'TOO_MANY_ACTIVE_STREAMS' }))
  assert.throws(() => unwrapLicenseResponse(json, 'application/json'), /TOO_MANY_ACTIVE_STREAMS/)
})
