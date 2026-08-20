import puppeteer from 'puppeteer-core'

const CDP = process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223'
const MANIFEST = 'http://127.0.0.1:17871/index.json'
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
const page = (await browser.pages()).find((p) => p.url().includes('localhost:1420'))
if (!page) throw new Error('no page')

const backup = await page.evaluate((manifest) => {
  const read = (k) => localStorage.getItem(k)
  const backup = {
    addons: read('stremio-addon-urls'),
    extensions: read('extension-urls'),
    disabled: read('disabled-extensions'),
  }
  localStorage.setItem('stremio-addon-urls', '[]')
  localStorage.setItem('extension-urls', JSON.stringify([manifest]))
  localStorage.setItem('disabled-extensions', '[]')
  return backup
}, MANIFEST)
console.log('backup sizes', {
  addons: backup.addons?.length,
  extensions: backup.extensions?.length,
})

await page.reload({ waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 3000))
await page.goto('http://localhost:1420/app/anime/21459', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.waitForSelector('[title="Play episode 1"], [title^="Play —"]', { timeout: 20_000 })
await page.click('[title="Play episode 1"], [title^="Play —"]')
await new Promise((r) => setTimeout(r, 18000))
const text = await page.evaluate(() => document.body.innerText)
console.log(text.slice(0, 8000))
console.log('url', await page.url())

await page.evaluate((backup) => {
  if (backup.addons != null) localStorage.setItem('stremio-addon-urls', backup.addons)
  if (backup.extensions != null) localStorage.setItem('extension-urls', backup.extensions)
  if (backup.disabled != null) localStorage.setItem('disabled-extensions', backup.disabled)
}, backup)
await browser.disconnect()
