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
export function rewriteManifest(xml: string, proxyBase: string, session: PlaySession): string {
  const bases = [...xml.matchAll(BASE_URL)].map((match) => match[1] ?? '')
  const cdnBase = bases.find((value) => /^https?:\/\//i.test(value))
  if (cdnBase) {
    session.cdnBase = cdnBase.endsWith('/') ? cdnBase : `${cdnBase}/`
  }
  const cdnProxy = `${proxyBase}/v/${session.id}/cdn/`
  let out = xml.replace(BASE_URL, `<BaseURL>${cdnProxy}</BaseURL>`)
  out = out.replace(ABSOLUTE_URL, (match) => {
    if (match.includes('/v/')) return match
    if (session.cdnBase && match.startsWith(session.cdnBase.replace(/\/$/, ''))) {
      return cdnProxy + match.slice(session.cdnBase.length)
    }
    return `${proxyBase}/v/${session.id}/asset?u=${encodeURIComponent(match)}`
  })
  return out
}

export function resolveCdnUrl(session: PlaySession, restPath: string, search: string): string | undefined {
  if (!session.cdnBase) return undefined
  const path = restPath.replace(/^\/+/, '')
  return `${session.cdnBase}${path}${search}`
}

export async function loadRewrittenManifest(
  play: PlayService,
  session: PlaySession,
  proxyBase: string,
): Promise<{ contentType: string; body: string }> {
  const fetched = await play.fetchManifest(session)
  return {
    contentType: fetched.contentType.includes('mpegurl') ? fetched.contentType : 'application/dash+xml',
    body: rewriteManifest(fetched.body, proxyBase, session),
  }
}

export function proxyUrl(proxyBase: string, session: PlaySession): string {
  const ext = session.videoContainer === 'hls' ? 'm3u8' : 'mpd'
  return `${proxyBase}/v/${session.id}/manifest.${ext}`
}
