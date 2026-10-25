import assert from 'node:assert/strict'
import { createServer, request, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { sendMediaStream } from '../src/server.js'

/** A fake upstream body: endless 64 KB chunks, or none at all when `stall` is set. */
function upstream(stall = false) {
  const state = { cancelled: false, reads: 0 }
  const body = {
    getReader() {
      return {
        async read() {
          state.reads += 1
          if (stall) return new Promise<{ done: boolean; value?: Uint8Array }>(() => {})
          return { done: false, value: new Uint8Array(64 * 1024) }
        },
        async cancel() { state.cancelled = true },
        releaseLock() {},
      }
    },
  }
  return { body, state }
}

async function serve(handler: (res: ServerResponse) => Promise<void>) {
  let finished!: Promise<void>
  const server = createServer((_req, res) => { finished = handler(res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return {
    port,
    finished: () => finished,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

test('a client that leaves while the proxy waits for drain releases the upstream body', async () => {
  const { body, state } = upstream()
  const server = await serve((res) => sendMediaStream(res, { status: 200, contentType: 'video/mp4', body, headers: {} }))
  const req = request({ port: server.port, path: '/' })
  req.end()
  const [res] = await once(req, 'response')
  res.pause() // never read: the proxy's writes back up until it waits for 'drain'
  await new Promise((resolve) => setTimeout(resolve, 200))
  req.destroy()
  await server.finished()
  assert.equal(state.cancelled, true)
  server.close()
})

test('an upstream that goes silent is cancelled instead of holding the request forever', async () => {
  const { body, state } = upstream(true)
  const server = await serve((res) => sendMediaStream(res, { status: 200, contentType: 'video/mp4', body, headers: {} }, 100))
  // Nothing ever arrives, so the client only sees the connection drop.
  const req = request({ port: server.port, path: '/' })
  const dropped = once(req, 'error')
  req.end()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await server.finished()
  assert.equal(state.cancelled, true)
  const [error] = await dropped
  assert.match(String(error), /hang up|ECONNRESET/)
  server.close()
})
