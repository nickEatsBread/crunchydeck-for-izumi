import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({ browserURL: process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223', defaultViewport: null })
const pages = await browser.pages()
const page = pages.find((candidate) => candidate.url().includes('localhost:1420')) ?? pages[0]
if (!page) throw new Error('no izumi page')
await page.bringToFront()

if (!page.url().includes('/app/anime/21459')) {
  await page.goto('http://localhost:1420/app/anime/21459', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 2_000))
}

if (!(await page.evaluate(() => !!document.querySelector('video')))) {
  await page.evaluate(() => document.querySelector('[title^="Play —"], [title^="Play episode"]')?.click())
  await new Promise((resolve) => setTimeout(resolve, 3_000))
} else {
  await page.mouse.move(640, 400)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find((candidate) => candidate.getAttribute('aria-label') === 'Playback options')?.click())
  await new Promise((resolve) => setTimeout(resolve, 150))
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find((candidate) => /change source/i.test(candidate.textContent || ''))?.click())
  await new Promise((resolve) => setTimeout(resolve, 2_000))
}

await page.evaluate(() => {
  performance.clearResourceTimings()
  window.__izumiStartupDurations = []
  window.__izumiStartupStarted = performance.now()
  const watch = (video) => {
    if (video.dataset.startupWatched) return
    video.dataset.startupWatched = '1'
    const sample = () => window.__izumiStartupDurations.push({
      at: Math.round(performance.now() - window.__izumiStartupStarted),
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      readyState: video.readyState,
    })
    video.addEventListener('durationchange', sample)
    video.addEventListener('loadedmetadata', sample)
    video.addEventListener('canplay', sample)
    sample()
  }
  document.querySelectorAll('video').forEach(watch)
  new MutationObserver(() => document.querySelectorAll('video').forEach(watch))
    .observe(document.documentElement, { childList: true, subtree: true })
})

await page.waitForFunction(() => [...document.querySelectorAll('[role="button"],button')]
  .some((candidate) => (candidate.textContent || '').includes('⚡') && /crunchyroll/i.test(candidate.textContent || '')),
{ timeout: 15_000, polling: 100 })
await page.evaluate(() => [...document.querySelectorAll('[role="button"],button')]
  .find((candidate) => (candidate.textContent || '').includes('⚡') && /crunchyroll/i.test(candidate.textContent || ''))?.click())

await page.waitForFunction(() => {
  const drm = typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null
  const loadedNewManifest = performance.getEntriesByType('resource')
    .some((entry) => entry.name.includes('127.0.0.1:17871/v/') && entry.name.includes('/manifest.'))
  return loadedNewManifest && drm?.firstFrame && drm.dur > 0 && !drm.error
}, { timeout: 30_000, polling: 50 })
await new Promise((resolve) => setTimeout(resolve, 1_000))

const result = await page.evaluate(() => ({
  elapsedMs: Math.round(performance.now() - window.__izumiStartupStarted),
  durations: window.__izumiStartupDurations,
  drm: typeof window.__izumiDrm === 'function' ? window.__izumiDrm() : null,
  resources: performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('127.0.0.1:17871/v/'))
    .map((entry) => ({
      name: entry.name.replace(/.*\/v\/[^/]+\//, ''),
      start: Math.round(entry.startTime - window.__izumiStartupStarted),
      duration: Math.round(entry.duration),
      transfer: entry.transferSize,
    })),
}))
console.log(JSON.stringify(result, null, 2))
await browser.disconnect()
