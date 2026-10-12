import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import registry from '../registry.cjs'
import { manage } from '../manage.mjs'
const { normalizeRegistry, providerId } = registry

test('registry supports arbitrary independent sites, stable URL identity and rejects secret/duplicate configuration', () => {
  const sites = Array.from({ length: 80 }, (_, n) => ({ site: `https://site-${n}.example.invalid`, name: 'Site ' + n }))
  const config = normalizeRegistry({ sites })
  assert.equal(config.sites.length, 80)
  assert.equal(new Set(config.sites.map(s => providerId(s.site))).size, 80)
  assert.equal(providerId('https://example.invalid/'), providerId('https://example.invalid'))
  assert.deepEqual(config.sites[0].profiles, { unverified: {} })
  for (const input of [{ sites: [sites[0], sites[0]] }, { key: 'fake', sites }, { sites: [{ ...sites[0], key: 'fake' }] },
    { sites: [{ ...sites[0], profiles: { standard: { token: 'fake' } } }] }, { sites: [{ ...sites[0], models: [{ id: 'x', headers: { authorization: 'fake' } }] }] }]) assert.throws(() => normalizeRegistry(input))
})

test('management changes one plugin entry, backs up config, preserves other entries and never touches credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'magpie-new-api-manage-'))
  const file = join(root, 'plugins.json'), auth = join(root, 'plugin-auth.json')
  const other = { spec: 'example-plugin', off: true, options: { untouched: true } }
  await writeFile(file, JSON.stringify({ plugins: [other], prefer: { other: 'example-plugin' } }))
  await writeFile(auth, 'FAKE-CREDENTIAL-SENTINEL')
  const installed = await manage(root, 'install')
  assert.equal((await manage(root, 'install')).unchanged, true)
  await manage(root, 'add', { name: 'First', url: 'https://one.example.invalid/' })
  await manage(root, 'add', { name: 'Second', url: 'https://two.example.invalid' })
  const before = await readFile(file, 'utf8')
  await assert.rejects(manage(root, 'add', { name: 'Duplicate', url: 'https://one.example.invalid' }))
  assert.equal(await readFile(file, 'utf8'), before)
  const listed = await manage(root, 'list')
  assert.equal(listed.sites.length, 2)
  const siteFile = join(root, 'site.local.json')
  await writeFile(siteFile, JSON.stringify({ site: 'https://one.example.invalid', name: 'Renamed', profiles: { vip: { multiplier: 0.5 } } }))
  await manage(root, 'set', { url: 'https://one.example.invalid', file: siteFile })
  assert.equal((await manage(root, 'list')).sites[0].providerId, listed.sites[0].providerId)
  await manage(root, 'remove', { url: 'https://two.example.invalid' })
  const result = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(result.plugins.length, 2); assert.deepEqual(result.plugins[0], other)
  assert.deepEqual(result.prefer, { other: 'example-plugin' })
  assert.equal((await manage(root, 'list')).sites.length, 1)
  assert.equal(await readFile(auth, 'utf8'), 'FAKE-CREDENTIAL-SENTINEL')
  assert.deepEqual(JSON.parse(await readFile(join(installed.backup, 'plugins.json'))).plugins, [other])
})
