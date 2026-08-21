import { CrunchyrollApp } from './app.js'
import { DEFAULT_PORT } from './cr/constants.js'
import { listen } from './server.js'

const port = Number(process.env.CR_SOURCE_PORT) || DEFAULT_PORT

const app = await CrunchyrollApp.create()
const server = await listen(app, port)

const shutdown = async () => {
  await server.close().catch(() => {})
  await app.close().catch(() => {})
  process.exit(0)
}
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
