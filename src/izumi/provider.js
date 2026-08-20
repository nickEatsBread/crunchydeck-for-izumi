/* Crunchyroll onlinestream-provider for Izumi.
 * Talks to the local sidecar. Do not run this file by itself. */
class Provider {
  constructor() {
    this.base = '__BASE__'
  }

  async getSettings() {
    return { episodeServers: ['Crunchyroll'], supportsDub: true }
  }

  async search(opts) {
    const q = new URLSearchParams()
    q.set('query', opts && opts.query != null ? String(opts.query) : '')
    q.set('dub', opts && opts.dub ? '1' : '0')
    if (opts && opts.year != null && opts.year !== '') q.set('year', String(opts.year))
    const data = await this.rpc('/api/search?' + q.toString())
    return data.results || []
  }

  async findEpisodes(id) {
    const data = await this.rpc('/api/episodes?' + new URLSearchParams({ id: String(id) }))
    return data.episodes || []
  }

  async findEpisodeServer(episode, server) {
    const id = typeof episode === 'string' ? episode : episode && episode.id
    const data = await this.rpc('/api/play?' + new URLSearchParams({
      id: String(id || ''),
      server: String(server || 'Crunchyroll'),
    }))
    return data
  }

  async rpc(path) {
    const res = await fetch(this.base + path, { headers: { accept: 'application/json' } })
    const text = await res.text()
    let json = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { error: text } }
    if (!res.ok) throw new Error(json.error || json.message || ('Crunchyroll source HTTP ' + res.status))
    return json
  }
}
