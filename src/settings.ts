import type { AccountStatus, CrProfile, DeviceCode, DeviceFlowState } from './cr/auth.js'
import type { AccountDetails, ProfilePreferences } from './cr/content.js'
import { AUDIO_LANGUAGES, DISPLAY_LANGUAGES, SUBTITLE_LANGUAGES, languageOptions } from './cr/languages.js'

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
  /** A small square picture beside the label (a profile avatar). */
  image?: string
  /** A wide picture behind the option (a profile wallpaper). */
  backdrop?: string
}

export interface ServiceSettingField {
  key: string
  label: string
  description?: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select'
  /** 'action' picks what a save does; 'profile' is the profile picker, which izumi may offer as
   *  "Who's watching?" outside the settings sheet (it saves `{ accountAction: 'profile', profileId }`). */
  role?: 'action' | 'profile'
  visibleWhen?: ServiceSettingCondition
  required?: boolean
  placeholder?: string
  options?: ServiceSettingOption[]
  /** 'languages': izumi also shows the field in its own Settings › Languages, under this source's
   *  catalog, and saves a change there by posting just that field (no `accountAction`). */
  section?: 'languages'
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
  /** A picture shown with the description: the signed-in profile's avatar. */
  image?: string
  notice?: ServiceSettingsNotice
  refreshAfterMs?: number
  /** Signed in with a profile chosen: izumi's pack setup can move on. */
  complete?: boolean
  fields: ServiceSettingField[]
  values: Record<string, ServiceSettingValue>
  /** The fields holding the profile's audio and subtitle languages: izumi plays this catalog in them.
   *  An empty value is a language the profile never set. */
  languages?: { audio: string; subtitle: string }
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
  /** Optional so plain test accounts need not model profiles. */
  profileChosen?(): boolean
  switchProfile?(profileId: string): Promise<AccountStatus>
  savePreferences?(patch: Partial<ProfilePreferences>): Promise<void>
}

/** Only a TV sign-in (TV code, or email and password) can switch profiles: the cookie grant cannot. */
const canSwitch = (status: AccountStatus, profiles: CrProfile[]) => status.authenticated && status.profile === 'tv' && profiles.length > 1

