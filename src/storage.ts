import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ClientProfile } from './cr/constants.js'

export interface StoredPlayToken {
  contentId: string
  token: string
}

export interface SessionFile {
  profile: ClientProfile
  etpRt?: string
  refreshToken?: string
  deviceId: string
  accountId?: string
  profileId?: string
  /** Set once the user has picked a profile (or the account only has one). */
  profileChosen?: boolean
  country?: string
  accessToken?: string
  accessExpiresAt?: number
  activePlays?: StoredPlayToken[]
}

export function dataDir(): string {
  if (process.env.CR_SOURCE_DATA) return process.env.CR_SOURCE_DATA
  return join(homedir(), '.crunchyroll-source-izumi')
}

export function sessionPath(): string {
  return join(dataDir(), 'session.json')
}

function shareTokenPath(): string {
  return join(dataDir(), 'share-token')
}

/** Stable bearer capability for Android installs. Rotating it on every process restart would
 * silently invalidate the manifest URL saved on the phone. Kept separate from session.json so
 * auth refresh writes and logout cannot accidentally replace it. */
export function loadOrCreateShareToken(): string {
  try {
    const existing = readFileSync(shareTokenPath(), 'utf8').trim()
    if (/^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing
  } catch { /* create it below */ }
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(shareTokenPath(), token, { encoding: 'utf8', mode: 0o600 })
  return token
}

export function loadSession(): SessionFile | null {
  const paths = [sessionPath()]
  // A managed package gets an isolated host-owned data directory. On its first launch, import the
  // source's legacy standalone session so installing the package does not unexpectedly sign the
  // user out. This migration belongs to the source; the generic host never inspects provider data.
  if (process.env.IZUMI_EXTENSION_DATA_DIR && process.env.CR_SOURCE_DATA) {
    const legacy = join(homedir(), '.crunchyroll-source-izumi', 'session.json')
    if (legacy !== paths[0]) paths.push(legacy)
  }
  for (const path of paths) {
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as SessionFile
      if (!parsed || typeof parsed !== 'object' || !parsed.deviceId) continue
      if (parsed.profile !== 'tv' && parsed.profile !== 'web') continue
      if (path !== paths[0]) saveSession(parsed)
      return parsed
    } catch { /* try the next migration location */ }
  }
  return null
}

export function saveSession(session: SessionFile): void {
  const dir = dirname(sessionPath())
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify(session, null, 2)
  writeFileSync(sessionPath(), body, { encoding: 'utf8', mode: 0o600 })
}

export function clearSession(): void {
  const empty: SessionFile = {
    profile: 'web',
    deviceId: crypto.randomUUID(),
  }
  saveSession(empty)
}
