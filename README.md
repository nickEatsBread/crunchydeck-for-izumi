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

## Set up izumi with the Crunchy Deck pack

The easiest way in. One link sets izumi up for Crunchyroll: it installs this source and the Crunchy
Deck theme, plays the Crunchyroll intro when izumi starts, and asks you to sign in. On Linux and the
Steam Deck it also downloads Google's Widevine module in the background, which izumi needs to play
Crunchyroll's protected video there. Windows plays protected video without it.

- **Already have izumi (0.1.75 or newer):** open
  `izumi://pack?url=https://raw.githubusercontent.com/nickEatsBread/crunchydeck-for-izumi/main/izumi/pack.json`,
  or paste the pack link into **Settings → Sources and store → Set up from a pack**.
- **Steam Deck, starting from scratch:** in Desktop Mode, open a terminal and run

  ```
  curl -fsSL https://flatpak.izumi.watch/install.sh | bash -s -- --pack=https://raw.githubusercontent.com/nickEatsBread/crunchydeck-for-izumi/main/izumi/pack.json
  ```

  izumi installs, and the next time it opens it shows the pack for you to set up.

izumi shows everything the pack adds before anything is installed. Nothing happens until you choose
**Set up with Crunchy Deck**.

> **Google's Widevine licence.** By setting up this pack on Linux (including the Steam Deck), you
> accept the licence that Google ships with its Widevine content decryption module. izumi then
> downloads the module from Google, in the background, the same way browsers fetch it. The module is
> never bundled in this repository, the pack or izumi. You can remove it any time in izumi under
> **Settings → Playback → Protected video**.

The pack's files live in [`izumi/`](izumi/). `scripts/build-izumi-store.mjs` regenerates
`store.json` and `pack.json` from the built packages.

## Add it to Izumi by hand

1. `npm install`
2. `npm start`
3. Open http://127.0.0.1:17871/ and sign in.
4. In Izumi: **Settings → Sources / Extensions** and paste:

   `http://127.0.0.1:17871/index.json`

The startup output also prints a tokenized `Android` manifest URL for devices on the same LAN.
Install that URL in Izumi on Android to let its System WebView use Shaka + Widevine while the
sidecar remains on the signed-in PC. The token grants playback/search access but cannot log out or
change the Crunchyroll account. It is also the address Izumi sends to Watch Together guests.

Do not paste it into the Stremio addon URL box. Izumi upgrades those to
HTTPS, which a local HTTP server cannot serve. The **extension** list accepts
`http://127.0.0.1`.

Keep this process running while you use Izumi.

### Sign-in options

An installed `.izumi-ext` package exposes these options from its **Settings** button inside Izumi.
The standalone configuration page remains available at the sidecar address. Tokens and passwords
are write-only and are never returned to Izumi when the settings dialog is opened again.

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

Crunchyroll's current play API returns **Widevine DASH** (CENC). The source:

- gives Izumi a local deferred row without opening a Crunchyroll play session
- opens one official play session only when Shaka requests the selected row
- proxies the manifest and segments with the correct Referer / Origin /
  Authorization headers (CDN hotlink protection)
- proxies and unwraps the Widevine license response for Izumi's generic Shaka player
- exposes Crunchyroll's official ASS/VTT subtitle URLs
- releases the play token when Izumi switches streams or closes the player

The matching Izumi build needs its Shaka/WebView2 DRM player path. libmpv by
itself cannot decrypt these streams.

Many Crunchyroll plans allow **one concurrent stream**. Picker discovery does
not consume that slot. The selected stream is released explicitly; if the
process crashes, the sidecar records the token and releases it on next start.

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
