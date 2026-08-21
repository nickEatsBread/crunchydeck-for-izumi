import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({ browserURL: process.env.IZUMI_CDP ?? 'http://127.0.0.1:9223', defaultViewport: null })
const pages = await browser.pages()
const page = pages.find((candidate) => candidate.url().includes('localhost:1420')) ?? pages[0]
if (!page) throw new Error('no izumi page')
const cdp = await page.createCDPSession()
const changed = new Promise((resolve) => cdp.once('LayerTree.layerTreeDidChange', resolve))
await cdp.send('LayerTree.enable')
const event = await Promise.race([changed, new Promise((resolve) => setTimeout(() => resolve({ layers: [] }), 2_000))])
const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
const video = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'video' })
const described = video.nodeId ? await cdp.send('DOM.describeNode', { nodeId: video.nodeId }) : null
const backend = described?.node?.backendNodeId
const layers = event.layers ?? []
console.log('videoBackendNodeId', backend)
console.log('layers', layers.map((layer) => ({
  id: layer.layerId,
  parent: layer.parentLayerId,
  backend: layer.backendNodeId,
  width: layer.width,
  height: layer.height,
  draws: layer.drawsContent,
})))
for (const layer of layers.filter((candidate) => candidate.drawsContent && candidate.width > 300 && candidate.height > 150)) {
  try {
    const snapshot = await cdp.send('LayerTree.makeSnapshot', { layerId: layer.layerId })
    const replay = await cdp.send('LayerTree.replaySnapshot', { snapshotId: snapshot.snapshotId, fromStep: 0, toStep: 0, scale: 0.5 })
    await cdp.send('LayerTree.releaseSnapshot', { snapshotId: snapshot.snapshotId })
    console.log('snapshot', layer.layerId, layer.backendNodeId, replay.dataURL?.length ?? 0, replay.dataURL?.slice(0, 30))
  } catch (error) {
    console.log('snapshotError', layer.layerId, String(error))
  }
}
await cdp.send('LayerTree.disable').catch(() => {})
await browser.disconnect()
