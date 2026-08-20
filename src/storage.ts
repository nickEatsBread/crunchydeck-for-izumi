import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function loadSession(): SessionFile | null {
  try {
    const raw = readFileSync(sessionPath(), 'utf8')
    const parsed = JSON.parse(raw) as SessionFile
    if (!parsed || typeof parsed !== 'object' || !parsed.deviceId) return null
    if (parsed.profile !== 'tv' && parsed.profile !== 'web') return null
    return parsed
  } catch {
    return null
  }
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
