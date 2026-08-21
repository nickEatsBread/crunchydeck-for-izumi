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
  return !!video && video.readyState >= 3 && video.videoWidth > 0 && drm?.firstFrame && !drm?.error
}, { timeout: 30_000, polling: 50 })

const state = () => page.evaluate(() => {
  const video = document.querySelector('video')
  return video ? {
    paused: video.paused,
    muted: video.muted,
    volume: video.volume,
    time: video.currentTime,
    duration: video.duration,
    readyState: video.readyState,
  } : null
})

await page.mouse.move(640, 400)
await page.waitForSelector('button[aria-label="Pause"]', { visible: true, timeout: 5_000 })
const initial = await state()

await page.click('button[aria-label="Pause"]')
await page.waitForFunction(() => document.querySelector('video')?.paused, { timeout: 3_000 })
const paused = await state()

await page.click('button[aria-label="Play"]')
await page.waitForFunction(() => !document.querySelector('video')?.paused, { timeout: 3_000 })
await new Promise((resolve) => setTimeout(resolve, 350))
const resumed = await state()

await page.click(`button[aria-label="${resumed?.muted ? 'Unmute' : 'Mute'}"]`)
await page.waitForFunction(
  (wasMuted) => document.querySelector('video')?.muted !== wasMuted,
  { timeout: 3_000 },
  resumed?.muted,
)
const toggledMute = await state()
await page.click(`button[aria-label="${toggledMute?.muted ? 'Unmute' : 'Mute'}"]`)
await page.waitForFunction(
  (target) => document.querySelector('video')?.muted === target,
  { timeout: 3_000 },
  resumed?.muted,
)

const seek = await page.$('[role="slider"][aria-label="Seek"]')
if (!seek) throw new Error('seek control is missing')
const box = await seek.boundingBox()
if (!box) throw new Error('seek control has no layout box')
const targetRatio = (initial?.time ?? 0) > (initial?.duration ?? 1) * 0.55 ? 0.25 : 0.7
await page.mouse.click(box.x + box.width * targetRatio, box.y + box.height / 2)
const targetTime = (initial?.duration ?? 0) * targetRatio
await page.waitForFunction(
  (target) => {
    const video = document.querySelector('video')
    return !!video && video.readyState >= 3 && Math.abs(video.currentTime - target) < 6
  },
  { timeout: 8_000, polling: 25 },
  targetTime,
)
const sought = await state()

console.log(JSON.stringify({ initial, paused, resumed, toggledMute, targetTime, sought }, null, 2))
await browser.disconnect()

if (!initial || !paused || !resumed || !toggledMute || !sought) throw new Error('missing player state')
if (!paused.paused || resumed.paused || resumed.time <= paused.time) throw new Error('play/pause control did not reach Shaka')
if (toggledMute.muted === resumed.muted) throw new Error('mute control did not reach Shaka')
if (Math.abs(sought.time - targetTime) >= 6 || sought.readyState < 3) throw new Error('seek control did not reach a playable Shaka frame')
