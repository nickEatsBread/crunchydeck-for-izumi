import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({
  browserURL: process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223',
  defaultViewport: null,
})
const page = (await browser.pages()).find((candidate) => candidate.url().includes('localhost:1420'))
if (!page) throw new Error('no izumi page')

await page.keyboard.press('Escape')
await new Promise((resolve) => setTimeout(resolve, 500))
await page.goto('http://localhost:1420/app/anime/21459', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.waitForSelector('[title^="Play —"], [title^="Play episode"]', { timeout: 20_000 })

await page.evaluate(() => {
  performance.clearResourceTimings()
  window.__izumiFastStart = performance.now()
})
await page.click('[title^="Play —"], [title^="Play episode"]')

// A remembered source resumes directly. On a clean profile, select the
// Crunchyroll row without adding a fixed sleep to the timing result.
await Promise.race([
  page.waitForFunction(() => window.__izumiDrm?.()?.firstFrame, { timeout: 30_000, polling: 25 }),
  page.waitForFunction(() => [...document.querySelectorAll('[role="button"],button')]
    .some((candidate) => /crunchyroll/i.test(candidate.textContent || '')), { timeout: 12_000, polling: 50 })
    .then(() => page.evaluate(() => [...document.querySelectorAll('[role="button"],button')]
      .find((candidate) => /crunchyroll/i.test(candidate.textContent || ''))?.click())),
])
await page.waitForFunction(() => window.__izumiDrm?.()?.firstFrame, { timeout: 30_000, polling: 25 })

const result = await page.evaluate(() => ({
  elapsedMs: Math.round(performance.now() - window.__izumiFastStart),
  drm: window.__izumiDrm?.(),
  resources: performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('127.0.0.1:17871/v/'))
    .map((entry) => ({
      name: entry.name.replace(/.*\/v\/[^/]+\//, '').replace(/\?.*/, ''),
      start: Math.round(entry.startTime - window.__izumiFastStart),
      duration: Math.round(entry.duration),
    })),
}))
console.log(JSON.stringify(result, null, 2))
await browser.disconnect()
