// Crunchyroll's own language choices for a profile (as Crunchy Deck and the official apps offer them).
export const AUDIO_LANGUAGES: Record<string, string> = {
  'ja-JP': 'Japanese',
  'en-US': 'English (US)',
  'de-DE': 'Deutsch',
  'es-419': 'Español (América Latina)',
  'es-ES': 'Español (España)',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  'ru-RU': 'Русский',
  'ar-SA': 'العربية',
  'hi-IN': 'हिन्दी',
}

export const SUBTITLE_LANGUAGES: Record<string, string> = {
  'en-US': 'English (US)',
  'de-DE': 'Deutsch',
  'es-419': 'Español (América Latina)',
  'es-ES': 'Español (España)',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  'ru-RU': 'Русский',
  'ar-SA': 'العربية',
  'hi-IN': 'हिन्दी',
}

export const DISPLAY_LANGUAGES: Record<string, string> = {
  'en-US': 'English',
  'de-DE': 'Deutsch',
  'es-419': 'Español (América Latina)',
  'es-ES': 'Español (España)',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  'ru-RU': 'Русский',
  'ar-SA': 'العربية',
  'hi-IN': 'हिन्दी',
  'th-TH': 'ไทย',
  'ko-KR': '한국어',
  'pl-PL': 'Polski',
  'zh-TW': '中文 (台灣)',
}

/** Select options from a language map, the current code kept even when it is not listed. */
export function languageOptions(map: Record<string, string>, current: string, lead: Array<{ value: string; label: string }> = []): Array<{ value: string; label: string }> {
  const options = [...lead, ...Object.entries(map).map(([value, label]) => ({ value, label }))]
  if (current && !options.some((option) => option.value === current)) options.splice(lead.length, 0, { value: current, label: current })
  return options
}
