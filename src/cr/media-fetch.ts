/**
 * Offline DASH storage issues one GET per ~2s fragment. Shaka then waits on
 * IndexedDB before the next fragment in that group, and a 5s stall abort
 * retries the same CloudFront URL while the first request is still running.
 * Coalesce those duplicates, cache immutable fragments, and cap upstream
 * concurrency so a download cannot out-request playback by an order of magnitude.
 */

export interface FetchedMedia {
  status: number
  contentType: string
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      releaseLock(): void
    }
  } | Buffer | null
  headers: Record<string, string>
}

const MAX_ENTRY_BYTES = 8 * 1024 * 1024
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024
const DEFAULT_CONCURRENCY = 4

export function mediaCacheKey(url: string, range?: string): string {
  return range ? `${url}\n${range}` : url
}

/** Next SegmentTemplate fragment (`seg-001.m4s` → `seg-002.m4s`). */
export function nextSegmentUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    let changed = false
    parsed.pathname = parsed.pathname.replace(/(\D)(\d+)(\.m4s|\.mp4)$/i, (_all, prefix: string, digits: string, ext: string) => {
      changed = true
      return `${prefix}${String(Number(digits) + 1).padStart(digits.length, '0')}${ext}`
    })
    return changed ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

export async function bufferFetchedMedia(fetched: FetchedMedia): Promise<FetchedMedia & { body: Buffer | null }> {
  if (fetched.body == null || Buffer.isBuffer(fetched.body)) {
    return { ...fetched, body: fetched.body as Buffer | null }
  }
  const chunks: Buffer[] = []
  const reader = fetched.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  const body = Buffer.concat(chunks)
  return {
    ...fetched,
    body,
    headers: {
      ...fetched.headers,
      'content-length': String(body.length),
    },
  }
}

class Limit {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next) next()
  }
}

interface CacheEntry {
  value: FetchedMedia & { body: Buffer }
  bytes: number
}

export class MediaGateway {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<FetchedMedia>>()
  private readonly limit: Limit
  private cacheBytes = 0
  private readonly maxCacheBytes: number

  constructor(opts?: { maxConcurrent?: number; maxCacheBytes?: number }) {
    this.limit = new Limit(Math.max(1, opts?.maxConcurrent ?? DEFAULT_CONCURRENCY))
    this.maxCacheBytes = Math.max(MAX_ENTRY_BYTES, opts?.maxCacheBytes ?? DEFAULT_CACHE_BYTES)
  }

  get cachedBytes(): number {
    return this.cacheBytes
  }

  get cachedEntries(): number {
    return this.cache.size
  }

  async fetch(
    key: string,
    load: () => Promise<FetchedMedia>,
    opts?: { cache?: boolean },
  ): Promise<FetchedMedia> {
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return {
        status: hit.value.status,
        contentType: hit.value.contentType,
        body: hit.value.body,
        headers: { ...hit.value.headers },
      }
    }
    const pending = this.inflight.get(key)
    if (pending) return pending

    const job = this.load(key, load, opts?.cache !== false)
    this.inflight.set(key, job)
    try {
      return await job
    } finally {
      this.inflight.delete(key)
    }
  }

  private async load(
    key: string,
    load: () => Promise<FetchedMedia>,
    cache: boolean,
  ): Promise<FetchedMedia> {
    await this.limit.acquire()
    try {
      const fetched = await load()
      if (!cache || fetched.status >= 400) return fetched
      const announced = Number(fetched.headers['content-length'] || 0)
      if (announced > MAX_ENTRY_BYTES) return fetched
      const buffered = await bufferFetchedMedia(fetched)
      if (!buffered.body || buffered.body.length === 0 || buffered.body.length > MAX_ENTRY_BYTES) {
        return buffered
      }
      this.put(key, {
        status: buffered.status,
        contentType: buffered.contentType,
        body: buffered.body,
        headers: buffered.headers,
      })
      return buffered
    } finally {
      this.limit.release()
    }
  }

  private put(key: string, value: FetchedMedia & { body: Buffer }): void {
    const bytes = value.body.length
    const existing = this.cache.get(key)
    if (existing) {
      this.cacheBytes -= existing.bytes
      this.cache.delete(key)
    }
    while (this.cacheBytes + bytes > this.maxCacheBytes && this.cache.size) {
      const oldest = this.cache.keys().next().value
      if (oldest == null) break
      const entry = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (entry) this.cacheBytes -= entry.bytes
    }
    this.cache.set(key, { value, bytes })
    this.cacheBytes += bytes
  }
}

export const mediaGateway = new MediaGateway()
