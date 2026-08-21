/**
 * Crunchyroll's Widevine license proxy returns JSON `{ license: <base64> }`
 * instead of raw EME license bytes. Shaka/EME need the unwrapped payload.
 * Certificate responses use the same wrapper.
 */

export function unwrapLicenseResponse(body: Buffer, contentType = ''): Buffer {
  if (!body.length) return body
  const type = contentType.toLowerCase()
  const head = body.subarray(0, Math.min(body.length, 16)).toString('utf8').trimStart()
  const looksJson = type.includes('json') || head.startsWith('{')
  if (!looksJson) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== 'object') return body
  const rec = parsed as Record<string, unknown>
  const status = rec.status
  if (typeof status === 'string' && status && status.toUpperCase() !== 'OK') {
    const why = rec.error ?? rec.message ?? status
    throw new Error(String(why))
  }
  const b64 = rec.license ?? rec.License
  if (typeof b64 === 'string' && b64.length) return Buffer.from(b64, 'base64')
  const message = rec.error ?? rec.message
  if (typeof message === 'string' && message.trim()) throw new Error(message)
  return body
}
