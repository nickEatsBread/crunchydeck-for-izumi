import { existsSync } from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { CHROME_UA, HOSTS, TIZEN_UA, type ClientProfile } from './constants.js'
import { FetchTransport, makeResponse, type CrRequest, type CrResponse, type CrTransport } from './http.js'

/** Page-evaluate fetch is same-origin to www.crunchyroll.com. beta-api / play / CDN are CORS and throw "Failed to fetch". */
export function usesChromiumPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'www.crunchyroll.com' || host === 'crunchyroll.com'
  } catch {
    return false
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((value): value is string => !!value)

export function findChrome(): string | undefined {
  return CHROME_CANDIDATES.find((path) => existsSync(path))
}

const FORBIDDEN = new Set([
  'cookie',
  'host',
  'connection',
  'content-length',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
])

/**
 * Chromium network stack (HTTP/2 + HTTP/3/QUIC, Chrome TLS). This is the
 * crunchyroll-linux model: a hidden page whose User-Agent is the Tizen (or
 * Chrome) string, with fetch() executed inside that page so Cloudflare sees a
 * real browser instead of Node's JA3.
 */
export class ChromeTransport implements CrTransport {
  readonly name = 'chrome'
  private browser: Browser | null = null
  private page: Page | null = null
  private profile: ClientProfile = 'web'
  private launching: Promise<void> | null = null
  private readonly node = new FetchTransport()

  constructor(private readonly executablePath: string) {}

  async setProfile(profile: ClientProfile): Promise<void> {
    this.profile = profile
    if (this.page) await this.applyUa()
  }

  async request(req: CrRequest): Promise<CrResponse> {
    if (!usesChromiumPage(req.url)) return this.node.request(req)
    try {
      return await this.pageFetch(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[cr] chrome page fetch failed, using node:', message.slice(0, 160))
      return this.node.request(req)
    }
  }

  private async pageFetch(req: CrRequest): Promise<CrResponse> {
    await this.ensurePage()
    const page = this.page
    if (!page) throw new Error('chrome transport has no page')

    if (req.cookie) await this.applyCookieHeader(req.cookie)

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      if (!FORBIDDEN.has(key.toLowerCase())) headers[key] = value
    }

    const result = await page.evaluate(
      async (payload) => {
        const init: RequestInit = {
          method: payload.method,
          headers: payload.headers,
          credentials: 'include',
        }
        if (payload.body !== undefined) init.body = payload.body
        const res = await fetch(payload.url, init)
        const headerPairs: Record<string, string> = {}
        res.headers.forEach((value, key) => {
          headerPairs[key] = value
        })
        const bytes = new Uint8Array(await res.arrayBuffer())
        let binary = ''
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
        }
        return {
          status: res.status,
          url: res.url,
          headers: headerPairs,
          bodyB64: btoa(binary),
        }
      },
      {
        url: req.url,
        method: req.method ?? (req.body ? 'POST' : 'GET'),
        headers,
        body: req.body,
      },
    )
    return makeResponse(result.status, result.url, result.headers, Buffer.from(result.bodyB64, 'base64'))
  }

  async setEtpRt(value: string): Promise<void> {
    await this.ensurePage()
    const page = this.page
    if (!page) return
    const cdp = await page.createCDPSession()
    try {
      await cdp.send('Network.setCookie', {
        name: 'etp_rt',
        value,
        domain: '.crunchyroll.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      })
    } finally {
      await cdp.detach().catch(() => {})
    }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.page = null
    if (browser) await browser.close().catch(() => {})
  }

  private async ensurePage(): Promise<void> {
    if (this.page && !this.page.isClosed()) return
    if (this.launching) {
      await this.launching
      return
    }
    this.launching = this.launch()
    try {
      await this.launching
    } finally {
      this.launching = null
    }
  }

  private async launch(): Promise<void> {
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args: [
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--disable-features=Translate,MediaRouter',
        '--mute-audio',
      ],
    })
    this.page = await this.browser.newPage()
    await this.applyUa()
    // Same-origin document so www.crunchyroll.com fetch is sec-fetch-site: same-origin
    // like the HAR. robots.txt is cheap and not a CF challenge page.
    await this.page.goto(`${HOSTS.www}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  }

  private async applyUa(): Promise<void> {
    if (!this.page) return
    await this.page.setUserAgent(this.profile === 'tv' ? TIZEN_UA : CHROME_UA)
  }

  private async applyCookieHeader(cookie: string): Promise<void> {
    const pairs = cookie.split(';').map((part) => part.trim()).filter(Boolean)
    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name === 'etp_rt') await this.setEtpRt(value)
    }
  }
}

export async function tryChromeTransport(): Promise<ChromeTransport | null> {
  const path = findChrome()
  if (!path) return null
  const transport = new ChromeTransport(path)
  try {
    // Force a launch so we fail here instead of on the first API call.
    await transport.request({ url: `${HOSTS.www}/robots.txt`, method: 'GET', headers: { Accept: '*/*' } })
    return transport
  } catch (error) {
    await transport.close().catch(() => {})
    console.warn('[cr] chrome transport unavailable:', error instanceof Error ? error.message : error)
    return null
  }
}
