import puppeteer from 'puppeteer-core'

const CDP = process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223'
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
const pages = await browser.pages()
const page = pages.find((p) => p.url().includes('localhost:1420') && p.url().includes('/app/')) ?? pages[0]
if (!page) throw new Error('no izumi page')

const hits = []
page.on('request', (req) => {
  if (req.url().includes('127.0.0.1:17871')) hits.push({ type: 'req', method: req.method(), url: req.url() })
})
page.on('response', async (res) => {
  if (!res.url().includes('127.0.0.1:17871')) return
  let body = ''
  try { body = (await res.text()).slice(0, 180) } catch { body = '(unreadable)' }
  hits.push({ type: 'res', status: res.status(), url: res.url(), body })
})

console.log('on', await page.url())
await page.goto('http://localhost:1420/app/settings/extensions', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await new Promise((r) => setTimeout(r, 4000))
const settingsText = await page.evaluate(() => document.body.innerText.slice(0, 4000))
console.log('--- settings text ---')
console.log(settingsText)
console.log('--- 17871 traffic after settings ---')
console.log(hits)

await page.goto('http://localhost:1420/app/anime/21459', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await new Promise((r) => setTimeout(r, 5000))
const clicked = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
  const ep = buttons.find((el) => /^(1|01|E1|Episode 1)$/i.test((el.textContent || '').trim()))
    || [...document.querySelectorAll('[data-episode], .episode, [class*="episode"]')].find((el) => (el.textContent || '').includes('1'))
  if (ep) {
    ep.click()
    return { clicked: true, text: (ep.textContent || '').trim().slice(0, 80) }
  }
  const labels = buttons.slice(0, 40).map((el) => (el.textContent || '').trim().slice(0, 40)).filter(Boolean)
  return { clicked: false, labels }
})
console.log('click', clicked)
await new Promise((r) => setTimeout(r, 8000))
console.log('--- 17871 traffic after episode ---')
console.log(hits)
const picker = await page.evaluate(() => document.body.innerText.slice(0, 5000))
console.log('--- page text ---')
console.log(picker)
await browser.disconnect()
