// The fonts Crunchyroll's ASS subtitles are written for. Crunchyroll's players load them from its
// static host by family name instead of attaching them to the subtitle file, so a player that only
// gets the .ass falls back to some other face. The source lists them on each stream
// (`subtitleFonts`), serves them under the play session, and keeps a copy on disk so each file is
// downloaded once.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOSTS } from './constants.js'
import { dataDir } from '../storage.js'

const FONT_ROOT = `${HOSTS.static}/vilos-v2/web/vilos/assets/libass-fonts/`

/** Family name (with its weight/style, as libass asks for it) → file on the font host. */
export const SUBTITLE_FONTS: Readonly<Record<string, string>> = {
  'Adobe Arabic': 'AdobeArabic-Bold.otf',
  'Andale Mono': 'andalemo.ttf',
  Arial: 'arial.ttf',
  'Arial Black': 'ariblk.ttf',
  'Arial Bold': 'arialbd.ttf',
  'Arial Bold Italic': 'arialbi.ttf',
  'Arial Italic': 'ariali.ttf',
  'Arial Unicode MS': 'arialuni.ttf',
  'Comic Sans MS': 'comic.ttf',
  'Comic Sans MS Bold': 'comicbd.ttf',
  'Courier New': 'cour.ttf',
  'Courier New Bold': 'courbd.ttf',
  'Courier New Bold Italic': 'courbi.ttf',
  'Courier New Italic': 'couri.ttf',
  'DejaVu LGC Sans Mono': 'DejaVuLGCSansMono.ttf',
  'DejaVu LGC Sans Mono Bold': 'DejaVuLGCSansMono-Bold.ttf',
  'DejaVu LGC Sans Mono Bold Oblique': 'DejaVuLGCSansMono-BoldOblique.ttf',
  'DejaVu LGC Sans Mono Oblique': 'DejaVuLGCSansMono-Oblique.ttf',
  'DejaVu Sans': 'DejaVuSans.ttf',
  'DejaVu Sans Bold': 'DejaVuSans-Bold.ttf',
  'DejaVu Sans Bold Oblique': 'DejaVuSans-BoldOblique.ttf',
  'DejaVu Sans Condensed': 'DejaVuSansCondensed.ttf',
  'DejaVu Sans Condensed Bold': 'DejaVuSansCondensed-Bold.ttf',
  'DejaVu Sans Condensed Bold Oblique': 'DejaVuSansCondensed-BoldOblique.ttf',
  'DejaVu Sans Condensed Oblique': 'DejaVuSansCondensed-Oblique.ttf',
  'DejaVu Sans ExtraLight': 'DejaVuSans-ExtraLight.ttf',
  'DejaVu Sans Mono': 'DejaVuSansMono.ttf',
  'DejaVu Sans Mono Bold': 'DejaVuSansMono-Bold.ttf',
  'DejaVu Sans Mono Bold Oblique': 'DejaVuSansMono-BoldOblique.ttf',
  'DejaVu Sans Mono Oblique': 'DejaVuSansMono-Oblique.ttf',
  'DejaVu Sans Oblique': 'DejaVuSans-Oblique.ttf',
  Gautami: 'gautami.ttf',
  Georgia: 'georgia.ttf',
  'Georgia Bold': 'georgiab.ttf',
  'Georgia Bold Italic': 'georgiaz.ttf',
  'Georgia Italic': 'georgiai.ttf',
  Impact: 'impact.ttf',
  'Meera Inimai': 'MeeraInimai-Regular.ttf',
  Mangal: 'MANGAL.TTF',
  'Noto Sans Thai': 'NotoSansThai.ttf',
  'Noto Sans Telugu': 'NotoSansTeluguVariable.ttf',
  'Noto Sans Tamil': 'NotoSansTamilVariable.ttf',
  Rubik: 'Rubik-Regular.ttf',
  'Rubik Black': 'Rubik-Black.ttf',
  'Rubik Black Italic': 'Rubik-BlackItalic.ttf',
  'Rubik Bold': 'Rubik-Bold.ttf',
  'Rubik Bold Italic': 'Rubik-BoldItalic.ttf',
  'Rubik Italic': 'Rubik-Italic.ttf',
  'Rubik Light': 'Rubik-Light.ttf',
  'Rubik Light Italic': 'Rubik-LightItalic.ttf',
  'Rubik Medium': 'Rubik-Medium.ttf',
  'Rubik Medium Italic': 'Rubik-MediumItalic.ttf',
  Tahoma: 'tahoma.ttf',
  'Times New Roman': 'times.ttf',
  'Times New Roman Bold': 'timesbd.ttf',
  'Times New Roman Bold Italic': 'timesbi.ttf',
  'Times New Roman Italic': 'timesi.ttf',
  'Trebuchet MS': 'trebuc.ttf',
  'Trebuchet MS Bold': 'trebucbd.ttf',
  'Trebuchet MS Bold Italic': 'trebucbi.ttf',
  'Trebuchet MS Italic': 'trebucit.ttf',
  Verdana: 'verdana.ttf',
  'Verdana Bold': 'verdanab.ttf',
  'Verdana Bold Italic': 'verdanaz.ttf',
  'Verdana Italic': 'verdanai.ttf',
  Vrinda: 'vrinda.ttf',
  'Vrinda Bold': 'vrindab.ttf',
  Webdings: 'webdings.ttf',
}

