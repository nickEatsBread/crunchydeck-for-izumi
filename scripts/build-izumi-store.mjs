// Writes izumi/store.json and izumi/pack.json: the izumi store that lists this source (one build per
// platform) and the Crunchy Deck theme, and the pack that sets izumi up with both, the intro video,
// protected playback and the sign-in step. Sizes and hashes come from the files themselves, so run
// it after building the packages (dist/crunchyroll-<platform>.izumi-ext).
//
//   IZUMI_REPO=owner/repo IZUMI_REF=main node scripts/build-izumi-store.mjs
//
// Hosting somewhere else (a test server, a mirror): IZUMI_BASE_URL is where the izumi/ files are
// served and IZUMI_PACKAGES_URL where the packages are (defaults: GitHub raw and the release).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'izumi')
const dist = join(root, 'dist')
const repo = process.env.IZUMI_REPO || 'nickEatsBread/crunchydeck-for-izumi'
const ref = process.env.IZUMI_REF || 'main'
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const raw = (process.env.IZUMI_BASE_URL || `https://raw.githubusercontent.com/${repo}/${ref}/izumi`).replace(/\/+$/, '')
const release = (process.env.IZUMI_PACKAGES_URL || `https://github.com/${repo}/releases/download/v${version}`).replace(/\/+$/, '')

const file = (path) => {
  const bytes = readFileSync(path)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

const builds = {}
for (const name of existsSync(dist) ? readdirSync(dist) : []) {
  const match = name.match(/^crunchyroll-((?:windows|linux|macos)-(?:x86_64|aarch64))\.izumi-ext$/)
  if (match) builds[match[1]] = { url: `${release}/${name}`, ...file(join(dist, name)) }
}
if (!Object.keys(builds).length) {
  console.error('No packages in dist/. Run scripts/build-izumi-service-package.mjs on each platform first.')
  process.exit(1)
}

// The theme's stylesheet is written in izumi/theme.css and folded into theme.json here, so the
// published theme.json (and its hash below) always carries the current stylesheet.
const theme = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'))
theme.design.css = readFileSync(join(dir, 'theme.css'), 'utf8')
writeFileSync(join(dir, 'theme.json'), `${JSON.stringify(theme, null, 2)}
`)
const store = {
  app: 'izumi',
  kind: 'store',
  schemaVersion: 1,
  id: 'crunchy-deck',
  name: 'CrunchyDeck for izumi',
  description: 'The Crunchyroll source for izumi and its matching theme, inspired by Crunchy Deck.',
  homepage: `https://github.com/${repo}`,
  icon: `${raw}/icon.svg`,
  entries: [
    {
      kind: 'source',
      sourceType: 'package',
      backend: 'izumi-service',
      id: 'crunchyroll.izumi',
      name: 'Crunchyroll',
      version,
      description: 'Your Crunchyroll account as an izumi source: search, episodes, dubs and subtitles. Needs a Crunchyroll account.',
      icon: `${raw}/icon.svg`,
      homepage: `https://github.com/${repo}`,
      languages: ['en'],
      content: ['anime'],
      builds,
    },
    {
      kind: 'theme',
      id: theme.id,
      name: theme.name,
      version: theme.version,
      author: theme.author,
      description: theme.description,
      themeApi: theme.themeApi,
      tags: ['Dark', 'Drawer'],
      platforms: ['desktop', 'phone'],
      url: `${raw}/theme.json`,
      ...file(join(dir, 'theme.json')),
    },
  ],
}

const intro = file(join(dir, 'intro.mp4'))
const pack = {
  app: 'izumi',
  kind: 'pack',
  schemaVersion: 1,
  id: 'crunchy-deck',
  name: 'CrunchyDeck for izumi',
  version,
  author: 'nickEatsBread',
  description: 'Watch Crunchyroll in izumi: your Crunchyroll account as a source, a Crunchyroll-orange look, the Crunchyroll intro at start-up, and protected playback on Linux and the Steam Deck. Needs a Crunchyroll account. Inspired by Crunchy Deck.',
  icon: `${raw}/icon.svg`,
  homepage: `https://github.com/${repo}`,
  minAppVersion: '0.1.77',
  stores: [{ url: `${raw}/store.json` }],
  items: [
    // The source's own catalog becomes a screen, and izumi opens on it.
    { ref: 'source', kind: 'source', from: { store: `${raw}/store.json`, id: 'crunchyroll.izumi' }, screen: 'default' },
    { ref: 'look', kind: 'theme', from: { store: `${raw}/store.json`, id: theme.id }, apply: true },
  ],
  // izumi downloads Google's Widevine module in the background where it is needed (Linux); the
  // pack's review screen says that setting the pack up accepts Google's licence for it.
  modules: [{ id: 'widevine' }],
  startup: { video: { url: `${raw}/intro.mp4`, ...intro } },
  setup: { steps: [{ item: 'source', step: 'settings', title: 'Sign in to Crunchyroll' }] },
}

writeFileSync(join(dir, 'store.json'), `${JSON.stringify(store, null, 2)}\n`)
writeFileSync(join(dir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`)
console.log(`izumi/store.json: ${Object.keys(builds).join(', ')}`)
console.log(`izumi/pack.json: ${raw}/pack.json`)
