// Who may call the service on its loopback address. Loopback alone is not enough: any web page the
// user opens can send requests to 127.0.0.1, and DNS rebinding can make one look same-origin. So a
// local request must name a loopback host, and a browser request must come from izumi itself.
import type { IncomingHttpHeaders } from 'node:http'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** izumi's own webview origins: Windows/Linux/macOS builds, Android, and local dev servers. */
export function izumiOrigin(origin: string): boolean {
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.pathname === '/'
  } catch {
    return false
  }
}

/** The Host header names this machine's loopback address (any port). */
export function loopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? ''
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

export type LocalAccess = { ok: true; corsOrigin?: string } | { ok: false; reason: string }

/**
 * Decides a request that arrived on loopback without a share capability.
 * - The Host must be a loopback name, which defeats DNS rebinding.
 * - A request carrying an Origin must come from izumi (or the service's own page).
 * - A cross-site request without an Origin (an <img> or <script> on someone else's page) may only
 *   read media under /v/<session>/, whose random session id is itself the capability.
 */
export function localAccess(headers: IncomingHttpHeaders, path: string): LocalAccess {
  if (!loopbackHost(headers.host)) return { ok: false, reason: 'This service only answers on its loopback address.' }
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined
  if (origin !== undefined) {
    const own = `http://${headers.host}`
    if (origin === own || izumiOrigin(origin)) return { ok: true, corsOrigin: origin }
    return { ok: false, reason: 'Only izumi can use this service.' }
  }
  const site = headers['sec-fetch-site']
  if ((site === 'cross-site' || site === 'same-site') && !path.startsWith('/v/')) {
    return { ok: false, reason: 'Only izumi can use this service.' }
  }
  return { ok: true }
}
