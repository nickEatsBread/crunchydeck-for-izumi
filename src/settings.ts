import type { AccountStatus, DeviceCode, DeviceFlowState } from './cr/auth.js'

export type ServiceSettingValue = string | number | boolean | null

export interface ServiceSettingCondition {
  key: string
  equals: ServiceSettingValue | ServiceSettingValue[]
}

export interface ServiceSettingOption {
  value: string
  label: string
  description?: string
  submitLabel?: string
  submittingLabel?: string
  intent?: 'primary' | 'danger'
  hideSubmit?: boolean
}

export interface ServiceSettingField {
  key: string
  label: string
  description?: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select'
  role?: 'action'
  visibleWhen?: ServiceSettingCondition
  required?: boolean
  placeholder?: string
  options?: ServiceSettingOption[]
}

export interface ServiceSettingsNotice {
  tone: 'info' | 'success' | 'warning' | 'error'
  title?: string
  message: string
  code?: string
  action?: { label: string; url: string }
  visibleWhen?: ServiceSettingCondition
}

export interface ServiceSettingsDocument {
  version: 1
  title: string
  description: string
  notice?: ServiceSettingsNotice
  refreshAfterMs?: number
  fields: ServiceSettingField[]
  values: Record<string, ServiceSettingValue>
}

export interface ServiceSettingsResult extends ServiceSettingsDocument {
  ok: true
  message: string
}

/** The narrow account surface used by native settings. Keeping this independent of the full app
 * makes the settings protocol testable without starting Chromium or contacting Crunchyroll. */
export interface SettingsAccount {
  status(): AccountStatus
  deviceStatus(): DeviceFlowState
  loginEtpRt(value: string): Promise<AccountStatus>
  loginPassword(username: string, password: string): Promise<AccountStatus>
  requestDeviceCode(): Promise<DeviceCode>
  logout(): void
}

function accountActions(status: AccountStatus): ServiceSettingOption[] {
  return [
    ...(status.authenticated ? [{
      value: 'keep',
      label: 'Keep current account',
      description: 'You are already signed in. Choose another action only to change accounts.',
      hideSubmit: true,
    }] : []),
    {
      value: 'device',
      label: 'Sign in with TV code',
      description: 'Recommended. Authorize Izumi on Crunchyroll without entering your password here.',
      submitLabel: 'Get TV code',
      submittingLabel: 'Getting code…',
    },
    {
      value: 'cookie',
      label: 'Sign in with browser cookie',
      description: 'Use the etp_rt cookie from an existing crunchyroll.com browser session.',
      submitLabel: 'Sign in',
      submittingLabel: 'Signing in…',
    },
    {
      value: 'password',
      label: 'Sign in with email and password',
      description: 'Sign in directly with your Crunchyroll account credentials.',
      submitLabel: 'Sign in',
      submittingLabel: 'Signing in…',
    },
    ...(status.authenticated ? [{
      value: 'logout',
      label: 'Sign out',
      description: 'Remove the saved Crunchyroll session from this device.',
      submitLabel: 'Sign out',
      submittingLabel: 'Signing out…',
      intent: 'danger' as const,
    }] : []),
  ]
}

function loginLabel(login: AccountStatus['login']): string {
  if (login === 'etp_rt') return 'browser cookie'
  if (login === 'device') return 'TV code'
  if (login === 'password') return 'email and password'
  return 'no saved login'
}

function description(status: AccountStatus): string {
  if (!status.authenticated) {
    return 'Not signed in. Choose a sign-in method below; a Crunchyroll account is required.'
  }
  const identity = status.accountId ? ` as ${status.accountId}` : ''
  const country = status.country ? ` (${status.country})` : ''
  return `Signed in${identity}${country} using ${loginLabel(status.login)}. Credentials are never shown here.`
}

