import {
  DEVICE,
  HOSTS,
  TOKEN_SKEW_MS,
  TV_CLIENT_BASIC,
  WEB_CLIENT_BASIC,
  type ClientProfile,
} from './constants.js'
import { CrError, errorCode } from './errors.js'
import { crHeaders } from './headers.js'
import { jsonOrThrow, type CrTransport } from './http.js'
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

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
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
    else if (this.session.refreshToken) this.loginKind = 'password'
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

  status(): AccountStatus {
    return {
      authenticated: !!this.tokens || !!this.session.etpRt || !!this.session.refreshToken,
      profile: this.session.profile,
      accountId: this.session.accountId ?? this.tokens?.accountId,
      profileId: this.session.profileId ?? this.tokens?.profileId,
      country: this.session.country ?? this.tokens?.country,
      expiresAt: this.tokens?.expiresAt,
      transport: this.transport.name,
      login: this.loginKind,
    }
  }

  logout(): void {
    this.tokens = null
    this.loginKind = 'none'
    this.session = {
      profile: this.session.profile,
      deviceId: this.session.deviceId,
    }
    saveSession(this.session)
  }

  async loginEtpRt(etpRt: string): Promise<AccountStatus> {
    const value = etpRt.trim()
    if (!value) throw new Error('etp_rt cookie is empty')
    this.session.profile = 'web'
    this.session.etpRt = value
    this.session.refreshToken = undefined
    this.loginKind = 'etp_rt'
    this.tokens = null
    await this.accessToken(true)
    return this.status()
  }

  async loginPassword(username: string, password: string): Promise<AccountStatus> {
    this.session.profile = 'tv'
    this.session.etpRt = undefined
    this.loginKind = 'password'
    const json = await this.tokenRequest({
      username,
      password,
      grant_type: 'password',
      scope: 'offline_access',
      device_id: this.session.deviceId,
      device_type: DEVICE.tv.type,
      device_name: DEVICE.tv.name,
    })
    this.adopt(json)
    return this.status()
  }

  async requestDeviceCode(): Promise<DeviceCode> {
    this.session.profile = 'tv'
    const json = await jsonOrThrow<{
      device_code: string
      user_code: string
      verification_uri?: string
      verification_uri_complete?: string
      expires_in?: number
      polling_interval?: number
      interval?: number
    }>(
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
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri_complete || json.verification_uri || 'https://www.crunchyroll.com/activate',
      expiresIn: json.expires_in ?? 300,
      interval: json.polling_interval ?? json.interval ?? 5,
    }
  }

  async pollDeviceCode(deviceCode: string): Promise<{ pending: boolean; status?: AccountStatus }> {
    this.session.profile = 'tv'
    try {
      const json = await this.tokenJson({
        url: `${HOSTS.api}/auth/v1/device/token`,
        contentType: 'application/json',
        body: JSON.stringify({ device_id: this.session.deviceId, device_code: deviceCode }),
      })
      if (!json.access_token) return { pending: true }
      this.loginKind = 'device'
      this.session.etpRt = undefined
      this.adopt(json)
      return { pending: false, status: this.status() }
    } catch (error) {
      if (error instanceof CrError && (error.status === 400 || error.status === 401 || error.status === 404)) {
        const code = errorCode(error.body)
        if (code === 'slow_down') return { pending: true }
        if (code === 'expired' || code === 'access_denied') throw error
        return { pending: true }
      }
      throw error
    }
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

  private async refresh(): Promise<string> {
    if (this.session.profile === 'web' && this.session.etpRt) {
      const json = await this.tokenRequest({
        grant_type: 'etp_rt_cookie',
        device_id: this.session.deviceId,
        device_type: DEVICE.web.type,
        scope: 'offline_access',
      }, `etp_rt=${this.session.etpRt}`)
      this.adopt(json)
      return this.tokens!.accessToken
    }
    if (this.session.refreshToken) {
      const json = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.session.refreshToken,
        scope: 'offline_access',
        device_id: this.session.deviceId,
        device_type: this.session.profile === 'tv' ? DEVICE.tv.type : DEVICE.web.type,
      })
      this.adopt(json)
      return this.tokens!.accessToken
    }
    throw new Error('Not logged in to Crunchyroll. Open the source page and sign in.')
  }

  private adopt(json: TokenJson): void {
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
    this.session.accessToken = this.tokens.accessToken
    this.session.accessExpiresAt = this.tokens.expiresAt
    this.session.refreshToken = json.refresh_token ?? this.session.refreshToken
    this.session.accountId = json.account_id ?? this.session.accountId
    this.session.profileId = json.profile_id ?? this.session.profileId
    this.session.country = json.country ?? this.session.country
    saveSession(this.session)
  }

  private async tokenRequest(body: Record<string, string>, cookie?: string): Promise<TokenJson> {
    const profile = this.session.profile
    return this.tokenJson({
      url: `${tokenHost(profile)}/auth/v1/token`,
      contentType: 'application/x-www-form-urlencoded',
      body: form(body),
      cookie,
    })
  }

  private async tokenJson(opts: { url: string; contentType: string; body: string; cookie?: string }): Promise<TokenJson> {
    const profile = this.session.profile
    const res = await this.transport.request({
      url: opts.url,
      method: 'POST',
      headers: crHeaders({
        profile,
        authorization: clientBasic(profile),
        contentType: opts.contentType,
        cookie: opts.cookie,
      }),
      body: opts.body,
      cookie: opts.cookie,
    })
    const json = await jsonOrThrow<TokenJson>(res)
    if (json.error) throw new CrError(res.status, res.text, json.error)
    return json
  }
}


