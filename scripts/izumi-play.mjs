import puppeteer from 'puppeteer-core'

const CDP = process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223'
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
const page = (await browser.pages()).find((p) => p.url().includes('localhost:1420'))
if (!page) throw new Error('no page')

await page.goto('http://localhost:1420/app/anime/21459', { waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => {})
await page.waitForSelector('[title="Play episode 1"], [title^="Play —"]', { timeout: 20_000 })
const title = await page.$eval(
  '[title="Play episode 1"], [title^="Play —"]',
  (el) => el.getAttribute('title'),
)
console.log('clicking', title)
await page.click('[title="Play episode 1"], [title^="Play —"]')
await new Promise((r) => setTimeout(r, 15000))
const text = await page.evaluate(() => document.body.innerText)
console.log(text.slice(0, 7000))
console.log('url', await page.url())
await browser.disconnect()
