import assert from 'node:assert/strict'
import test from 'node:test'

process.env.IZUMI_EMBEDDED_ENTRY = '1'
const { parentAlive } = await import('../src/main.js')

const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }) }

test('the service sees izumi gone, and stays while it runs or is merely not ours to signal', () => {
  assert.equal(parentAlive(process.pid), true)
  assert.equal(parentAlive(4242, fail('ESRCH')), false)
  assert.equal(parentAlive(4242, fail('EPERM')), true)
  assert.equal(parentAlive(4242, () => {}), true)
})
