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

async function openOptions() {
  await page.mouse.move(640, 400)
  const auto = await page.$('button[aria-label="Video quality Auto"]')
  if (!auto) await page.click('button[aria-label="Playback options"]')
  await page.waitForSelector('button[aria-label="Video quality Auto"]', { visible: true, timeout: 5_000 })
}

await openOptions()
const detected = await page.$$eval('button[aria-label^="Video quality "]', (buttons) =>
  buttons.map((button) => button.getAttribute('aria-label') ?? ''),
)
const targetLabel = detected.includes('Video quality 720p')
  ? 'Video quality 720p'
  : detected.find((label) => /\d+p$/.test(label))
if (!targetLabel) throw new Error(`no fixed Shaka quality was detected: ${detected.join(', ')}`)
const targetHeight = Number(targetLabel.match(/(\d+)p$/)?.[1])

await page.click(`button[aria-label="${targetLabel}"]`)
await page.waitForFunction((height) => {
  const video = document.querySelector('video')
  return video?.videoHeight === height && video.readyState >= 3
}, { timeout: 30_000, polling: 50 }, targetHeight)
const fixed = await page.evaluate(() => ({
  width: document.querySelector('video')?.videoWidth,
  height: document.querySelector('video')?.videoHeight,
  paused: document.querySelector('video')?.paused,
}))

await openOptions()
await page.waitForFunction((height) =>
  document.querySelector(`button[aria-label="Video quality ${height}p"]`)?.className.includes('bg-primary'),
{ timeout: 3_000 }, targetHeight)
await page.click('button[aria-label="Video quality Auto"]')
await page.waitForFunction(() =>
  document.querySelector('button[aria-label="Video quality Auto"]')?.className.includes('bg-primary'),
{ timeout: 3_000 })
const automatic = await page.evaluate(() => ({
  width: document.querySelector('video')?.videoWidth,
  height: document.querySelector('video')?.videoHeight,
  paused: document.querySelector('video')?.paused,
}))

console.log(JSON.stringify({ detected, targetHeight, fixed, automatic }, null, 2))
await browser.disconnect()
