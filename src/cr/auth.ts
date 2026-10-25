import {
  DEVICE,
  HOSTS,
  TOKEN_SKEW_MS,
  TV_CLIENT_BASIC,
  WEB_CLIENT_BASIC,
  type ClientProfile,
} from './constants.js'
import { interpretDeviceToken, isInvalidGrant, mapDeviceCodeResponse } from './device.js'
import { CrError } from './errors.js'
import { crHeaders } from './headers.js'
import { jsonOrThrow, type CrResponse, type CrTransport } from './http.js'
import { loadSession, saveSession, type SessionFile } from '../storage.js'

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  accountId?: string
  profileId?: string
  country?: string
  tokenType: string
}

export interface AccountStatus {
  authenticated: boolean
  profile: ClientProfile
  accountId?: string
  profileId?: string
  country?: string
  expiresAt?: number
  transport: string
  login: 'etp_rt' | 'password' | 'device' | 'none'
}

interface TokenJson {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  account_id?: string
  profile_id?: string
  country?: string
  error?: string
}

/** One of the account's profiles ("who's watching"). */
export interface CrProfile {
  id: string
  name: string
  selected: boolean
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  intervalMs: number
}

export type DeviceFlowStatus = 'idle' | 'waiting' | 'ok' | 'expired' | 'error'

export interface DeviceFlowState {
  status: DeviceFlowStatus
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  expiresAt?: number
  error?: string
  authenticated?: AccountStatus
}

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString()
}

function tokenHost(profile: ClientProfile): string {
  return profile === 'tv' ? HOSTS.api : HOSTS.www
}

