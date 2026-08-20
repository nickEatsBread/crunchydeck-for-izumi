/** Device-code helpers. Pure so the crunchy-deck poll contract can be unit-tested. */

export const ACTIVATE_URL = 'https://www.crunchyroll.com/activate'

/**
 * Crunchyroll's Tizen client returns `polling_interval` in **milliseconds**.
 * Some payloads use seconds. Values > 100 are treated as ms (crunchy-deck).
 */
export function normalizeIntervalMs(raw: unknown): number {
  const n = Number(raw)
  const value = Number.isFinite(n) && n > 0 ? n : 5000
  const ms = value > 100 ? value : value * 1000
  return Math.min(5000, Math.max(1000, ms))
}

export function mapDeviceCodeResponse(raw: Record<string, unknown>): {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  intervalMs: number
} {
  const bare = typeof raw.verification_uri === 'string' && raw.verification_uri
    ? raw.verification_uri
    : ACTIVATE_URL
  const complete = typeof raw.verification_uri_complete === 'string' && raw.verification_uri_complete
    ? raw.verification_uri_complete
    : bare
  const userCode = String(raw.user_code ?? '')
  const withCode = /[?&]code=/.test(complete) ? complete : `${complete}${complete.includes('?') ? '&' : '?'}code=${encodeURIComponent(userCode)}`
  return {
    deviceCode: String(raw.device_code ?? ''),
    userCode,
    verificationUri: bare,
    verificationUriComplete: withCode,
    expiresIn: Number(raw.expires_in) || 300,
    intervalMs: normalizeIntervalMs(raw.polling_interval ?? raw.interval),
  }
}

export type DeviceTokenStatus = 'ok' | 'pending' | 'slow_down' | 'expired' | 'error'

export function interpretDeviceToken(status: number, json: { access_token?: string; error?: string } | undefined, rawBody: string): {
  status: DeviceTokenStatus
  error?: string
} {
  // crunchy-deck: HTTP 200 with an EMPTY body is "still waiting", not an error.
  if (status >= 200 && status < 300) {
    if (json?.access_token) return { status: 'ok' }
    return { status: 'pending' }
  }
  const text = `${json?.error ?? ''} ${rawBody}`.toLowerCase()
  if (text.includes('expired')) return { status: 'expired' }
  if (text.includes('too_many') || text.includes('slow_down')) return { status: 'slow_down' }
  if (text.includes('denied') || text.includes('invalid_client') || text.includes('not_found') || text.includes('inactive')) {
    return { status: 'error', error: rawBody.slice(0, 200) }
  }
  if (status >= 400 && status < 500) return { status: 'pending' }
  return { status: 'error', error: rawBody.slice(0, 200) || `HTTP ${status}` }
}

export function isInvalidGrant(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { body?: string }).body ?? ''}` : String(error)
  return /invalid_grant/i.test(text)
}
