import { createReadStream } from 'node:fs'

const path = process.argv[2] || 'C:/Users/Student/Downloads/www.crunchyroll2.com.har'
const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 })
let buf = ''
let found = 0

function tryExtract(slice, urlMatch) {
  const m = slice.match(/"text"\s*:\s*"/)
  if (!m) return
  let p = m.index + m[0].length
  let out = ''
  let esc = false
  for (; p < slice.length; p++) {
    const c = slice[p]
    if (esc) { out += c; esc = false; continue }
    if (c === '\\') { esc = true; out += c; continue }
    if (c === '"') break
    out += c
  }
  let json
  try { json = JSON.parse(JSON.parse(`"${out.slice(0, 250000)}"`)) }
  catch { return }
  const keys = Object.keys(json)
  const sub = json.subtitles
  const cap = json.captions
  const subKeys = sub ? (Array.isArray(sub) ? `array:${sub.length}` : Object.keys(sub).join(',')) : 'none'
  const capKeys = cap ? (Array.isArray(cap) ? `array:${cap.length}` : Object.keys(cap).join(',')) : 'none'
  const hard = json.hardSubs ? Object.keys(json.hardSubs).join(',') : 'none'
  console.log(`PLAY ${urlMatch}`)
  console.log(`  audio=${json.audioLocale} url=${String(json.url || '').slice(0, 120)}`)
  console.log(`  keys=${keys.join(',')}`)
  console.log(`  subs=${subKeys}`)
  console.log(`  caps=${capKeys}`)
  console.log(`  hard=${hard}`)
  const sample = Array.isArray(sub) ? sub[0] : sub && typeof sub === 'object' ? Object.values(sub)[0] : null
  if (sample) console.log(`  subSample=${JSON.stringify(sample).slice(0, 400)}`)
  const capSample = Array.isArray(cap) ? cap[0] : cap && typeof cap === 'object' ? Object.values(cap)[0] : null
  if (capSample) console.log(`  capSample=${JSON.stringify(capSample).slice(0, 400)}`)
  found++
}

stream.on('data', (chunk) => {
  buf += chunk
  const marker = 'playback/v3/'
  let i
  while ((i = buf.indexOf(marker)) >= 0) {
    const slice = buf.slice(Math.max(0, i - 80), i + 500000)
    const urlMatch = slice.match(/playback\/v3\/[A-Z0-9]+\/web\/chrome\/play/)
    if (urlMatch) tryExtract(slice, urlMatch[0])
    buf = buf.slice(i + marker.length)
    if (found >= 4) { stream.destroy(); return }
    if (buf.length > 2_000_000) buf = buf.slice(-600_000)
  }
  if (buf.length > 2_000_000) buf = buf.slice(-800_000)
})
stream.on('end', () => console.log('done found', found))
stream.on('close', () => console.log('close found', found))
