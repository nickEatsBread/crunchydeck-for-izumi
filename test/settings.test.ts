import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CrunchyrollApp } from '../src/app.js'
import { mapProfiles, type AccountStatus, type CrProfile, type DeviceCode, type DeviceFlowState } from '../src/cr/auth.js'
import { CRUNCHYROLL_ICON } from '../src/brand.js'
import { listen } from '../src/server.js'
import {
  saveServiceSettings,
  serviceSettings,
  type SettingsAccount,
} from '../src/settings.js'

class FakeAccount implements SettingsAccount {
  baseUrl = 'http://127.0.0.1:0'
  shareBaseUrl = ''
  partyBaseUrl = ''
  current: AccountStatus = {
    authenticated: false,
    profile: 'web',
    transport: 'fetch',
    login: 'none',
  }
  cookie = ''
  credentials: [string, string] | undefined
  loggedOut = false
  flow: DeviceFlowState = { status: 'idle' }

  status(): AccountStatus { return this.current }
  deviceStatus(): DeviceFlowState { return this.flow }
  async loginEtpRt(value: string): Promise<AccountStatus> {
    this.cookie = value
    this.current = { ...this.current, authenticated: true, login: 'etp_rt', accountId: 'account-1' }
    return this.current
  }
  async loginPassword(username: string, password: string): Promise<AccountStatus> {
    this.credentials = [username, password]
    this.current = { ...this.current, authenticated: true, profile: 'tv', login: 'password' }
    return this.current
  }
  async requestDeviceCode(): Promise<DeviceCode> {
    const code = {
      deviceCode: 'device-secret',
      userCode: 'ABCD1234',
      verificationUri: 'https://www.crunchyroll.com/activate',
      verificationUriComplete: 'https://www.crunchyroll.com/activate?code=ABCD1234',
      expiresIn: 300,
      intervalMs: 5000,
    }
    this.flow = {
      status: 'waiting',
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      verificationUriComplete: code.verificationUriComplete,
      expiresAt: Date.now() + code.expiresIn * 1000,
    }
    return code
  }
  logout(): void {
    this.loggedOut = true
    this.flow = { status: 'idle' }
    this.current = { ...this.current, authenticated: false, login: 'none', accountId: undefined }
  }
  savePreferences?: (patch: Record<string, unknown>) => Promise<void>
  async accountDetails(): Promise<undefined> { return undefined }
  profileList: CrProfile[] = []
  chosen = false
  switchedTo = ''
  profileChosen(): boolean { return this.chosen }
  async accountProfiles(): Promise<CrProfile[] | undefined> {
    return this.current.authenticated ? this.profileList : undefined
  }
  async switchProfile(profileId: string): Promise<AccountStatus> {
    this.switchedTo = profileId
    this.chosen = true
    this.profileList = this.profileList.map((profile) => ({ ...profile, selected: profile.id === profileId }))
    return this.current
  }
}

