import { Agent, fetch as undiciFetch } from 'undici'
import { CrError, shortBody } from './errors.js'
import { isCrunchyrollHost } from './headers.js'

export interface CrRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Browser fetch cannot set Cookie; Chrome transport uses the CDP jar instead. */
  cookie?: string
}

export interface CrResponse {
  status: number
  url: string
  headers: Record<string, string>
  body: Buffer
  get text(): string
}

export interface CrTransport {
  readonly name: string
  request(req: CrRequest): Promise<CrResponse>
  close?(): Promise<void>
}

const h2Agent = new Agent({
  allowH2: true,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 8,
})

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/**
 * Node undici with HTTP/2 enabled. Used as the always-available fallback, and as
 * the primary transport when Chromium is not installed.
 *
 * crunchy-deck's main-process Node fetch is this same stack without HTTP/2 and
 * without the TV/web header sets. We keep HTTP/2 on and always send HTTPS.
 */
export class FetchTransport implements CrTransport {
  readonly name = 'fetch-h2'

  async request(req: CrRequest): Promise<CrResponse> {
    const headers = { ...(req.headers ?? {}) }
    if (req.cookie) {
      headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${req.cookie}` : req.cookie
    }
    const method = req.method ?? (req.body ? 'POST' : 'GET')
    const res = await undiciFetch(req.url, {
      method,
      headers,
      body: req.body,
      dispatcher: isCrunchyrollHost(req.url) ? h2Agent : undefined,
      redirect: 'follow',
    })
    const bytes = Buffer.from(await res.arrayBuffer())
    return makeResponse(res.status, res.url, headerRecord(res.headers), bytes)
  }
}

export function makeResponse(
  status: number,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): CrResponse {
  return {
    status,
    url,
    headers,
    body,
    get text() {
      return this.body.toString('utf8')
    },
  }
}

export async function jsonOrThrow<T>(res: CrResponse): Promise<T> {
  if (res.status < 200 || res.status >= 300) {
    throw new CrError(res.status, res.text, `Crunchyroll HTTP ${res.status}: ${shortBody(res.text)}`)
  }
  if (!res.body.length) return undefined as T
  try {
    return JSON.parse(res.text) as T
  } catch {
    throw new CrError(res.status, res.text, 'Crunchyroll returned non-JSON')
  }
}
