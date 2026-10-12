const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)
function normalizeSite(value) {
  const u = new URL(value)
  if (u.username || u.password || u.search || u.hash) throw new Error('Site URL must contain no credentials, query or fragment')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('HTTPS is required except for a loopback test server')
  return u.href.replace(/\/+$/, '')
}
const providerId = url => 'new-api-' + createHash('sha256').update(normalizeSite(url)).digest('hex').slice(0, 16)

function normalizeRegistry(value = {}) {
  if (!plain(value) || Object.keys(value).some(k => k !== 'sites') || !Array.isArray(value.sites ?? [])) throw new Error('New API options must contain only a sites array; credentials belong in Magpie login')
  const seen = new Set()
  return { sites: (value.sites ?? []).map(site => {
    if (!plain(site) || Object.keys(site).some(k => !['site', 'name', 'profiles', 'models'].includes(k))) throw new Error('Invalid site fields; do not put credentials in plugin options')
    const url = normalizeSite(site.site)
    if (seen.has(url)) throw new Error('Duplicate site URL')
    seen.add(url)
    if (!text(site.name)) throw new Error('Each site needs a display name')
    const profiles = site.profiles ?? { unverified: {} }, models = site.models ?? []
    if (!plain(profiles) || !Object.keys(profiles).length) throw new Error('Invalid profiles')
    for (const [name, p] of Object.entries(profiles)) if (!text(name) || !plain(p) || Object.keys(p).some(k => k !== 'multiplier') || (p.multiplier !== undefined && (!Number.isFinite(p.multiplier) || p.multiplier < 0))) throw new Error('Invalid billing profile')
    if (!Array.isArray(models)) throw new Error('Invalid models')
    const ids = new Set()
    for (const m of models) {
      if (!plain(m) || Object.keys(m).some(k => !['id', 'protocol', 'context', 'output', 'tools', 'image', 'reasoning'].includes(k)) || !text(m.id) || ids.has(m.id) || !['chat', 'responses', 'messages'].includes(m.protocol ?? 'chat')) throw new Error('Invalid model declaration')
      ids.add(m.id)
      for (const key of ['context', 'output']) if (m[key] !== undefined && (!Number.isSafeInteger(m[key]) || m[key] < 0)) throw new Error('Invalid model limit')
      for (const key of ['tools', 'image', 'reasoning']) if (m[key] !== undefined && typeof m[key] !== 'boolean') throw new Error('Invalid model capability')
    }
    return { site: url, name: site.name, profiles, models }
  }) }
}

function samePath(a, b) {
  try { a = fs.realpathSync(a); b = fs.realpathSync(b) } catch { return false }
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
function isEntry(entry, packageDir) {
  const spec = entry?.spec
  if (typeof spec !== 'string') return false
  if (spec === '@klarkxy/magpie-new-api' || spec.startsWith('@klarkxy/magpie-new-api@')) return true
  const target = spec.startsWith('file://') ? require('node:url').fileURLToPath(spec) : path.resolve(spec)
  return samePath(target, packageDir) || samePath(target, path.join(packageDir, 'index.cjs'))
}
function installedOptions(configDir, packageDir) {
  const list = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins.json'), 'utf8'))
  const entries = list.plugins?.filter(p => isEntry(p, packageDir)) ?? []
  if (entries.length !== 1) throw new Error('Install one New API package entry before loading it')
  return normalizeRegistry(entries[0].options)
}
module.exports = { normalizeSite, providerId, normalizeRegistry, isEntry, installedOptions }
