// Magpie starts Bun in its settings directory. Bun exposes enumerable
// CommonJS exports as named exports; host.js turns each function into hooks.
// Read only this package's non-secret plugin options, never account storage.
const { installedOptions, normalizeRegistry, providerId } = require('./registry.cjs')
const registry = installedOptions(process.cwd(), __dirname)
const check = options => {
  if (JSON.stringify(normalizeRegistry(options)) !== JSON.stringify(registry)) throw new Error('Site options changed during loading; reload the plugin')
}
module.exports = {
  template: async (_input, options) => { check(options); return {} },
  ...Object.fromEntries(registry.sites.map(site => [providerId(site.site), async (input, options) => {
    check(options)
    const { createPlugin } = await import('./plugin.mjs')
    return createPlugin(input, site)
  }])),
}
