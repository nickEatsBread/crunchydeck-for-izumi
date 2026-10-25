import { CrunchyrollApp } from './app.js'
import { DEFAULT_PORT } from './cr/constants.js'
import { listen } from './server.js'

export async function start(): Promise<void> {
const managed = !!process.env.IZUMI_EXTENSION_PORT
const port = Number(process.env.IZUMI_EXTENSION_PORT ?? process.env.CR_SOURCE_PORT) || DEFAULT_PORT
if (managed) {
  process.env.CR_SOURCE_HOST = '127.0.0.1'
  if (process.env.IZUMI_EXTENSION_DATA_DIR) process.env.CR_SOURCE_DATA = process.env.IZUMI_EXTENSION_DATA_DIR
}

const app = await CrunchyrollApp.create()
let server: Awaited<ReturnType<typeof listen>>
let shuttingDown = false

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.close().catch(() => {})
  await app.close().catch(() => {})
  process.exit(0)
}
server = await listen(app, port, managed ? () => void shutdown() : undefined)
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('uncaughtException', (error) => {
  console.error('[cr] uncaught', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[cr] unhandledRejection', reason)
})

console.log(`Crunchyroll source for Izumi`)
console.log(`  config   ${app.baseUrl}/`)
console.log(`  manifest ${app.baseUrl}/index.json`)
if (app.shareBaseUrl) {
  console.log(`  Android  ${app.shareBaseUrl}/index.json`)
  console.log('  (LAN playback URL; bearer capability, share only with trusted devices/rooms)')
}
if (!app.status().authenticated) {
  console.log('  not signed in — open the config page and add your Crunchyroll account')
} else {
  console.log(`  signed in (${app.status().profile} client)`)
}
}

if (!process.env.IZUMI_EMBEDDED_ENTRY) await start()
