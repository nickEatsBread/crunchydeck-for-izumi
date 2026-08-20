export class CrError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string, message?: string) {
    super(message ?? `Crunchyroll HTTP ${status}`)
    this.name = 'CrError'
    this.status = status
    this.body = body
  }
}

export function shortBody(body: string, max = 400): string {
  const trimmed = body.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

export function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
    if (typeof parsed.code === 'string' && parsed.code) return parsed.code
  } catch {
    /* not json */
  }
  return undefined
}