const FILES = new Set(Object.values(SUBTITLE_FONTS))
/** The largest file in the set (Arial Unicode MS) is about 23 MB. */
const MAX_FONT_BYTES = 40 * 1024 * 1024

/** The stream's font list: every family, served from the play session at `sessionBase`. */
export function subtitleFonts(sessionBase: string): Array<{ family: string; url: string }> {
  return Object.entries(SUBTITLE_FONTS).map(([family, file]) => ({ family, url: `${sessionBase}/fonts/${file}` }))
}

export function isSubtitleFont(file: string): boolean {
  return FILES.has(file)
}

export function fontContentType(file: string): string {
  return /\.otf$/i.test(file) ? 'font/otf' : 'font/ttf'
}

/** TrueType, OpenType, TrueType collection or WOFF/WOFF2: anything else is an error page. */
export function looksLikeFont(body: Uint8Array): boolean {
  if (body.length < 12) return false
  const tag = String.fromCharCode(body[0]!, body[1]!, body[2]!, body[3]!)
  return tag === '\x00\x01\x00\x00' || tag === 'OTTO' || tag === 'true' || tag === 'ttcf' || tag === 'wOFF' || tag === 'wOF2'
}

const pending = new Map<string, Promise<Buffer>>()
/** A file the host would not give is not asked for again on every request for a while. */
const failed = new Map<string, number>()
const RETRY_AFTER_MS = 10 * 60_000

/** One font file: from the disk cache, or downloaded once from the font host and kept. */
export function subtitleFont(file: string, fetcher: typeof fetch = fetch, root = join(dataDir(), 'fonts')): Promise<Buffer> {
  if (!isSubtitleFont(file)) return Promise.reject(new Error(`unknown subtitle font ${file}`))
  const path = join(root, file)
  try {
    return Promise.resolve(readFileSync(path))
  } catch { /* not cached yet */ }
  const running = pending.get(path)
  if (running) return running
  const failedAt = failed.get(path)
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) {
    return Promise.reject(new Error(`font host failed recently for ${file}`))
  }
  const job = (async () => {
    const res = await fetcher(FONT_ROOT + encodeURIComponent(file), { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`font host answered HTTP ${res.status} for ${file}`)
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > MAX_FONT_BYTES || !looksLikeFont(body)) throw new Error(`font host sent something that is not a font for ${file}`)
    mkdirSync(root, { recursive: true })
    const partial = `${path}.part`
    writeFileSync(partial, body)
    renameSync(partial, path)
    return body
  })()
    .catch((error: unknown) => {
      failed.set(path, Date.now())
      throw error
    })
    .finally(() => pending.delete(path))
  pending.set(path, job)
  return job
}
