import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({
  browserURL: process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223',
  defaultViewport: null,
})
const pages = await browser.pages()
const page = pages.find((candidate) => candidate.url().includes('localhost:1420')) ?? pages[0]
if (!page) throw new Error('no Izumi page')

await page.bringToFront()
await page.waitForFunction(() => {
  const video = document.querySelector('video')
  const drm = typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null
  return !!video && video.readyState >= 3 && drm?.firstFrame && !drm?.error
}, { timeout: 30_000, polling: 50 })

const before = await page.evaluate(() => ({
  drm: typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null,
  tracks: typeof window.__izumiDrmTracks === 'function' ? window.__izumiDrmTracks() : [],
}))
const target = before.tracks.find((track) => track.type === 'audio' && !track.selected && track.lang === 'en-US')
  ?? before.tracks.find((track) => track.type === 'audio' && !track.selected)
if (!target) throw new Error('no alternate Crunchyroll audio version is available')

await page.mouse.move(640, 400)
await page.evaluate(() => {
  const trigger = document.querySelector('button[aria-label="Subtitle and audio tracks"]')
  if (trigger?.parentElement?.querySelectorAll('button').length > 1) trigger.click()
})
await new Promise((resolve) => setTimeout(resolve, 100))
await page.click('button[aria-label="Subtitle and audio tracks"]')
await page.waitForFunction(() => {
  const trigger = document.querySelector('button[aria-label="Subtitle and audio tracks"]')
  return [...(trigger?.parentElement?.querySelectorAll('button') ?? [])].some((button) =>
    button !== trigger && button.textContent?.trim().startsWith('Audio'),
  )
}, { timeout: 3_000 })
await page.evaluate(() => {
  const trigger = document.querySelector('button[aria-label="Subtitle and audio tracks"]')
  ;[...(trigger?.parentElement?.querySelectorAll('button') ?? [])].find((button) =>
    button !== trigger && button.textContent?.trim().startsWith('Audio'),
  )?.click()
})
await new Promise((resolve) => setTimeout(resolve, 300))

const menu = await page.evaluate((lang) => {
  const trigger = document.querySelector('button[aria-label="Subtitle and audio tracks"]')
  const buttons = [...(trigger?.parentElement?.querySelectorAll('button') ?? [])]
  const wanted = lang.toLowerCase().startsWith('en') ? /english/i : new RegExp(lang, 'i')
  const matches = buttons.filter((candidate) => candidate !== trigger && wanted.test(candidate.textContent ?? ''))
  const button = matches.find((candidate) => !/subtitles|closed captions|audio/i.test(candidate.textContent ?? ''))
    ?? matches.at(-1)
  button?.click()
  return {
    clicked: button?.textContent?.trim() ?? '',
    rows: buttons.map((candidate) => candidate.textContent?.trim() ?? '').filter(Boolean),
  }
}, target.lang)
if (!menu.clicked) throw new Error(`audio menu has no row for ${target.lang}: ${menu.rows.join(' | ')}`)
console.log('menu', JSON.stringify({ target: target.lang, ...menu }))

const started = performance.now()
await page.waitForFunction((lang) => {
  const video = document.querySelector('video')
  const drm = typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null
  const tracks = typeof window.__izumiDrmTracks === 'function' ? window.__izumiDrmTracks() : []
  return !!video && video.readyState >= 3 && drm?.firstFrame && !drm?.error
    && tracks.some((track) => track.type === 'audio' && track.lang === lang && track.selected)
}, { timeout: 20_000, polling: 50 }, target.lang)
const elapsedMs = Math.round(performance.now() - started)
const after = await page.evaluate(() => ({
  drm: typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null,
  tracks: typeof window.__izumiDrmTracks === 'function' ? window.__izumiDrmTracks() : [],
}))

console.log(JSON.stringify({ target: target.lang, menu, elapsedMs, before, after }, null, 2))
await browser.disconnect()
