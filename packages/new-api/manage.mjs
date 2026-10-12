#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import registry from './registry.cjs'
const { normalizeRegistry, normalizeSite, providerId, isEntry } = registry
const packageDir = dirname(fileURLToPath(import.meta.url))

export async function manage(configDir, command, args = {}) {
  const file = join(resolve(configDir), 'plugins.json')
  let bytes
  try { bytes = await readFile(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const list = bytes ? JSON.parse(bytes) : { plugins: [] }
  if (!Array.isArray(list.plugins)) throw new Error('Invalid plugin list')
  const found = list.plugins.filter(p => isEntry(p, packageDir))
  if (found.length > 1) throw new Error('Multiple New API entries; inspect before editing')
  const entry = found[0]
  const options = normalizeRegistry(entry?.options)
  if (command === 'list') return { sites: options.sites.map(s => ({ ...s, providerId: providerId(s.site) })), installed: Boolean(entry), packageDir }
  if (command !== 'install' && !entry) throw new Error('Install the generic package first')
  if (command === 'install') {
    if (entry) return { unchanged: true, packageDir }
    list.plugins.push({ spec: packageDir, options })
  } else if (command === 'add') {
    if (options.sites.some(s => s.site === normalizeSite(args.url))) throw new Error('Site already exists')
    options.sites.push({ site: args.url, name: args.name })
    entry.options = normalizeRegistry(options)
  } else if (command === 'set') {
    const index = options.sites.findIndex(s => s.site === normalizeSite(args.url))
    if (index < 0) throw new Error('Site not found')
    const update = JSON.parse(await readFile(args.file, 'utf8'))
    if (normalizeSite(update.site) !== options.sites[index].site) throw new Error('Changing a site URL creates a different identity; add a separate instance')
    options.sites[index] = update; entry.options = normalizeRegistry(options)
  } else if (command === 'remove') {
    const index = options.sites.findIndex(s => s.site === normalizeSite(args.url))
    if (index < 0) throw new Error('Site not found')
    options.sites.splice(index, 1); entry.options = normalizeRegistry(options)
  } else throw new Error('Unsupported command')
  await mkdir(dirname(file), { recursive: true })
  const backup = join(configDir, 'backups', 'new-api-manage-' + new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(backup, { recursive: true })
  if (bytes) await writeFile(join(backup, 'plugins.json'), bytes, { flag: 'wx', mode: 0o600 })
  let now
  try { now = await readFile(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (Boolean(now) !== Boolean(bytes) || (now && !now.equals(bytes))) throw new Error('Plugin list changed; stop without overwriting it')
  const temp = file + '.new-api-manage.tmp'
  await writeFile(temp, JSON.stringify(list, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temp, file)
  return { packageDir, command, backup, sites: normalizeRegistry(list.plugins.find(p => isEntry(p, packageDir)).options).sites.map(s => ({ name: s.name, site: s.site, providerId: providerId(s.site) })) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2), args = {}
    for (let n = 0; n < rest.length; n += 2) {
      if (!['--config-dir', '--name', '--url', '--file'].includes(rest[n]) || rest[n + 1] === undefined) throw new Error('Invalid arguments')
      args[rest[n].slice(2)] = rest[n + 1]
    }
    const configDir = args['config-dir'] ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie')
    console.log(JSON.stringify(await manage(configDir, command, args), null, 2))
  } catch (e) { console.error('New API management failed: ' + e.message); process.exitCode = 1 }
}
