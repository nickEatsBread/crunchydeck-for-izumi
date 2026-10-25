import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// node scripts/build-izumi-service-package.mjs [--target <os>-<arch>]
// Builds for this machine by default. --target cross-compiles (linux-x86_64, windows-x86_64,
// macos-aarch64, ...), so one machine can build every platform's package. The signing key comes
// from IZUMI_SIGNING_KEY (an Ed25519 PKCS#8 PEM) when set, so CI signs with the same key every time;
// izumi refuses a package whose signer changed. Otherwise a local key in .data/ is used.
const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const keyDir = join(root, '.data')
const keyPath = join(keyDir, 'service-signing-key.pem')
const hostWindows = platform() === 'win32'
const hostPlatform = `${hostWindows ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux'}-${arch() === 'arm64' ? 'aarch64' : 'x86_64'}`
const targetFlag = process.argv.indexOf('--target')
const platformName = targetFlag > 0 ? process.argv[targetFlag + 1] ?? '' : hostPlatform
const BUN_TARGETS = {
  'linux-x86_64': 'bun-linux-x64',
  'linux-aarch64': 'bun-linux-arm64',
  'windows-x86_64': 'bun-windows-x64',
  'macos-x86_64': 'bun-darwin-x64',
  'macos-aarch64': 'bun-darwin-arm64',
}
if (!BUN_TARGETS[platformName]) {
  console.error(`Unknown target ${platformName}. Use one of: ${Object.keys(BUN_TARGETS).join(', ')}`)
  process.exit(2)
}
const windows = platformName.startsWith('windows-')
const stage = join(dist, `izumi-service-package-${platformName}`)
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const entry = windows ? 'service.exe' : 'service'
const executable = join(stage, entry)
const output = join(dist, `crunchyroll-${platformName}.izumi-ext`)

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
mkdirSync(keyDir, { recursive: true })

run(hostWindows ? 'bun.exe' : 'bun', [
  'build', '--compile', `--target=${BUN_TARGETS[platformName]}`,
  ...(windows && hostWindows ? ['--windows-hide-console'] : []),
  'src/compiled-main.ts', '--outfile', executable,
])

const manifest = {
  formatVersion: 1,
  runtimeAbi: 1,
  id: 'crunchyroll.izumi',
  name: 'Crunchyroll',
  version,
  entry,
  execution: { backend: 'izumi-service', status: 'compatible' },
  sources: [{
    id: 'crunchyroll.izumi',
    name: 'Crunchyroll',
    language: 'en',
    baseUrl: 'https://www.crunchyroll.com',
  }],
}
const compatibility = { runtime: 'izumi-local-service-v1', platform: platformName }
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(stage, 'compatibility.json'), `${JSON.stringify(compatibility, null, 2)}\n`)

const integrity = {
  algorithm: 'SHA-256',
  files: Object.fromEntries(['manifest.json', 'compatibility.json', entry].map((name) => [
    name,
    sha256(readFileSync(join(stage, name))),
  ])),
}
writeFileSync(join(stage, 'integrity.json'), `${JSON.stringify(integrity, null, 2)}\n`)

if (!process.env.IZUMI_SIGNING_KEY && !existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
}
const privateKey = process.env.IZUMI_SIGNING_KEY ? Buffer.from(process.env.IZUMI_SIGNING_KEY) : readFileSync(keyPath)
const publicKey = (await import('node:crypto')).createPublicKey(privateKey)
const signature = {
  algorithm: 'Ed25519',
  signed: true,
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  signature: sign(null, Buffer.from(canonical(integrity)), privateKey).toString('base64'),
}
writeFileSync(join(stage, 'signature.json'), `${JSON.stringify(signature, null, 2)}\n`)

rmSync(output, { force: true })
if (hostWindows) {
  const zip = `${output}.zip`
  rmSync(zip, { force: true })
  const quote = (value) => value.replaceAll("'", "''")
  run('powershell.exe', ['-NoProfile', '-Command',
    `Get-ChildItem -LiteralPath '${quote(stage)}' | Compress-Archive -DestinationPath '${quote(zip)}' -CompressionLevel Optimal`,
  ])
  renameSync(zip, output)
} else {
  run('zip', ['-q', '-r', output, '.'], stage)
}

console.log(`${basename(output)} ${sha256(readFileSync(output))} ${readFileSync(output).byteLength} bytes`)
