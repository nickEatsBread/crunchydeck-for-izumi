import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CrunchyrollApp } from '../src/app.js'
import type { AccountStatus, DeviceCode, DeviceFlowState } from '../src/cr/auth.js'
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
  assert.deepEqual(document.values, { accountAction: 'device', etpRt: '', username: '', password: '' })
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
  assert.equal(document.fields[0]?.options?.find((option) => option.value === 'keep')?.hideSubmit, true)
  assert.equal(document.fields[0]?.options?.find((option) => option.value === 'logout')?.intent, 'danger')
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
})