function flowNotice(flow: DeviceFlowState): ServiceSettingsNotice | undefined {
  if (flow.status === 'waiting' && flow.userCode) {
    const destination = flow.verificationUriComplete || flow.verificationUri
    return {
      tone: 'info',
      title: 'Finish signing in on Crunchyroll',
      message: 'Enter this code on Crunchyroll. This page will update automatically when you finish.',
      code: flow.userCode,
      action: destination ? { label: 'Open Crunchyroll', url: destination } : undefined,
      visibleWhen: { key: 'accountAction', equals: 'device' },
    }
  }
  if (flow.status === 'ok') {
    return {
      tone: 'success',
      title: 'TV sign-in complete',
      message: 'Izumi is now connected to your Crunchyroll account.',
      visibleWhen: { key: 'accountAction', equals: ['keep', 'device'] },
    }
  }
  if (flow.status === 'expired' || flow.status === 'error') {
    return {
      tone: flow.status === 'expired' ? 'warning' : 'error',
      title: flow.status === 'expired' ? 'TV code expired' : 'TV sign-in failed',
      message: flow.error || 'Get a new TV code and try again.',
      visibleWhen: { key: 'accountAction', equals: 'device' },
    }
  }
  return undefined
}

export function serviceSettings(account: Pick<SettingsAccount, 'status' | 'deviceStatus'>): ServiceSettingsDocument {
  const status = account.status()
  const flow = account.deviceStatus()
  const accountAction = flow.status === 'waiting' ? 'device' : status.authenticated ? 'keep' : 'device'
  return {
    version: 1,
    title: 'Crunchyroll settings',
    description: description(status),
    notice: flowNotice(flow),
    refreshAfterMs: flow.status === 'waiting' ? 1_000 : undefined,
    fields: [
      {
        key: 'accountAction',
        label: 'Account action',
        type: 'select',
        role: 'action',
        options: accountActions(status),
      },
      {
        key: 'etpRt',
        label: 'Browser cookie (etp_rt)',
        description: 'This secret is used once and is never shown again.',
        type: 'password',
        visibleWhen: { key: 'accountAction', equals: 'cookie' },
        required: true,
        placeholder: 'Paste etp_rt from crunchyroll.com',
      },
      {
        key: 'username',
        label: 'Crunchyroll email',
        type: 'text',
        visibleWhen: { key: 'accountAction', equals: 'password' },
        required: true,
        placeholder: 'you@example.com',
      },
      {
        key: 'password',
        label: 'Crunchyroll password',
        description: 'This secret is used once and is never shown again.',
        type: 'password',
        visibleWhen: { key: 'accountAction', equals: 'password' },
        required: true,
      },
    ],
    // Secrets are deliberately write-only: opening or saving the dialog never echoes a token or
    // password out of the service process and into the WebView.
    values: { accountAction, etpRt: '', username: '', password: '' },
  }
}

function rawValue(values: Record<string, unknown>, key: string): string {
  const candidate = values[key]
  return typeof candidate === 'string' ? candidate : ''
}

function value(values: Record<string, unknown>, key: string): string {
  return rawValue(values, key).trim()
}

function result(account: SettingsAccount, message: string): ServiceSettingsResult {
  return { ...serviceSettings(account), ok: true, message }
}

export async function saveServiceSettings(
  account: SettingsAccount,
  values: Record<string, unknown>,
): Promise<ServiceSettingsResult> {
  switch (value(values, 'accountAction') || 'keep') {
    case 'keep':
      return result(account, 'No account changes were made.')
    case 'cookie': {
      const etpRt = value(values, 'etpRt')
      if (!etpRt) throw new Error('Paste the etp_rt browser cookie before saving.')
      await account.loginEtpRt(etpRt)
      return result(account, 'Signed in to Crunchyroll with the browser cookie.')
    }
    case 'password': {
      const username = value(values, 'username')
      const password = rawValue(values, 'password')
      if (!username || !password.trim()) throw new Error('Enter both the Crunchyroll email and password before saving.')
      await account.loginPassword(username, password)
      return result(account, 'Signed in to Crunchyroll with email and password.')
    }
    case 'device': {
      await account.requestDeviceCode()
      return result(account, 'TV code ready.')
    }
    case 'logout':
      account.logout()
      return result(account, 'Signed out of Crunchyroll.')
    default:
      throw new Error('Choose a supported Crunchyroll account action.')
  }
}
