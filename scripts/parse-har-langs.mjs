import { createReadStream } from 'node:fs'

const path = process.argv[2] || 'C:/Users/Student/Downloads/www.crunchyroll2.com.har'
const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 })
const interesting = [
  'audio_languages.json',
  'timed_text_languages.json',
  'accounts/v1/me',
  'preferred_content',
  'playback/v3/',
  '/tv/samsung/play',
  'hardSubs',
  'audio_locale',
]
let buf = ''
let n = 0
const seen = new Set()

function scan(chunk) {
  for (const key of interesting) {
    let from = 0
    while (true) {
      const i = chunk.indexOf(key, from)
      if (i < 0) break
      from = i + key.length
      const slice = chunk.slice(Math.max(0, i - 120), i + 800)
      const line = slice.replace(/\s+/g, ' ').slice(0, 500)
      const sig = key + ':' + line.slice(0, 160)
      if (seen.has(sig)) continue
      seen.add(sig)
      n++
      console.log(`--- ${key} ---`)
      console.log(line)
      if (n > 80) return true
    }
  }
  return false
}

stream.on('data', (chunk) => {
  buf += chunk
  if (buf.length > 4_000_000) buf = buf.slice(-1_500_000)
  if (scan(buf)) stream.destroy()
})
stream.on('end', () => console.log('done matches', n, 'unique', seen.size))
stream.on('close', () => console.log('close matches', n))
