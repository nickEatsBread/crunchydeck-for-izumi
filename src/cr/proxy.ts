import type { PlayService, PlaySession } from './play.js'

const ABSOLUTE_URL = /https?:\/\/[^\s"'<>]+/gi
const BASE_URL = /<BaseURL>([^<]+)<\/BaseURL>/gi

/**
 * Crunchyroll DASH uses <BaseURL>https://cdn…/dash/</BaseURL> plus relative
 * SegmentTemplate paths (`$RepresentationID$/init-file.mp4`). If BaseURL is
 * rewritten to `…/asset?u=https://cdn…`, RFC 3986 resolution DROPS the query
 * and the player requests `/v/{id}/video/…` which 404s. Keep a path-prefix
 * proxy instead: `/v/{id}/cdn/` + relative path.
 */
export function splitCdnBase(raw: string): { base: string; query: string } {
  const decoded = raw.replace(/&amp;/g, '&').trim()
  const cut = decoded.search(/[?#]/)
  const href = cut < 0 ? decoded : decoded.slice(0, cut)
  const query = cut < 0 ? '' : decoded.slice(cut).replace(/#.*$/, '')
  try {
    const parsed = new URL(href)
    const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
    return { base: `${parsed.origin}${path}`, query }
  } catch {
    return { base: href.endsWith('/') ? href : `${href}/`, query }
  }
}

export function rewriteManifest(
  xml: string,
  proxyBase: string,
  session: PlaySession,
  mediaMode: 'direct' | 'proxy' = 'proxy',
): string {
  const bases = [...xml.matchAll(BASE_URL)].map((match) => match[1] ?? '')
  const cdnBase = bases.find((value) => /^https?:\/\//i.test(value))
  if (cdnBase) {
    const split = splitCdnBase(cdnBase)
    session.cdnBase = split.base
    session.cdnQuery = split.query
  }
  // Some current MPDs sign SegmentTemplate URLs instead of BaseURL. Shaka must
  // not send that signature to localhost, but the proxy must retain it for the
  // upstream CDN request.
  const templateQuery = xml.match(/\?t=exp=[^"'<\s]*/i)?.[0]?.replace(/&amp;/g, '&')
  if (!session.cdnQuery && templateQuery) session.cdnQuery = templateQuery
  let out = forceStaticVod(xml)
  out = dropImageSets(out)
  // Direct CDN mode is retained as an explicit experiment. Although these
  // responses advertise CORS, Crunchyroll's edge currently rejects WebView2's
  // media requests; the localhost proxy remains the reliable default.
  if (mediaMode === 'direct') return out

  const cdnProxy = `${proxyBase}/v/${session.id}/cdn/`
  out = keepAdaptiveLadder(out)
  out = out.replace(BASE_URL, (_block, raw: string) => {
    const decoded = raw.replace(/&amp;/g, '&').trim()
    try {
      // Some dub encodes use SegmentBase with a complete MP4 file as each
      // Representation's BaseURL. Replacing those with the directory proxy
      // loses the filename, so Shaka asks for `/cdn/` and CloudFront returns
      // 400. Route the exact file through the range-aware asset endpoint.
      const parsed = new URL(decoded)
      if (!parsed.pathname.endsWith('/')) {
        return `<BaseURL>${proxyBase}/v/${session.id}/asset?u=${encodeURIComponent(decoded)}</BaseURL>`
      }
    } catch {
      // Relative directory bases continue through the normal CDN prefix.
    }
    return `<BaseURL>${cdnProxy}</BaseURL>`
  })
  out = out.replace(ABSOLUTE_URL, (match) => {
    if (match.includes('/v/')) return match
    const split = splitCdnBase(match)
    if (session.cdnBase && split.base.startsWith(session.cdnBase.replace(/\/$/, ''))) {
      return cdnProxy + split.base.slice(session.cdnBase.length)
    }
    return `${proxyBase}/v/${session.id}/asset?u=${encodeURIComponent(match)}`
  })
  // Shaka copies BaseURL/segment `?t=exp=` onto localhost. The sidecar reattaches the live token.
  out = out.replace(/\?t=exp=[^"'<\s]*/gi, '')
  return out
}

/** Crunchyroll sometimes marks VOD as dynamic with a 2s update period. Shaka then
 *  re-fetches the MPD and trims the live window, which stalls on every segment. */
export function forceStaticVod(xml: string): string {
  return xml
    .replace(/\btype="dynamic"/gi, 'type="static"')
    .replace(/\sminimumUpdatePeriod="[^"]*"/gi, '')
}

/** DASH image AdaptationSets make Shaka GET thumbnail tiles through `/asset` during
 *  playback, which stalls video segments. Seek previews use the Fire TV BIF instead. */
export function dropImageSets(xml: string): string {
  return xml.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, (set) => {
    if (/mimeType="image\//i.test(set) || /\bcontentType="image"/i.test(set)) return ''
    return set
  })
}

/** Keep one video rung (tallest, then highest bitrate) and one audio rung.
 *  Extra 1080p/bitrate ladders make Shaka ABR through the local proxy and rebuffer
 *  on every ~2s segment. */
export function keepHighestVideo(xml: string): string {
  return xml.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, (set) => {
    if (/mimeType="image\//i.test(set) || /\bcontentType="image"/i.test(set)) return set
    if (/mimeType="text\//i.test(set) || /\bcontentType="text"/i.test(set)) return set
    if (/mimeType="audio\//i.test(set) || /\bcontentType="audio"/i.test(set)) {
      return keepSingleBandwidth(set)
    }
    if (!/mimeType="video\//i.test(set) && !/\bcontentType="video"/i.test(set) && !/\bheight="/i.test(set)) return set
    return keepSingleVideo(set)
  })
}

/** Keep one bitrate for each video height and one audio bitrate. Crunchyroll
 * occasionally publishes several encodes at the same resolution; those are
 * the rapid-switch loop that originally drained Shaka every two seconds. A
 * resolution ladder still lets Shaka start/seek on a smaller segment and move
 * up to 1080p once bandwidth is known. */
export function keepAdaptiveLadder(xml: string): string {
  return xml.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, (set) => {
    if (/mimeType="image\//i.test(set) || /\bcontentType="image"/i.test(set)) return set
    if (/mimeType="text\//i.test(set) || /\bcontentType="text"/i.test(set)) return set
    if (/mimeType="audio\//i.test(set) || /\bcontentType="audio"/i.test(set)) {
      return keepSingleBandwidth(set)
    }
    if (!/mimeType="video\//i.test(set) && !/\bcontentType="video"/i.test(set) && !/\bheight="/i.test(set)) return set

    const bestByHeight = new Map<number, number>()
    for (const match of set.matchAll(/<Representation\b[\s\S]*?<\/Representation>/g)) {
      const height = Number(match[0].match(/\bheight="(\d+)"/)?.[1] ?? 0)
      const bandwidth = Number(match[0].match(/\bbandwidth="(\d+)"/)?.[1] ?? 0)
      if (!height) continue
      bestByHeight.set(height, Math.max(bestByHeight.get(height) ?? -1, bandwidth))
    }
    const kept = new Set<number>()
    return set.replace(/<Representation\b[\s\S]*?<\/Representation>/g, (block) => {
      const height = Number(block.match(/\bheight="(\d+)"/)?.[1] ?? 0)
      if (!height) return block
      const bandwidth = Number(block.match(/\bbandwidth="(\d+)"/)?.[1] ?? 0)
      if (bandwidth !== bestByHeight.get(height) || kept.has(height)) return ''
      kept.add(height)
      return block
    })
  })
}

function keepSingleBandwidth(set: string): string {
  let best = -1
  for (const match of set.matchAll(/<Representation\b[\s\S]*?<\/Representation>/g)) {
    const bandwidth = Number(match[0].match(/\bbandwidth="(\d+)"/)?.[1] ?? -1)
    if (bandwidth > best) best = bandwidth
  }
  if (best < 0) return set
  let kept = false
  return set.replace(/<Representation\b[\s\S]*?<\/Representation>/g, (block) => {
    const bandwidth = Number(block.match(/\bbandwidth="(\d+)"/)?.[1] ?? -1)
    if (bandwidth !== best || kept) return ''
    kept = true
    return block
  })
}

function keepSingleVideo(set: string): string {
  const heights = [...set.matchAll(/\bheight="(\d+)"/g)].map((match) => Number(match[1]))
  const maxHeight = Math.max(0, ...heights)
  if (!maxHeight) return set
  let bestBandwidth = -1
  for (const match of set.matchAll(/<Representation\b[\s\S]*?<\/Representation>/g)) {
    const height = Number(match[0].match(/\bheight="(\d+)"/)?.[1] ?? 0)
    const bandwidth = Number(match[0].match(/\bbandwidth="(\d+)"/)?.[1] ?? 0)
    if (height === maxHeight && bandwidth > bestBandwidth) bestBandwidth = bandwidth
  }
  let kept = false
  return set.replace(/<Representation\b[\s\S]*?<\/Representation>/g, (block) => {
    if (!/\bheight="/i.test(block)) return block
    const height = Number(block.match(/\bheight="(\d+)"/)?.[1] ?? 0)
    const bandwidth = Number(block.match(/\bbandwidth="(\d+)"/)?.[1] ?? 0)
    if (height === maxHeight && bandwidth === bestBandwidth && !kept) {
      kept = true
      return block
    }
    return ''
  })
}

export function resolveCdnUrl(session: PlaySession, restPath: string, search = ''): string | undefined {
  if (!session.cdnBase) return undefined
  const path = restPath.replace(/^\/+/, '')
  const query = session.cdnQuery || search || ''
  return `${session.cdnBase}${path}${query}`
}

const rewrittenJobs = new Map<string, Promise<{ contentType: string; body: string }>>()

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function loadRewrittenManifest(
  play: PlayService,
  session: PlaySession,
  proxyBase: string,
  manifestUrl = session.manifestUrl,
  refresh = true,
): Promise<{ contentType: string; body: string }> {
  if (refresh) await play.ensureLiveToken(session)
  const mediaMode = process.env.CR_MEDIA_DIRECT === '1' ? 'direct' : 'proxy'
  const key = `${session.id}|${session.manifestUrl}|${manifestUrl}|${proxyBase}|${mediaMode}`
  if (session.rewritten?.key === key) return { contentType: session.rewritten.contentType, body: session.rewritten.body }
  const pending = rewrittenJobs.get(key)
  if (pending) return pending
  const job = (async () => {
    const clean = session.manifestUrl
    let fetched: { contentType: string; body: string }
    try {
      fetched = manifestUrl === clean || !refresh
        ? await play.fetchManifest(session, manifestUrl === clean ? clean : manifestUrl, refresh)
        : await withTimeout(play.fetchManifest(session, manifestUrl, refresh), 8_000, 'hard manifest')
    } catch (error) {
      if (manifestUrl === clean) throw error
      console.warn('[proxy] hard manifest failed, using clean:', error instanceof Error ? error.message : error)
      fetched = await play.fetchManifest(session, clean, refresh)
    }
    const contentType = fetched.contentType.includes('mpegurl') ? fetched.contentType : 'application/dash+xml'
    const body = rewriteManifest(fetched.body, proxyBase, session, mediaMode)
    session.rewritten = { key, contentType, body }
    return { contentType, body }
  })()
  rewrittenJobs.set(key, job)
  try {
    return await job
  } finally {
    rewrittenJobs.delete(key)
  }
}

export function proxyUrl(proxyBase: string, session: PlaySession): string {
  const ext = session.videoContainer === 'hls' ? 'm3u8' : 'mpd'
  return `${proxyBase}/v/${session.id}/manifest.${ext}`
}

/** First Shaka GET is always the clean MPD (prefetch cache hit). Hardsubs are a later reload. */
export function initialPlaybackUrl(proxyBase: string, _session: PlaySession, _preferredSub = 'en-US'): string {
  return proxyUrl(proxyBase, _session)
}
