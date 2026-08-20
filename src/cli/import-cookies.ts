import { readFileSync } from 'node:fs'
import { CrunchyrollApp } from '../app.js'

function parseEtpRt(path: string): string {
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const domain = parts[0] ?? ''
    const name = parts[5] ?? ''
    const value = parts[6] ?? ''
    if (domain.toLowerCase().includes('crunchyroll') && name === 'etp_rt' && value) return value
  }
  throw new Error(`No etp_rt Crunchyroll cookie in ${path}`)
}

const path = process.argv[2] ?? process.env.CR_COOKIES_FILE
if (!path) {
  console.error('Usage: npm run import-cookies -- <netscape-cookies.txt>')
  process.exit(1)
}

const etp = parseEtpRt(path)
const app = await CrunchyrollApp.create()
try {
  const status = await app.loginEtpRt(etp)
  console.log('signed in', {
    accountId: status.accountId,
    country: status.country,
    profile: status.profile,
    transport: status.transport,
  })
} finally {
  await app.close()
}
