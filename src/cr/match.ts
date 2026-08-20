const NOISE = new Set([
  'a', 'an', 'and', 'at', 'dub', 'dubbed', 'eng', 'english', 'for', 'in', 'jpn', 'japanese',
  'no', 'of', 'on', 'or', 'sub', 'subbed', 'the', 'to', 'tv', 'wa',
])

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function titleWords(value: string): string[] {
  return normalizeTitle(value)
    .split(' ')
    .filter((word) => word && !NOISE.has(word) && word.length > 1)
}

const ORDINAL: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  final: 99,
}

/** Season number encoded in a title, if any. Season 1 is often unlabelled. */
export function seasonFromTitle(title: string): number | undefined {
  const text = title.normalize('NFKD')
  const patterns = [
    /\bseason\s*(\d{1,2})\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/i,
    /\bs(\d{1,2})\b/i,
    /\bpart\s*(\d{1,2})\b/i,
    /\bcour\s*(\d{1,2})\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return Number(match[1])
  }
  const named = text.toLowerCase().match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|final)\s+season\b/)
  if (named?.[1] && ORDINAL[named[1]] != null) return ORDINAL[named[1]]
  const trailing = text.match(/\s(\d{1,2})$/)
  if (trailing?.[1]) {
    const n = Number(trailing[1])
    if (n >= 2 && n <= 40) return n
  }
  return undefined
}

export function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/**
 * Title variants Izumi's searchTitleScore can match. Season 1 MUST NOT include
 * "Season 1" — that marker would make the AniList base title fail the asymmetric
 * marker check. Later seasons MUST include the number so they do not steal S1.
 */
export function seasonTitleVariants(seriesTitle: string, seasonNumber: number, seasonTitle?: string): string[] {
  const series = seriesTitle.trim()
  const out = new Set<string>()
  if (seasonNumber <= 1) {
    out.add(series)
    if (seasonTitle && !/^season\s*\d+/i.test(seasonTitle) && !/^final season$/i.test(seasonTitle)) {
      if (normalizeTitle(seasonTitle) !== normalizeTitle(series)) out.add(`${series} ${seasonTitle}`)
    }
    return [...out]
  }
  out.add(`${series} Season ${seasonNumber}`)
  out.add(`${series} ${ordinal(seasonNumber)} Season`)
  out.add(`${series} ${seasonNumber}`)
  out.add(`${series} S${seasonNumber}`)
  if (seasonTitle && normalizeTitle(seasonTitle) !== normalizeTitle(`season ${seasonNumber}`)) {
    out.add(`${series} ${seasonTitle}`)
  }
  return [...out]
}

export function pickVersionGuid(
  versions: Array<{ audio_locale?: string; guid?: string; original?: boolean }> | undefined,
  fallbackId: string,
  audioLocale: string,
): string {
  if (!versions?.length) return fallbackId
  const exact = versions.find((v) => v.audio_locale === audioLocale && v.guid)
  if (exact?.guid) return exact.guid
  if (audioLocale === 'ja-JP') {
    const original = versions.find((v) => v.original && v.guid)
    if (original?.guid) return original.guid
  }
  const prefix = audioLocale.split('-')[0]
  const lang = versions.find((v) => v.audio_locale?.startsWith(`${prefix}-`) && v.guid)
  return lang?.guid ?? fallbackId
}

export function parseMediaId(id: string): { seriesId: string; seasonId: string; audio: string } {
  const [seriesId, seasonId, audio] = id.split('|')
  if (!seriesId || !seasonId) throw new Error('invalid Crunchyroll media id')
  return { seriesId, seasonId, audio: audio || 'ja-JP' }
}

export function makeMediaId(seriesId: string, seasonId: string, audio: string): string {
  return `${seriesId}|${seasonId}|${audio}`
}

export function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined
  const match = date.match(/^(\d{4})/)
  return match ? Number(match[1]) : undefined
}

export function yearMatches(wanted: number | undefined, candidate: number | undefined): boolean {
  if (wanted == null || candidate == null) return true
  return Math.abs(wanted - candidate) <= 1
}
