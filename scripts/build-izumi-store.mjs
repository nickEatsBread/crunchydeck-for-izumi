// Writes izumi/store.json and izumi/pack.json: the izumi store that lists this source (one build per
// platform) and the Crunchy Deck theme, and the pack that sets izumi up with both, the intro video,
// protected playback and the sign-in step. Sizes and hashes come from the files themselves, so run
// it after building the packages (dist/crunchyroll-<platform>.izumi-ext).
//
//   IZUMI_REPO=owner/repo IZUMI_REF=main node scripts/build-izumi-store.mjs
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'izumi')
const dist = join(root, 'dist')
const repo = process.env.IZUMI_REPO || 'nickEatsBread/crunchydeck-for-izumi'
const ref = process.env.IZUMI_REF || 'main'
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const raw = `https://raw.githubusercontent.com/${repo}/${ref}/izumi`
const release = `https://github.com/${repo}/releases/download/v${version}`

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

const theme = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'))
const store = {
  app: 'izumi',
  kind: 'store',
  schemaVersion: 1,
  id: 'crunchy-deck',
  name: 'Crunchy Deck',
  description: 'The Crunchyroll source for izumi and its matching theme.',
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
      tags: ['Dark', 'Square', 'Top nav'],
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
  name: 'Crunchy Deck',
  version,
  author: 'Crunchy Deck',
  description: 'Watch Crunchyroll in izumi: your Crunchyroll account as a source, a Crunchyroll-orange look, the Crunchyroll intro at start-up, and protected playback on Linux and the Steam Deck. Needs a Crunchyroll account.',
  icon: `${raw}/icon.svg`,
  homepage: `https://github.com/${repo}`,
  minAppVersion: '0.1.75',
  stores: [{ url: `${raw}/store.json` }],
  items: [
    { ref: 'source', kind: 'source', from: { store: `${raw}/store.json`, id: 'crunchyroll.izumi' } },
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
