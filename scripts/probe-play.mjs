import { CrunchyrollApp } from '../src/app.ts'

const id = process.argv[2] || 'GRMGQX55R'
process.env.CR_HTTP = process.env.CR_HTTP || 'fetch'
const app = await CrunchyrollApp.create()
const status = app.status()
console.log('auth', { authenticated: status.authenticated, profile: status.profile, login: status.login })

const token = await app.auth.accessToken()
const profile = app.auth.profile
const { HOSTS } = await import('../src/cr/constants.ts')
const { crHeaders } = await import('../src/cr/headers.ts')

const platforms = profile === 'tv'
  ? [
      `tv/samsung`,
      `tv/android_tv`,
      `console/switch`,
      `android/phone`,
      `androidtv`,
      `web/chrome`,
    ]
  : [`web/chrome`, `web/firefox`]

const bases = profile === 'tv'
  ? [HOSTS.play]
  : [HOSTS.www, HOSTS.play]

const headers = crHeaders({ profile, authorization: `Bearer ${token}`, extra: { Accept: '*/*' } })

for (const base of bases) {
  for (const plat of platforms) {
    const urls = [
      `${base}/v1/${id}/${plat}/play`,
      `${base}/v3/${id}/${plat}/play`,
      `${base}/playback/v3/${id}/${plat}/play`,
    ]
    for (const url of urls) {
      if (!url.startsWith('http')) continue
      const res = await app.transport.request({ url, headers })
      const text = res.text.slice(0, 400)
      let summary = { status: res.status }
      try {
        const j = JSON.parse(res.text)
        summary = {
          status: res.status,
          container: j.videoContainer,
          drm: j.drm?.name || j.drm,
          urlHost: (j.url || '').split('?')[0].slice(-80),
          hasToken: !!j.token,
          hardSubs: Object.keys(j.hardSubs || {}),
        }
        if (j.token && j.url) {
          await app.transport.request({
            url: `${HOSTS.play}/v1/token/${id}/${j.token}`,
            method: 'DELETE',
            headers,
          }).catch(() => {})
        }
      } catch {
        summary.body = text.replace(/\s+/g, ' ').slice(0, 160)
      }
      console.log(res.status, url.replace('https://', ''), JSON.stringify(summary))
    }
  }
}

await app.close()
