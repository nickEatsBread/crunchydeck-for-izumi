import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const stage = join(dist, 'izumi-service-package')
const keyDir = join(root, '.data')
const keyPath = join(keyDir, 'service-signing-key.pem')
const windows = platform() === 'win32'
const platformName = `${windows ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux'}-${arch() === 'arm64' ? 'aarch64' : 'x86_64'}`
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

run(windows ? 'bun.exe' : 'bun', [
  'build', '--compile', ...(windows ? ['--windows-hide-console'] : []),
  'src/compiled-main.ts', '--outfile', executable,
])

const manifest = {
  formatVersion: 1,
  runtimeAbi: 1,
  id: 'crunchyroll.izumi',
  name: 'Crunchyroll',
  version: '0.1.2',
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

if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
}
const privateKey = readFileSync(keyPath)
const publicKey = (await import('node:crypto')).createPublicKey(privateKey)
const signature = {
  algorithm: 'Ed25519',
  signed: true,
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  signature: sign(null, Buffer.from(canonical(integrity)), privateKey).toString('base64'),
}
writeFileSync(join(stage, 'signature.json'), `${JSON.stringify(signature, null, 2)}\n`)

rmSync(output, { force: true })
if (windows) {
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
