import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../src/fetch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText

function install(fetch) {
  const messages = []
  const context = { fetch, Error, AggregateError, console: { error: message => messages.push(message) } }
  runInNewContext(source, context)
  return { fetch: context.fetch, messages }
}

test('fetch wrapper preserves request arguments and response', async () => {
  const response = new Response('ok')
  let received
  const wrapped = install(async (...args) => {
    received = args
    return response
  })
  const options = { method: 'GET', headers: { authorization: 'fake-secret' } }
  assert.equal(await wrapped.fetch('https://example.invalid', options), response)
  assert.equal(received[0], 'https://example.invalid')
  assert.equal(received[1], options)
  assert.deepEqual(wrapped.messages, [])
})

test('fetch wrapper reports DNS code without logging credentials and preserves error', async () => {
  const error = new TypeError('private error message', {
    cause: Object.assign(new Error('private cause message'), { code: 'ENOTFOUND' })
  })
  const wrapped = install(async () => {
    throw error
  })
  await assert.rejects(
    wrapped.fetch('https://example.invalid', { headers: { authorization: 'fake-secret' } }),
    value => value === error
  )
  assert.deepEqual(wrapped.messages, ['OCI fetch transport failure: ENOTFOUND'])
})

test('fetch wrapper reports distinct aggregate connection codes', async () => {
  const error = new TypeError('fetch failed', {
    cause: new AggregateError([
      { code: 'ETIMEDOUT' },
      { code: 'ENETUNREACH' },
      { code: 'ETIMEDOUT' },
      { code: 'private-data-must-not-appear' }
    ])
  })
  const wrapped = install(async () => {
    throw error
  })
  await assert.rejects(wrapped.fetch('https://example.invalid'), value => value === error)
  assert.deepEqual(wrapped.messages, ['OCI fetch transport failure: ETIMEDOUT, ENETUNREACH'])
})

test('fetch wrapper preserves errors without transport codes', async () => {
  const wrapped = install(async () => {
    throw 'private rejection'
  })
  await assert.rejects(wrapped.fetch('https://example.invalid'), value => value === 'private rejection')
  assert.deepEqual(wrapped.messages, ['OCI fetch transport failure: no error code available'])
})
