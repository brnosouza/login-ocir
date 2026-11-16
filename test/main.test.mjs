import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'

let state
mock.module('os', { namedExports: { homedir: () => state.directory } })
mock.module('@actions/core', {
  namedExports: {
    getInput: () => {
      if (!state.token) throw new Error('Input required and not supplied: auth_token')
      return state.token
    },
    setOutput: (name, value) => (state.outputs[name] = value),
    setFailed: message => state.failures.push(message),
    saveState: (name, value) => (state.saved[name] = value),
    info: message => state.messages.push(message)
  }
})
mock.module('oci-common', {
  namedExports: {
    Region: { fromRegionId: () => ({ regionId: 'us-ashburn-1' }) },
    SimpleAuthenticationDetailsProvider: class {
      getRegion() {
        return { regionId: 'us-ashburn-1' }
      }
      getTenantId() {
        return 'tenancy-id'
      }
      getUser() {
        return 'user-id'
      }
    }
  }
})
mock.module('oci-artifacts', {
  namedExports: {
    ArtifactsClient: class {
      async getContainerConfiguration(request) {
        assert.deepEqual(request, { compartmentId: 'tenancy-id' })
        if (state.error) throw state.error
        return { containerConfiguration: { namespace: 'namespace' } }
      }
    }
  }
})
mock.module('oci-identity', {
  namedExports: {
    IdentityClient: class {
      async listRegions() {
        return { items: state.regions }
      }
      async getUser(request) {
        assert.deepEqual(request, { userId: 'user-id' })
        return { user: { name: 'example-user' } }
      }
    }
  }
})

const { loginOcir, logoutOcir } = await import('../src/main.ts')
beforeEach(() => {
  state = {
    directory: mkdtempSync(join(tmpdir(), 'login-ocir-test-')),
    outputs: {},
    failures: [],
    saved: {},
    messages: [],
    token: 'fake-auth-token',
    regions: [{ name: 'us-ashburn-1', key: 'IAD' }]
  }
})
afterEach(() => rmSync(state.directory, { recursive: true, force: true }))

function configPath() {
  return join(state.directory, '.docker', 'config.json')
}

function writeConfig(value) {
  mkdirSync(join(state.directory, '.docker'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(value), { mode: 0o600 })
}

function readConfig() {
  return JSON.parse(readFileSync(configPath(), 'utf8'))
}

test('login creates private Docker credentials and saves post-action state', async () => {
  await loginOcir()
  const auth = readConfig().auths['iad.ocir.io'].auth
  assert.equal(Buffer.from(auth, 'base64').toString(), 'namespace/example-user:fake-auth-token')
  assert.equal(statSync(configPath()).mode & 0o777, 0o600)
  assert.deepEqual(state.outputs, { ocir_endpoint: 'iad.ocir.io', ocir_username: 'namespace/example-user' })
  assert.deepEqual(state.saved, { registry: 'iad.ocir.io', logout: 'true' })
  assert.deepEqual(state.failures, [])
})

test('login preserves other registries and Docker settings', async () => {
  writeConfig({ auths: { 'other.example': { auth: 'other-token' } }, credsStore: 'desktop' })
  await loginOcir()
  assert.equal(readConfig().auths['other.example'].auth, 'other-token')
  assert.equal(readConfig().credsStore, 'desktop')
  assert.ok(readConfig().auths['iad.ocir.io'])
  assert.deepEqual(state.failures, [])
})

test('login adds auths to existing configuration without losing settings', async () => {
  writeConfig({ credsStore: 'desktop' })
  await loginOcir()
  assert.equal(readConfig().credsStore, 'desktop')
  assert.ok(readConfig().auths['iad.ocir.io'])
  assert.deepEqual(state.failures, [])
})

test('logout removes only selected registry credentials', () => {
  writeConfig({ auths: { 'iad.ocir.io': { auth: 'token' }, 'other.example': { auth: 'other-token' } } })
  logoutOcir('iad.ocir.io')
  assert.deepEqual(readConfig(), { auths: { 'other.example': { auth: 'other-token' } } })
  assert.deepEqual(state.failures, [])
  assert.equal(state.messages.length, 1)
})

test('invalid existing JSON is never overwritten by login or logout', async () => {
  writeConfig({})
  writeFileSync(configPath(), '{broken-json')
  await loginOcir()
  logoutOcir('iad.ocir.io')
  assert.equal(readFileSync(configPath(), 'utf8'), '{broken-json')
  assert.equal(state.failures.length, 2)
  assert.deepEqual(state.saved, {})
})

test('unknown endpoint fails without writing credentials', async () => {
  state.regions = []
  await loginOcir()
  assert.deepEqual(state.failures, ['Unable to determine OCIR endpoint.'])
  assert.equal(existsSync(configPath()), false)
  assert.deepEqual(state.saved, {})
})

test('SDK failure leaves existing credentials unchanged', async () => {
  writeConfig({ auths: { 'other.example': { auth: 'other-token' } } })
  const original = readFileSync(configPath(), 'utf8')
  state.error = new Error('OCI unavailable')
  await loginOcir()
  assert.deepEqual(state.failures, ['OCI unavailable'])
  assert.equal(readFileSync(configPath(), 'utf8'), original)
  assert.deepEqual(state.saved, {})
})

test('missing auth token fails without writing credentials', async () => {
  state.token = ''
  await loginOcir()
  assert.deepEqual(state.failures, ['Input required and not supplied: auth_token'])
  assert.equal(existsSync(configPath()), false)
})

function runBundle(env = {}) {
  const directory = join(state.directory, 'bundle')
  cpSync(new URL('../dist', import.meta.url), directory, { recursive: true })
  const result = spawnSync(process.execPath, ['index.js'], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: state.directory,
      USERPROFILE: state.directory,
      OCI_CLI_TENANCY: '',
      OCI_CLI_USER: '',
      OCI_CLI_FINGERPRINT: '',
      OCI_CLI_KEY_CONTENT: '',
      OCI_CLI_REGION: 'us-ashburn-1',
      STATE_logout: '',
      STATE_registry: '',
      ...env
    },
    encoding: 'utf8',
    timeout: 10000
  })
  assert.ifError(result.error)
  assert.doesNotMatch(result.stdout + result.stderr, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|require is not defined/)
  return result
}

test('standalone ESM bundle loads under Node and reports missing credentials', () => {
  const result = runBundle()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /::error::/)
  assert.equal(existsSync(configPath()), false)
})

test('bundled post-action removes saved registry credentials', () => {
  writeConfig({ auths: { 'iad.ocir.io': { auth: 'token' }, 'other.example': { auth: 'other-token' } } })
  const result = runBundle({ STATE_logout: 'true', STATE_registry: 'iad.ocir.io' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(readConfig(), { auths: { 'other.example': { auth: 'other-token' } } })
})
