/**
 * Crunchyroll client constants.
 *
 * TV values come from the unofficial Tizen client used by crunchyroll-linux
 * (https://github.com/aarron-lee/crunchyroll-linux), which wraps the Samsung
 * TV app and sets this User-Agent on Chromium so every request — including
 * HTTP/2 and HTTP/3 — looks like the official TV stack.
 *
 * Web values come from a live www.crunchyroll.com HAR (Chrome 151, HTTP/3).
 * The etp_rt cookie grant only works with the web OAuth client.
 */

export const TIZEN_UA =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36'

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

/** Samsung-TV client_id:client_secret, base64. Public in the Tizen app. */
export const TV_CLIENT_BASIC =
  'Basic eHVuaWh2ZWRidDNtYmlzdWhldnQ6MWtJUzVkeVR2akUwX3JxYUEzWWVBaDBiVVhVbXhXMTE='

/**
 * Web OAuth client used by crunchyroll.com for `grant_type=etp_rt_cookie`.
 * `noahkdevm_6iyg0a8l0q:` with an empty secret.
 */
export const WEB_CLIENT_BASIC = 'Basic bm9haWhkZXZtXzZpeWcwYThsMHE6'

export const HOSTS = {
  www: 'https://www.crunchyroll.com',
  api: 'https://beta-api.crunchyroll.com',
  play: 'https://cr-play-service.prd.crunchyrollsvc.com',
  static: 'https://static.crunchyroll.com',
} as const

export const PLAY_PLATFORM = {
  tv: 'tv/samsung',
  web: 'web/chrome',
} as const

export type ClientProfile = 'tv' | 'web'

export const DEVICE = {
  web: { type: 'Chrome on Windows', name: 'Izumi Crunchyroll Source' },
  tv: { type: 'Samsung TV', name: 'Crunchyroll' },
} as const

export const DEFAULT_LOCALE = 'en-US'
export const DEFAULT_AUDIO_SUB = 'ja-JP'
export const DEFAULT_AUDIO_DUB = 'en-US'
export const TOKEN_SKEW_MS = 30_000
export const DEFAULT_PORT = 17871
