import {
  CHROME_UA,
  HOSTS,
  TIZEN_UA,
  type ClientProfile,
} from './constants.js'

export interface HeaderOptions {
  profile: ClientProfile
  authorization?: string
  contentType?: string
  cookie?: string
  referer?: string
  extra?: Record<string, string>
}

/**
 * Build the header set the matching official client sends.
 *
 * TV: Tizen UA only, plus Authorization — the Tizen app (crunchyroll-linux)
 * does not send Chrome Client Hints. The BrowserWindow UA is what makes
 * Chromium's TLS/ALPN/HTTP version look like a TV.
 *
 * Web: Chrome 151 Client Hints + Origin/Referer from the live HAR. Crunchyroll
 * sits behind Cloudflare with alt-svc h3; these headers matter as much as the
 * TLS stack.
 */
export function crHeaders(opts: HeaderOptions): Record<string, string> {
  const origin = HOSTS.www
  const referer = opts.referer ?? `${origin}/`
  const headers: Record<string, string> = {}

  if (opts.profile === 'tv') {
    headers['User-Agent'] = TIZEN_UA
    headers['Accept'] = opts.contentType ? 'application/json' : 'application/json, text/plain, */*'
    headers['Accept-Language'] = 'en-US,en;q=0.9'
    headers['Accept-Encoding'] = 'gzip, deflate, br'
  } else {
    headers['User-Agent'] = CHROME_UA
    headers['Accept'] = 'application/json, text/plain, */*'
    headers['Accept-Language'] = 'en-GB,en-US;q=0.9,en;q=0.8'
    headers['Accept-Encoding'] = 'gzip, deflate, br, zstd'
    headers['Origin'] = origin
    headers['Referer'] = referer
    headers['sec-ch-ua'] = '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"'
    headers['sec-ch-ua-mobile'] = '?0'
    headers['sec-ch-ua-platform'] = '"Windows"'
    headers['sec-fetch-dest'] = 'empty'
    headers['sec-fetch-mode'] = 'cors'
    headers['sec-fetch-site'] = 'same-origin'
    headers['cache-control'] = 'no-cache'
    headers['pragma'] = 'no-cache'
  }

  if (opts.authorization) headers['Authorization'] = opts.authorization
  if (opts.contentType) headers['Content-Type'] = opts.contentType
  if (opts.cookie) headers['Cookie'] = opts.cookie
  if (opts.extra) Object.assign(headers, opts.extra)
  return headers
}

export function playbackHeaders(profile: ClientProfile, accessToken: string): Record<string, string> {
  return crHeaders({
    profile,
    authorization: `Bearer ${accessToken}`,
    referer: `${HOSTS.www}/`,
    extra: profile === 'web' ? { Accept: '*/*' } : undefined,
  })
}

export function mediaHeaders(profile: ClientProfile, accessToken?: string): Record<string, string> {
  const headers = crHeaders({
    profile,
    authorization: accessToken ? `Bearer ${accessToken}` : undefined,
    referer: `${HOSTS.www}/`,
    extra: { Accept: '*/*' },
  })
  delete headers['sec-ch-ua']
  delete headers['sec-ch-ua-mobile']
  delete headers['sec-ch-ua-platform']
  delete headers['sec-fetch-dest']
  delete headers['sec-fetch-mode']
  delete headers['sec-fetch-site']
  return headers
}

/** CloudFront signed media. Referer is required; Authorization/Bearer must NOT be sent. */
export function cdnHeaders(profile: ClientProfile): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': profile === 'tv' ? TIZEN_UA : CHROME_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    Origin: HOSTS.www,
    Referer: `${HOSTS.www}/`,
  }
  return headers
}

export function isCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('.crunchyrollcdn.com') || host.endsWith('.vrv.co') || host.endsWith('.akamaized.net')
  } catch {
    return false
  }
}

/** True when this host should be fetched with the spoofed CR client, not Node defaults. */
export function isCrunchyrollHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'crunchyroll.com' ||
      host.endsWith('.crunchyroll.com') ||
      host.endsWith('.crunchyrollsvc.com') ||
      host.endsWith('.crunchyrollcdn.com') ||
      host.endsWith('.vrv.co') ||
      host.endsWith('.akamaized.net')
    )
  } catch {
    return false
  }
}