function clientBasic(profile: ClientProfile): string {
  return profile === 'tv' ? TV_CLIENT_BASIC : WEB_CLIENT_BASIC
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export class Auth {
  private tokens: TokenSet | null = null
  private inflight: Promise<string> | null = null
  private loginKind: AccountStatus['login'] = 'none'
  private session: SessionFile
  private deviceFlow: DeviceFlowState = { status: 'idle' }
  private devicePollTimer: ReturnType<typeof setTimeout> | null = null
  private deviceCode: string | null = null
  private deviceIntervalMs = 3000

  constructor(
    private transport: CrTransport,
    session: SessionFile | null,
  ) {
    this.session = session ?? {
      profile: 'web',
      deviceId: crypto.randomUUID(),
    }
    if (!session) saveSession(this.session)
    if (this.session.accessToken && this.session.accessExpiresAt && this.session.accessExpiresAt > Date.now() + TOKEN_SKEW_MS) {
      this.tokens = {
        accessToken: this.session.accessToken,
        refreshToken: this.session.refreshToken,
        expiresAt: this.session.accessExpiresAt,
        accountId: this.session.accountId,
        profileId: this.session.profileId,
        country: this.session.country,
        tokenType: 'Bearer',
      }
    }
    if (this.session.etpRt) this.loginKind = 'etp_rt'
    else if (this.session.refreshToken) this.loginKind = this.session.profile === 'tv' ? 'device' : 'password'
  }

  get profile(): ClientProfile {
    return this.session.profile
  }

  get deviceId(): string {
    return this.session.deviceId
  }

  get transportName(): string {
    return this.transport.name
  }

  shutdown(): void {
    this.stopDevicePoll()
  }

  status(): AccountStatus {
    const canRefresh = !!this.session.etpRt || !!this.session.refreshToken
    return {
      authenticated: !!this.tokens || canRefresh,
      profile: this.session.profile,
      accountId: this.session.accountId ?? this.tokens?.accountId,
      profileId: this.session.profileId ?? this.tokens?.profileId,
      country: this.session.country ?? this.tokens?.country,
      expiresAt: this.tokens?.expiresAt,
      transport: this.transport.name,
      login: this.loginKind,
    }
  }

  deviceStatus(): DeviceFlowState {
    return { ...this.deviceFlow, authenticated: this.deviceFlow.status === 'ok' ? this.status() : undefined }
  }

  get profileChosen(): boolean {
    return !!this.session.profileChosen
  }

  /** The account's profiles. The current one is marked selected. */
  async profiles(): Promise<CrProfile[]> {
    const token = await this.accessToken()
    const profile = this.session.profile
    const res = await this.transport.request({
      url: `${tokenHost(profile)}/accounts/v1/me/multiprofile`,
      headers: crHeaders({ profile, authorization: `Bearer ${token}` }),
    })
    const json = await jsonOrThrow<{ profiles?: Array<{ profile_id?: string; profile_name?: string; username?: string; is_selected?: boolean }> }>(res)
    const current = this.session.profileId ?? this.tokens?.profileId
    return (json.profiles ?? [])
      .filter((item) => item.profile_id)
      .map((item) => ({
        id: item.profile_id!,
        name: item.profile_name || item.username || 'Profile',
        selected: current ? item.profile_id === current : !!item.is_selected,
      }))
  }

  /** Re-mints the session for another profile of the same account. TV sign-ins only: the web
   *  cookie grant has no refresh token to redeem. */
  async switchProfile(profileId: string): Promise<AccountStatus> {
    if (!profileId) throw new Error('Choose a profile.')
    if (this.session.profile !== 'tv' || !this.session.refreshToken) {
      throw new Error('Profiles can be switched after signing in with a TV code or email and password.')
    }
    const json = await this.tokenRequest('tv', {
      grant_type: 'refresh_token_profile_id',
      refresh_token: this.session.refreshToken,
      profile_id: profileId,
      scope: 'offline_access',
      device_id: this.session.deviceId,
      device_type: DEVICE.tv.type,
    })
    this.adopt(json, 'tv')
    this.markProfileChosen()
    return this.status()
  }

  /** Records that the profile question is settled (picked, or only one profile exists). */
  markProfileChosen(): void {
    if (this.session.profileChosen) return
    this.session.profileChosen = true
    saveSession(this.session)
  }

  logout(): void {
    this.stopDevicePoll()
    this.tokens = null
    this.loginKind = 'none'
    this.deviceFlow = { status: 'idle' }
    this.session = {
      profile: 'web',
      deviceId: this.session.deviceId,
    }
    saveSession(this.session)
  }

  async loginEtpRt(etpRt: string): Promise<AccountStatus> {
    const value = etpRt.trim()
    if (!value) throw new Error('etp_rt cookie is empty')
    this.stopDevicePoll()
    this.deviceCode = null
    this.deviceFlow = { status: 'idle' }
    this.session.profile = 'web'
    this.session.etpRt = value
    this.session.refreshToken = undefined
    this.loginKind = 'etp_rt'
    this.tokens = null
    await this.accessToken(true)
    return this.status()
  }

  async loginPassword(username: string, password: string): Promise<AccountStatus> {
    this.stopDevicePoll()
    this.deviceCode = null
    this.deviceFlow = { status: 'idle' }
    this.session.profile = 'tv'
    this.session.etpRt = undefined
    this.loginKind = 'password'
    const json = await this.tokenRequest('tv', {
      username,
      password,
      grant_type: 'password',
      scope: 'offline_access',
      device_id: this.session.deviceId,
      device_type: DEVICE.tv.type,
      device_name: DEVICE.tv.name,
    })
    this.adopt(json, 'tv')
    return this.status()
  }

  async requestDeviceCode(): Promise<DeviceCode> {
    this.stopDevicePoll()
    const json = await jsonOrThrow<Record<string, unknown>>(
      await this.transport.request({
        url: `${HOSTS.api}/auth/v1/device/code`,
        method: 'POST',
        headers: crHeaders({
          profile: 'tv',
          authorization: TV_CLIENT_BASIC,
          contentType: 'application/x-www-form-urlencoded',
        }),
        body: form({
          device_id: this.session.deviceId,
          device_type: DEVICE.tv.type,
          device_name: DEVICE.tv.name,
        }),
      }),
    )
    const mapped = mapDeviceCodeResponse(json ?? {})
    if (!mapped.deviceCode || !mapped.userCode) {
      throw new Error('Crunchyroll did not return a device code')
    }
    this.deviceCode = mapped.deviceCode
    this.deviceIntervalMs = mapped.intervalMs
    this.deviceFlow = {
      status: 'waiting',
      userCode: mapped.userCode,
      verificationUri: mapped.verificationUri,
      verificationUriComplete: mapped.verificationUriComplete,
      expiresAt: Date.now() + mapped.expiresIn * 1000,
    }
    console.log(`[device] code ${mapped.userCode} interval=${mapped.intervalMs}ms expires=${mapped.expiresIn}s`)
    this.scheduleDevicePoll(0)
    return mapped
  }

  async pollDeviceCode(deviceCode?: string): Promise<{ pending: boolean; status?: AccountStatus; flow: DeviceFlowState }> {
    const code = deviceCode || this.deviceCode
    if (!code) return { pending: true, flow: this.deviceStatus() }
    if (this.deviceFlow.status === 'ok') return { pending: false, status: this.status(), flow: this.deviceStatus() }
    if (this.deviceFlow.status === 'expired' || this.deviceFlow.status === 'error') {
      return { pending: false, flow: this.deviceStatus() }
    }
    await this.tickDevicePoll(code)
    const flow = this.deviceStatus()
    const done = flow.status === 'ok'
    return { pending: !done, status: done ? this.status() : undefined, flow }
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.tokens && Date.now() < this.tokens.expiresAt) return this.tokens.accessToken
    if (this.inflight) return this.inflight
    this.inflight = this.refresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  benefits(): string[] {
    if (!this.tokens) return []
    const payload = decodeJwtPayload(this.tokens.accessToken)
    const value = payload?.benefits
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }

  private stopDevicePoll(): void {
    if (this.devicePollTimer) {
      clearTimeout(this.devicePollTimer)
      this.devicePollTimer = null
    }
  }

  private scheduleDevicePoll(delayMs: number): void {
    this.stopDevicePoll()
    this.devicePollTimer = setTimeout(() => {
      void this.tickDevicePoll(this.deviceCode ?? '').catch((error) => {
        console.log('[device] poll failed', error instanceof Error ? error.message : error)
      })
    }, delayMs)
  }

  private async tickDevicePoll(deviceCode: string): Promise<void> {
    if (!deviceCode) return
    if (this.deviceFlow.expiresAt && Date.now() > this.deviceFlow.expiresAt) {
      this.stopDevicePoll()
      this.deviceFlow = { ...this.deviceFlow, status: 'expired', error: 'Code expired. Get a new one.' }
      return
    }
    const res = await this.transport.request({
      url: `${HOSTS.api}/auth/v1/device/token`,
      method: 'POST',
      headers: crHeaders({
        profile: 'tv',
        authorization: TV_CLIENT_BASIC,
        contentType: 'application/json',
      }),
      body: JSON.stringify({ device_id: this.session.deviceId, device_code: deviceCode }),
    })
    const json = parseJsonBody(res)
    const verdict = interpretDeviceToken(res.status, json, res.text)
    console.log(`[device] poll ${verdict.status} http=${res.status} body=${res.body.length}`)
    if (verdict.status === 'ok' && json?.access_token) {
      this.stopDevicePoll()
      this.loginKind = 'device'
      this.session.etpRt = undefined
      this.adopt(json, 'tv')
      this.deviceFlow = { ...this.deviceFlow, status: 'ok', error: undefined }
      return
    }
    if (verdict.status === 'expired') {
      this.stopDevicePoll()
      this.deviceFlow = { ...this.deviceFlow, status: 'expired', error: 'Code expired. Get a new one.' }
      return
    }
    if (verdict.status === 'error') {
      this.stopDevicePoll()
      this.deviceFlow = { ...this.deviceFlow, status: 'error', error: verdict.error || 'Device login failed' }
      return
    }
    const wait = verdict.status === 'slow_down' ? Math.min(15_000, this.deviceIntervalMs * 2) : this.deviceIntervalMs
    this.deviceIntervalMs = wait
    this.deviceFlow = { ...this.deviceFlow, status: 'waiting' }
    this.scheduleDevicePoll(wait)
  }

  private async refresh(): Promise<string> {
    if (this.session.etpRt) {
      try {
        const json = await this.tokenRequest('web', {
          grant_type: 'etp_rt_cookie',
          device_id: this.session.deviceId,
          device_type: DEVICE.web.type,
          scope: 'offline_access',
        }, `etp_rt=${this.session.etpRt}`)
        this.adopt(json, 'web')
        this.loginKind = 'etp_rt'
        return this.tokens!.accessToken
      } catch (error) {
        if (!isInvalidGrant(error)) throw error
        this.session.etpRt = undefined
        saveSession(this.session)
      }
    }
    if (this.session.refreshToken) {
      try {
        const json = await this.tokenRequest('tv', {
          grant_type: 'refresh_token',
          refresh_token: this.session.refreshToken,
          scope: 'offline_access',
          device_id: this.session.deviceId,
          device_type: DEVICE.tv.type,
        })
        this.adopt(json, 'tv')
        return this.tokens!.accessToken
      } catch (error) {
        if (isInvalidGrant(error)) {
          this.forgetTokens()
          throw new Error('Crunchyroll session expired. Open http://127.0.0.1:17871 and sign in again.')
        }
        throw error
      }
    }
    this.forgetTokens()
    throw new Error('Not logged in to Crunchyroll. Open http://127.0.0.1:17871 and sign in.')
  }

  private forgetTokens(): void {
    this.tokens = null
    this.loginKind = 'none'
    this.session.refreshToken = undefined
    this.session.accessToken = undefined
    this.session.accessExpiresAt = undefined
    this.session.etpRt = undefined
    saveSession(this.session)
  }

  private adopt(json: TokenJson, profile: ClientProfile): void {
    if (!json.access_token) throw new Error('Crunchyroll login did not return an access token')
    this.tokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + Math.max(30, json.expires_in ?? 300) * 1000 - TOKEN_SKEW_MS,
      accountId: json.account_id,
      profileId: json.profile_id,
      country: json.country,
      tokenType: json.token_type ?? 'Bearer',
    }
    this.session.profile = profile
    this.session.accessToken = this.tokens.accessToken
    this.session.accessExpiresAt = this.tokens.expiresAt
    if (profile === 'tv') {
      this.session.refreshToken = json.refresh_token ?? this.session.refreshToken
    } else {
      // Web etp_rt responses include a refresh_token that the web client cannot redeem.
      this.session.refreshToken = undefined
    }
    this.session.accountId = json.account_id ?? this.session.accountId
    this.session.profileId = json.profile_id ?? this.session.profileId
    this.session.country = json.country ?? this.session.country
    saveSession(this.session)
  }

  private async tokenRequest(profile: ClientProfile, body: Record<string, string>, cookie?: string): Promise<TokenJson> {
    return this.tokenJson({
      url: `${tokenHost(profile)}/auth/v1/token`,
      contentType: 'application/x-www-form-urlencoded',
      body: form(body),
      cookie,
      profile,
    })
  }

  private async tokenJson(opts: {
    url: string
    contentType: string
    body: string
    cookie?: string
    profile: ClientProfile
  }): Promise<TokenJson> {
    const res = await this.transport.request({
      url: opts.url,
      method: 'POST',
      headers: crHeaders({
        profile: opts.profile,
        authorization: clientBasic(opts.profile),
        contentType: opts.contentType,
        cookie: opts.cookie,
      }),
      body: opts.body,
      cookie: opts.cookie,
    })
    const json = await jsonOrThrow<TokenJson>(res)
    if (json?.error) throw new CrError(res.status, res.text, json.error)
    return json
  }
}

function parseJsonBody(res: CrResponse): TokenJson | undefined {
  if (!res.body.length) return undefined
  try {
    return JSON.parse(res.text) as TokenJson
  } catch {
    return undefined
  }
}

