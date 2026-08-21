import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({
  browserURL: process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223',
  defaultViewport: null,
})
const pages = await browser.pages()
const page = pages.find((candidate) => candidate.url().includes('localhost:1420')) ?? pages[0]
if (!page) throw new Error('no izumi page')

await page.waitForFunction(() => {
  const video = document.querySelector('video')
  const drm = typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null
  return !!video && video.readyState >= 3 && drm?.firstFrame && drm.dur > 0 && !drm.error
}, { timeout: 30_000, polling: 50 })

const target = await page.evaluate(() => {
  const video = document.querySelector('video')
  performance.clearResourceTimings()
  window.__izumiSeekStarted = performance.now()
  window.__izumiSeekEvents = []
  const record = (name) => window.__izumiSeekEvents.push({
    name,
    at: Math.round(performance.now() - window.__izumiSeekStarted),
    time: Number(video.currentTime.toFixed(3)),
    readyState: video.readyState,
  })
  for (const name of ['seeking', 'seeked', 'waiting', 'canplay', 'playing']) {
    video.addEventListener(name, () => record(name), { once: true })
  }
  const next = Math.min(video.duration - 30, video.currentTime + 300)
  video.currentTime = next
  return next
})

await page.waitForFunction((wanted) => {
  const video = document.querySelector('video')
  return !!video && Math.abs(video.currentTime - wanted) < 3 && video.readyState >= 3 && !video.seeking
}, { timeout: 20_000, polling: 25 }, target)
await new Promise((resolve) => setTimeout(resolve, 750))

const result = await page.evaluate(() => ({
  elapsedMs: Math.round(performance.now() - window.__izumiSeekStarted),
  events: window.__izumiSeekEvents,
  drm: typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null,
  resources: performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('127.0.0.1:17871/v/'))
    .map((entry) => ({
      name: entry.name.replace(/.*\/v\/[^/]+\//, '').replace(/\?.*/, ''),
      start: Math.round(entry.startTime - window.__izumiSeekStarted),
      duration: Math.round(entry.duration),
    })),
}))
console.log(JSON.stringify(result, null, 2))
await browser.disconnect()
