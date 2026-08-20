import puppeteer from 'puppeteer-core'

const MANIFEST = 'http://127.0.0.1:17871/index.json'
const CDP = process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223'

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
const pages = await browser.pages()
const page = pages.find((p) => p.url().includes('localhost:1420')) ?? pages[0]
if (!page) throw new Error('no izumi page')

const snapshot = await page.evaluate(() => {
  const keys = []
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i))
  const pick = {}
  for (const key of keys) {
    if (/extension|addon|source/i.test(key || '')) pick[key] = localStorage.getItem(key)
  }
  return { url: location.href, keys, pick }
})
console.log('page', snapshot.url)
console.log('source keys', snapshot.pick)

const result = await page.evaluate((manifest) => {
  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return localStorage.getItem(key) }
  }
  const writeList = (key, list) => localStorage.setItem(key, JSON.stringify(list))
  const candidates = ['extension-urls', 'extensions', 'extensionUrls']
  let key = candidates.find((k) => localStorage.getItem(k) != null) || 'extension-urls'
  let list = read(key)
  if (!Array.isArray(list)) list = []
  if (!list.includes(manifest)) list.push(manifest)
  writeList(key, list)
  return { key, list }
}, MANIFEST)
console.log('updated', result)

await page.reload({ waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 2500))
console.log('reloaded', await page.url())
await browser.disconnect()
