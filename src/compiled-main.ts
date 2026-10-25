// Bun embeds text imported this way into the standalone executable. Keep this tiny entry separate
// so normal Node/tsx development still reads the editable files directly from the working tree.
// @ts-nocheck -- `type: text` is a Bun bundler import attribute, not a Node TypeScript loader.
import providerSource from './izumi/provider.js' with { type: 'text' }
import uiSource from './ui/index.html' with { type: 'text' }
import { setEmbeddedAssets } from './server.js'

process.env.IZUMI_EMBEDDED_ENTRY = '1'
setEmbeddedAssets(uiSource, providerSource)
const { start } = await import('./main.js')
await start()
