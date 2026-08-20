# Crunchyroll source for Izumi

A **separate** Crunchyroll source that Izumi loads as a normal
`onlinestream-provider` extension. It does **not** patch Izumi.

You must sign in with your own Crunchyroll account. This is not a scraper of
other people's streams.

## Why this exists

Crunchy Deck already speaks
the Crunchyroll API well, but its HTTP runs in Electron's **Node** `fetch`.
That stack is not the Tizen TV client: it does not send the TV/web header set
and it does not use Chromium's HTTP/2 + HTTP/3/QUIC TLS fingerprint.

[crunchyroll-linux](https://github.com/aarron-lee/crunchyroll-linux) is a port
of the unofficial Tizen Crunchyroll app. It sets this User-Agent on the
Chromium window so **every** request, including HTTPS, looks like the TV app:

```
Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36
```

This source copies that model:

- **TV login** (password / device code) uses the Samsung TV OAuth client and
  Tizen UA against `beta-api.crunchyroll.com` and `tv/samsung/play`.
- **Web login** (`etp_rt` cookie) uses the web OAuth client, Chrome 151 headers
  from a live `www.crunchyroll.com` HAR, and `web/chrome/play`.
- When Google Chrome or Edge is installed, requests go through a hidden
  Chromium page (HTTP/2 + HTTP/3). Otherwise it falls back to Node HTTP/2 with
  the same headers. Force a stack with `CR_HTTP=chrome` or `CR_HTTP=fetch`.

## Add it to Izumi

1. `npm install`
2. `npm start`
3. Open http://127.0.0.1:17871/ and sign in.
4. In Izumi: **Settings → Sources / Extensions** and paste:

   `http://127.0.0.1:17871/index.json`

Do not paste it into the Stremio addon URL box. Izumi upgrades those to
HTTPS, which a local HTTP server cannot serve. The **extension** list accepts
`http://127.0.0.1`.

Keep this process running while you use Izumi.

### Sign-in options

| Method | Client | Notes |
| --- | --- | --- |
| `etp_rt` cookie | Web | Copy from DevTools → Application → Cookies → `etp_rt`. Lasts until Crunchyroll expires it. |
| Email + password | TV | Samsung TV OAuth client. Crunchyroll may disable password grant. |
| Device code | TV | Pair at https://www.crunchyroll.com/activate. **Stay on the sidecar page** — it polls until Crunchyroll approves, then stores the tokens. |

Import a Netscape cookie dump:

```
npm run import-cookies -- "C:\path\to\cookies.txt"
```

## Playback

Crunchyroll's current play API returns **Widevine DASH** (CENC). Izumi plays
HTTP streams in libmpv, which cannot decrypt Widevine. The source still:

- resolves the official play session
- proxies the manifest and segments with the correct Referer / Origin /
  Authorization headers (CDN hotlink protection)
- exposes Crunchyroll's official ASS/VTT subtitle URLs

You will see Crunchyroll rows in Izumi's source picker. Playing the video
itself needs a Widevine CDM in the player — which this repo must not add
inside Izumi.

Many Crunchyroll plans allow **one concurrent stream**. Restarting the sidecar
without a clean shutdown can leak that slot until Crunchyroll expires it
(a few minutes). The sidecar records active play tokens and releases them on
the next start.

## Development

```
npm test          # unit tests, no network
npm run test:live # hits Crunchyroll (needs etp_rt or CR_COOKIES_FILE)
```

Session data lives in `~/.crunchyroll-source-izumi/session.json` (or
`%USERPROFILE%\.crunchyroll-source-izumi\` on Windows).

## Not affiliated

Not affiliated with or endorsed by Crunchyroll, LLC or Sony. Unofficial
personal-use source. You need a valid Crunchyroll subscription for premium
titles in your region.
