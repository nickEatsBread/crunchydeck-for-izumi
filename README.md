# CrunchyDeck for izumi

Watch Crunchyroll in [izumi](https://github.com/nickEatsBread/izumi) with your own Crunchyroll account.

## Features

- Your Crunchyroll account as an izumi source: search, episodes, dubs and subtitles
- Subtitles styled as on Crunchyroll, with Crunchyroll's subtitle fonts (each downloaded once and kept on your device)
- The CrunchyDeck theme
- The Crunchyroll intro when izumi starts
- Protected playback on Linux and the Steam Deck

You need a Crunchyroll account, and a premium plan for premium titles.

## Install

You need [izumi 0.1.75 or newer](https://github.com/nickEatsBread/izumi/releases/latest).

1. Copy the [pack link](https://raw.githubusercontent.com/nickEatsBread/crunchydeck-for-izumi/main/izumi/pack.json)
   (right-click it, then **Copy link**). It's the link izumi sets everything up from.
2. In izumi, open **Settings → Sources and store → Set up from a pack** and paste it.
3. izumi lists everything the pack adds. Choose **Set up with CrunchyDeck for izumi**, then sign in.

**Steam Deck without izumi yet:** in Desktop Mode, open a terminal and run the command below.
izumi installs and offers the pack the next time it opens.

```
curl -fsSL https://flatpak.izumi.watch/install.sh | bash -s -- --pack=https://raw.githubusercontent.com/nickEatsBread/crunchydeck-for-izumi/main/izumi/pack.json
```

> On Linux and the Steam Deck, izumi downloads Google's Widevine module to play protected video.
> Setting up the pack means you accept Google's licence for it. The module is never bundled here.
> Remove it any time in **Settings → Playback → Protected video**.

## Signing in

| Method | Notes |
| --- | --- |
| Device code | Pair at [crunchyroll.com/activate](https://www.crunchyroll.com/activate) and keep the sign-in page open until it's approved. |
| Email + password | Crunchyroll may turn this off for some accounts. |
| `etp_rt` cookie | Copy it from crunchyroll.com in your browser's DevTools (Application → Cookies). |

Many Crunchyroll plans allow one stream at a time. Browsing doesn't use it; playing does, and closing
the player frees it.

## Development

### Run the source by hand

1. `npm install`, then `npm start`.
2. Open http://127.0.0.1:17871/ and sign in.
3. In izumi, open **Settings → Sources / Extensions** and add `http://127.0.0.1:17871/index.json`.
   Use the extension list, not the Stremio add-on box, which only takes HTTPS.

Keep the process running while you use izumi. The startup output also prints a tokenized address for
izumi on Android on the same network. That token can search and play but can't sign out or change the
account.

To import a Netscape cookie dump: `npm run import-cookies -- "C:\path\to\cookies.txt"`. Sessions are
stored in `~/.crunchyroll-source-izumi/` (`%USERPROFILE%\.crunchyroll-source-izumi\` on Windows).

### Tests

```
npm test          # unit tests, no network
npm run test:live # against Crunchyroll (needs etp_rt or CR_COOKIES_FILE)
```

### Releases

Push a `v<version>` tag that matches `package.json`. CI builds and signs the packages with the
`IZUMI_SIGNING_KEY` secret, publishes them on the tag's release and refreshes `izumi/pack.json` and
`izumi/store.json`. Always sign with the same key: izumi refuses an update signed by another.

## Not affiliated

Not affiliated with or endorsed by Crunchyroll, LLC or Sony. You need your own Crunchyroll account.