test('manifest artwork uses the Crunchyroll eye mark', () => {
  assert.match(CRUNCHYROLL_ICON, /^data:image\/svg\+xml,/)
  const svg = decodeURIComponent(CRUNCHYROLL_ICON.split(',')[1] ?? '')
  assert.match(svg, /#f47521/)
  assert.equal((svg.match(/<path/g) ?? []).length, 2)
})

test('native settings are a reactive version-one write-only account form', () => {
  const document = serviceSettings(new FakeAccount())
  assert.equal(document.version, 1)
  assert.equal(document.title, 'Crunchyroll settings')
  assert.match(document.description, /Not signed in/)
  assert.deepEqual(document.values, { accountAction: 'device', profileId: '', etpRt: '', username: '', password: '' })
  assert.equal(document.complete, false)
  const action = document.fields.find((field) => field.key === 'accountAction')
  assert.equal(action?.role, 'action')
  assert.equal(action?.options?.find((option) => option.value === 'device')?.submitLabel, 'Get TV code')
  assert.equal(document.fields.find((field) => field.key === 'etpRt')?.type, 'password')
  assert.deepEqual(document.fields.find((field) => field.key === 'etpRt')?.visibleWhen, { key: 'accountAction', equals: 'cookie' })
  assert.equal(document.fields.find((field) => field.key === 'password')?.type, 'password')
  assert.deepEqual(document.fields.find((field) => field.key === 'password')?.visibleWhen, { key: 'accountAction', equals: 'password' })
})

test('signed-in settings default to a no-op and expose an explicit destructive sign-out', async () => {
  const account = new FakeAccount()
  await account.loginEtpRt('cookie-secret')
  const document = serviceSettings(account)
  assert.equal(document.values.accountAction, 'keep')
  assert.equal(document.complete, true)
  assert.equal(document.fields[0]?.options?.find((option) => option.value === 'keep')?.hideSubmit, true)
  assert.equal(document.fields[0]?.options?.find((option) => option.value === 'logout')?.intent, 'danger')
})

test('an account with several profiles asks who is watching before it counts as set up', async () => {
  const account = new FakeAccount()
  await account.loginPassword('me@example.com', 'secret')
  account.profileList = [
    { id: 'p1', name: 'Nico', selected: true },
    { id: 'p2', name: 'Kids', selected: false },
  ]
  const asking = serviceSettings(account, account.profileList)
  assert.equal(asking.values.accountAction, 'profile')
  assert.equal(asking.complete, false)
  assert.equal(asking.notice?.title, "Who's watching?")
  assert.deepEqual(asking.fields.find((field) => field.key === 'profileId')?.options?.map((option) => option.label), ['Nico', 'Kids'])
  assert.match(asking.description, /as Nico/)

  const saved = await saveServiceSettings(account, { accountAction: 'profile', profileId: 'p2' }, () => account.accountProfiles())
  assert.equal(account.switchedTo, 'p2')
  assert.equal(saved.complete, true)
  assert.equal(saved.values.accountAction, 'keep')
  assert.match(saved.description, /as Kids/)
  await assert.rejects(saveServiceSettings(account, { accountAction: 'profile', profileId: '' }), /Choose a profile/)
})

test('profiles keep their avatar and wallpaper as image URLs', () => {
  const art = 'https://static.crunchyroll.com/assets'
  const profiles = mapProfiles([
    { profile_id: 'p1', profile_name: 'Nico', avatar: '0007-cr-hime.png', wallpaper: '0010-crunchyroll.png', is_selected: false },
    { profile_id: 'p2', username: 'kid', is_selected: true },
    { profile_name: 'No id' },
    { profile_id: 'p3', avatar: '../../evil/x.png' },
  ], 'p1')
  assert.deepEqual(profiles, [
    { id: 'p1', name: 'Nico', selected: true, avatar: `${art}/avatar/170x170/0007-cr-hime.png`, wallpaper: `${art}/wallpaper/1920x400/0010-crunchyroll.png` },
    { id: 'p2', name: 'kid', selected: false, avatar: `${art}/avatar/170x170/0001-cr-white-orange.png`, wallpaper: undefined },
    { id: 'p3', name: 'Profile', selected: false, avatar: `${art}/avatar/170x170/..%2F..%2Fevil%2Fx.png`, wallpaper: undefined },
  ])
  // Without a session profile the server's own mark decides.
  assert.deepEqual(mapProfiles([{ profile_id: 'p1' }, { profile_id: 'p2', is_selected: true }]).map((profile) => profile.selected), [false, true])
})

test("who's watching shows each profile's avatar and wallpaper, and the summary shows the current one", async () => {
  const account = new FakeAccount()
  await account.loginPassword('me@example.com', 'secret')
  account.profileList = [
    { id: 'p1', name: 'Nico', selected: true, avatar: 'https://img.test/nico.png', wallpaper: 'https://img.test/nico-wall.png' },
    { id: 'p2', name: 'Kids', selected: false, avatar: 'https://img.test/kids.png' },
  ]
  const document = serviceSettings(account, account.profileList)
  assert.equal(document.image, 'https://img.test/nico.png')
  assert.deepEqual(document.fields.find((field) => field.key === 'profileId')?.options, [
    { value: 'p1', label: 'Nico', description: 'Current profile', image: 'https://img.test/nico.png', backdrop: 'https://img.test/nico-wall.png' },
    { value: 'p2', label: 'Kids', description: undefined, image: 'https://img.test/kids.png', backdrop: undefined },
  ])

  const switched = await saveServiceSettings(account, { accountAction: 'profile', profileId: 'p2' }, () => account.accountProfiles())
  assert.equal(switched.image, 'https://img.test/kids.png')
  const signedOut = await saveServiceSettings(account, { accountAction: 'logout' })
  assert.equal(signedOut.image, undefined)
})

test('a cookie sign-in with several profiles is set up without a profile step it cannot take', async () => {
  // The cookie grant cannot switch profiles, so asking who is watching left setup stuck.
  const account = new FakeAccount()
  await account.loginEtpRt('cookie-secret')
  account.profileList = [
    { id: 'p1', name: 'Nico', selected: true },
    { id: 'p2', name: 'Kids', selected: false },
  ]
  const document = serviceSettings(account, account.profileList)
  assert.equal(document.complete, true)
  assert.equal(document.values.accountAction, 'keep')
  assert.equal(document.fields[0]?.options?.some((option) => option.value === 'profile'), false)
})

test('a signed-in account shows its membership and edits the profile languages and mature content', async () => {
  const account = new FakeAccount()
  await account.loginPassword('me@example.com', 'secret')
  const details = { premium: true, preferences: { displayLanguage: 'en-US', audioLanguage: 'ja-JP', subtitleLanguage: 'en-US', matureContent: false } }
  const document = serviceSettings(account, [], details)
  assert.match(document.description, /Crunchyroll Premium/)
  assert.ok(document.fields[0]?.options?.some((option) => option.value === 'preferences'))
  assert.equal(document.values.audioLanguage, 'ja-JP')
  assert.equal(document.values.matureContent, false)
  const subtitles = document.fields.find((field) => field.key === 'subtitleLanguage')
  assert.equal(subtitles?.options?.[0]?.label, 'None')
  assert.deepEqual(subtitles?.visibleWhen, { key: 'accountAction', equals: 'preferences' })

  let saved: unknown
  account.savePreferences = async (patch) => { saved = patch }
  const after = await saveServiceSettings(account, { accountAction: 'preferences', displayLanguage: 'fr-FR', audioLanguage: 'ja-JP', subtitleLanguage: '', matureContent: true }, undefined, async () => details)
  assert.deepEqual(saved, { displayLanguage: 'fr-FR', audioLanguage: 'ja-JP', subtitleLanguage: '', matureContent: true })
  assert.equal(after.message, 'Preferences saved to Crunchyroll.')
})

test('membership comes from the access token benefits', async () => {
  const { premiumFromToken } = await import('../src/cr/content.js')
  const token = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
  assert.equal(premiumFromToken(token({ benefits: ['cr_premium', 'cr_store'] })), true)
  assert.equal(premiumFromToken(token({ benefits: ['cr_store'] })), false)
  assert.equal(premiumFromToken(token({})), null)
  assert.equal(premiumFromToken('not-a-token'), null)
})

test('native settings handle cookie login without echoing the secret', async () => {
  const account = new FakeAccount()
  const saved = await saveServiceSettings(account, { accountAction: 'cookie', etpRt: ' cookie-secret ' })
  assert.equal(account.cookie, 'cookie-secret')
  assert.equal(saved.ok, true)
  assert.equal(saved.values.etpRt, '')
  assert.match(saved.description, /Signed in as account-1/)
})

test('native settings handle password, device-code, and logout actions', async () => {
  const account = new FakeAccount()
  await saveServiceSettings(account, {
    accountAction: 'password',
    username: ' person@example.com ',
    password: ' secret with intentional spaces ',
  })
  assert.deepEqual(account.credentials, ['person@example.com', ' secret with intentional spaces '])

  const device = await saveServiceSettings(account, { accountAction: 'device' })
  assert.equal(device.message, 'TV code ready.')
  assert.equal(device.refreshAfterMs, 1000)
  assert.equal(device.values.accountAction, 'device')
  assert.equal(device.notice?.code, 'ABCD1234')
  assert.equal(device.notice?.action?.url, 'https://www.crunchyroll.com/activate?code=ABCD1234')

  const logout = await saveServiceSettings(account, { accountAction: 'logout' })
  assert.equal(account.loggedOut, true)
  assert.match(logout.description, /Not signed in/)
})

test('native settings validate the credentials selected by the account action', async () => {
  const account = new FakeAccount()
  await assert.rejects(
    saveServiceSettings(account, { accountAction: 'cookie', etpRt: '' }),
    /etp_rt browser cookie/,
  )
  await assert.rejects(
    saveServiceSettings(account, { accountAction: 'password', username: 'person@example.com' }),
    /both the Crunchyroll email and password/,
  )
})

test('the sidecar exposes Izumi settings over the managed-service HTTP contract', async (context) => {
  const data = mkdtempSync(join(tmpdir(), 'crunchyroll-settings-'))
  const previousData = process.env.CR_SOURCE_DATA
  process.env.CR_SOURCE_DATA = data
  const account = new FakeAccount()
  const server = await listen(account as unknown as CrunchyrollApp, 0)
  context.after(async () => {
    await server.close()
    if (previousData == null) delete process.env.CR_SOURCE_DATA
    else process.env.CR_SOURCE_DATA = previousData
    rmSync(data, { recursive: true, force: true })
  })

  const read = await fetch(`${account.baseUrl}/__izumi/settings`)
  assert.equal(read.status, 200)
  const document = await read.json() as { version: number; title: string }
  assert.equal(document.version, 1)
  assert.equal(document.title, 'Crunchyroll settings')

  const save = await fetch(`${account.baseUrl}/__izumi/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { accountAction: 'logout' } }),
  })
  assert.equal(save.status, 200)
  assert.equal(account.loggedOut, true)

  const manifest = await (await fetch(`${account.baseUrl}/index.json`)).json() as { icon?: string; version?: string }
  assert.equal(manifest.icon, CRUNCHYROLL_ICON)
  assert.equal(manifest.version, '0.1.2')

  // Another web page can't sign the account out, and izumi's own webview gets a CORS answer.
  const forged = await fetch(`${account.baseUrl}/__izumi/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ values: { accountAction: 'logout' } }),
  })
  assert.equal(forged.status, 403)
  const fromIzumi = await fetch(`${account.baseUrl}/index.json`, { headers: { origin: 'tauri://localhost' } })
  assert.equal(fromIzumi.headers.get('access-control-allow-origin'), 'tauri://localhost')
})