function accountActions(status: AccountStatus, profiles: CrProfile[], details?: AccountDetails): ServiceSettingOption[] {
  return [
    ...(status.authenticated && details ? [{
      value: 'preferences',
      label: 'Languages and content',
      description: "This profile's display, audio and subtitle languages and mature content, kept by Crunchyroll for all its apps.",
      submitLabel: 'Save preferences',
      submittingLabel: 'Saving…',
    }] : []),
    ...(canSwitch(status, profiles) ? [{
      value: 'profile',
      label: "Choose who's watching",
      description: 'Switch to another profile on this Crunchyroll account.',
      submitLabel: 'Use this profile',
      submittingLabel: 'Switching…',
    }] : []),
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

function description(status: AccountStatus, profile?: CrProfile, details?: AccountDetails): string {
  if (!status.authenticated) {
    return 'Not signed in. Choose a sign-in method below; a Crunchyroll account is required.'
  }
  const identity = profile ? ` as ${profile.name}` : status.accountId ? ` as ${status.accountId}` : ''
  const country = status.country ? ` (${status.country})` : ''
  const membership = details?.premium === true ? ' Membership: Crunchyroll Premium.' : details?.premium === false ? ' Membership: free.' : ''
  return `Signed in${identity}${country} using ${loginLabel(status.login)}.${membership} Credentials are never shown here.`
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

export function serviceSettings(
  account: Pick<SettingsAccount, 'status' | 'deviceStatus' | 'profileChosen'>,
  profiles: CrProfile[] = [],
  details?: AccountDetails,
): ServiceSettingsDocument {
  const prefs = details?.preferences
  // In this sheet under Preferences; in izumi's Settings › Languages as this catalog's Language section.
  const shown = { visibleWhen: { key: 'accountAction', equals: 'preferences' }, section: 'languages' as const }
  const status = account.status()
  const flow = account.deviceStatus()
  const current = profiles.find((profile) => profile.selected)
  // Like the TV app: after signing in to an account with several profiles, ask who's watching.
  const choosing = canSwitch(status, profiles) && !account.profileChosen?.()
  const accountAction = flow.status === 'waiting' ? 'device' : choosing ? 'profile' : status.authenticated ? 'keep' : 'device'
  return {
    version: 1,
    title: 'Crunchyroll settings',
    description: description(status, current, details),
    image: status.authenticated ? current?.avatar : undefined,
    notice: choosing && flow.status !== 'waiting'
      ? {
          tone: 'info',
          title: "Who's watching?",
          message: 'Pick the profile izumi should use. You can change it here later.',
          visibleWhen: { key: 'accountAction', equals: 'profile' },
        }
      : flowNotice(flow),
    refreshAfterMs: flow.status === 'waiting' ? 1_000 : undefined,
    complete: status.authenticated && !choosing && flow.status !== 'waiting',
    ...(status.authenticated ? { languages: { audio: 'audioLanguage', subtitle: 'subtitleLanguage' } } : {}),
    fields: [
      {
        key: 'accountAction',
        label: 'Account action',
        type: 'select',
        role: 'action',
        options: accountActions(status, profiles, details),
      },
      ...(prefs ? [
        { key: 'displayLanguage', label: 'Display language', description: 'Titles, descriptions and row names.', type: 'select' as const, ...shown, options: languageOptions(DISPLAY_LANGUAGES, prefs.displayLanguage) },
        { key: 'audioLanguage', label: 'Audio language', description: 'The dub an episode starts in when it has one.', type: 'select' as const, ...shown, options: languageOptions(AUDIO_LANGUAGES, prefs.audioLanguage) },
        // Crunchyroll stores no "off" and refuses an empty language, so there is no None: a profile
        // that never chose one shows Not set, which izumi reads as no preference.
        { key: 'subtitleLanguage', label: 'Subtitle language', type: 'select' as const, ...shown, options: languageOptions(SUBTITLE_LANGUAGES, prefs.subtitleLanguage, prefs.subtitleLanguage ? [] : [{ value: '', label: 'Not set' }]) },
        { key: 'matureContent', label: 'Mature content', description: 'Show titles rated for adults on this profile.', type: 'boolean' as const, visibleWhen: shown.visibleWhen },
      ] : []),
      {
        key: 'profileId',
        label: 'Profile',
        type: 'select',
        role: 'profile',
        visibleWhen: { key: 'accountAction', equals: 'profile' },
        required: true,
        options: profiles.map((profile) => ({
          value: profile.id,
          label: profile.name,
          description: profile.selected ? 'Current profile' : undefined,
          image: profile.avatar,
          backdrop: profile.wallpaper,
        })),
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
    values: {
      accountAction, profileId: current?.id ?? '', etpRt: '', username: '', password: '',
      ...(prefs ? { displayLanguage: prefs.displayLanguage, audioLanguage: prefs.audioLanguage, subtitleLanguage: prefs.subtitleLanguage, matureContent: prefs.matureContent } : {}),
    },
  }
}

const LANGUAGE_KEYS = ['displayLanguage', 'audioLanguage', 'subtitleLanguage'] as const

function rawValue(values: Record<string, unknown>, key: string): string {
  const candidate = values[key]
  return typeof candidate === 'string' ? candidate : ''
}

function value(values: Record<string, unknown>, key: string): string {
  return rawValue(values, key).trim()
}

function result(account: SettingsAccount, message: string, profiles?: CrProfile[], details?: AccountDetails): ServiceSettingsResult {
  return { ...serviceSettings(account, profiles, details), ok: true, message }
}

export async function saveServiceSettings(
  account: SettingsAccount,
  values: Record<string, unknown>,
  /** Reads the account's profiles after a change (the HTTP handler passes the app's cache). */
  profiles: () => Promise<CrProfile[] | undefined> = async () => undefined,
  /** Reads the membership and preferences after a change. */
  details: () => Promise<AccountDetails | undefined> = async () => undefined,
): Promise<ServiceSettingsResult> {
  const after = async (message: string) => {
    const [list, read] = await Promise.all([profiles().catch(() => undefined), details().catch(() => undefined)])
    return result(account, message, list, read)
  }
  // izumi saves a Language section field on its own: just that field, no action.
  const languagesOnly = LANGUAGE_KEYS.some((key) => typeof values[key] === 'string')
  switch (value(values, 'accountAction') || (languagesOnly ? 'preferences' : 'keep')) {
    case 'keep':
      return after('No account changes were made.')
    case 'preferences': {
      if (!account.savePreferences) throw new Error('This account cannot change its preferences.')
      const patch: Partial<ProfilePreferences> = {}
      // An empty language is one the profile never set: Crunchyroll refuses to store it, so leave it.
      for (const key of LANGUAGE_KEYS) {
        if (value(values, key)) patch[key] = value(values, key)
      }
      // Crunchyroll asks for the password and an email code before any maturity write, even an
      // unchanged one: send it only when it changed, or every language save from this sheet fails.
      if (typeof values.matureContent === 'boolean') {
        const current = (await details().catch(() => undefined))?.preferences.matureContent
        if (values.matureContent !== current) patch.matureContent = values.matureContent
      }
      await account.savePreferences(patch)
      return after('Preferences saved to Crunchyroll.')
    }
    case 'profile': {
      const profileId = value(values, 'profileId')
      if (!profileId) throw new Error('Choose a profile.')
      if (!account.switchProfile) throw new Error('This account cannot switch profiles.')
      await account.switchProfile(profileId)
      return after('Profile switched.')
    }
    case 'cookie': {
      const etpRt = value(values, 'etpRt')
      if (!etpRt) throw new Error('Paste the etp_rt browser cookie before saving.')
      await account.loginEtpRt(etpRt)
      return after('Signed in to Crunchyroll with the browser cookie.')
    }
    case 'password': {
      const username = value(values, 'username')
      const password = rawValue(values, 'password')
      if (!username || !password.trim()) throw new Error('Enter both the Crunchyroll email and password before saving.')
      await account.loginPassword(username, password)
      return after('Signed in to Crunchyroll with email and password.')
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
