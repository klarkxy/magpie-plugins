import { createHash } from "node:crypto"

const PROTOCOLS = {
  chat: { npm: "@ai-sdk/openai-compatible", path: "/chat/completions" },
  responses: { npm: "@ai-sdk/openai", path: "/responses" },
  messages: { npm: "@ai-sdk/anthropic", path: "/messages" },
}
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)
const encode = (s) => Buffer.from(s).toString("base64url")
const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16)
const integer = (n) => Number.isSafeInteger(n) && n >= 0

export function normalizeSite(value) {
  const u = new URL(value)
  if (u.username || u.password || u.search || u.hash) throw new Error("Site URL must contain no credentials, query or fragment")
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    throw new Error("HTTPS is required except for a loopback test server")
  return u.href.replace(/\/+$/, "")
}

function optionsOf(options) {
  const site = normalizeSite(options?.site)
  const id = "new-api-" + digest(site)
  const profiles = structuredClone(options.profiles ?? { standard: {} })
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles) || !Object.keys(profiles).length)
    throw new Error("At least one billing profile is required")
  for (const [name, p] of Object.entries(profiles)) {
    if (!text(name) || !p || typeof p !== "object" || Array.isArray(p) ||
        (p.multiplier !== undefined && !(Number.isFinite(p.multiplier) && p.multiplier >= 0)))
      throw new Error("Invalid billing profile")
  }
  const models = structuredClone(options.models ?? [])
  if (!Array.isArray(models)) throw new Error("models must be an array")
  const seen = new Set()
  for (const m of models) {
    if (!text(m?.id) || seen.has(m.id) || !PROTOCOLS[m.protocol ?? "chat"])
      throw new Error("Each model needs a unique id and supported protocol")
    seen.add(m.id)
    for (const n of [m.context, m.output]) if (n !== undefined && !integer(n)) throw new Error("Invalid model limit")
  }
  return { site, id, profiles, models, name: text(options.name) ? options.name : "New API", timeoutMs: 15000 }
}

function stateOf(auth, cfg) {
  const md = auth?.metadata
  if (auth?.type !== "api" || !text(auth.key) || !md || md.site !== cfg.site ||
      !text(md.group) || md.group === "auto" || !text(md.profile) || !Object.hasOwn(cfg.profiles, md.profile))
    throw new Error("New API account metadata is missing or mismatches this site; reconnect with an explicit effective group and billing profile")
  return { key: auth.key, group: md.group, profile: md.profile }
}

export function aliasOf(cfg, state, raw, protocol = "chat") {
  return ["na", digest(cfg.site), encode(state.group), encode(state.profile), protocol, encode(raw)].join(".")
}

function entry(cfg, state, m) {
  const protocol = m.protocol ?? "chat"
  const id = aliasOf(cfg, state, m.id, protocol)
  const multiple = cfg.profiles[state.profile].multiplier
  const note = multiple === undefined ? "倍率未知" : "×" + multiple
  return [id, {
    id, providerID: cfg.id,
    name: `${m.id} [${state.group} · ${state.profile} · ${note} · 手动未验证]`,
    // Keep the alias until fetch checks account metadata. Never use raw as api.id.
    api: { id, npm: PROTOCOLS[protocol].npm, url: cfg.site + "/v1" },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    cost: { input: 0, output: 0 },
    capabilities: { temperature: true, toolcall: m.tools === true, reasoning: m.reasoning === true,
      input: { text: true, image: m.image === true }, output: { text: true } },
    variants: {},
  }]
}

async function readJSON(cfg, state, path, signal) {
  let response
  try {
    response = await fetch(cfg.site + path, { headers: { authorization: "Bearer " + state.key },
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]) : AbortSignal.timeout(cfg.timeoutMs) })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new Error("New API metadata service unavailable")
  }
  if (!response.ok) throw new Error("New API metadata HTTP " + response.status)
  try { return await response.json() } catch { throw new Error("New API metadata returned invalid JSON") }
}

async function modelsOf(cfg, state) {
  if (cfg.models.length) return cfg.models
  const body = await readJSON(cfg, state, "/v1/models")
  if (!Array.isArray(body?.data) || !body.data.every(m => text(m?.id))) throw new Error("Invalid New API model list")
  return [...new Map(body.data.map(m => [m.id, { id: m.id }])).values()]
}

function refusal(status, message) {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", message } }), {
    status, headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" },
  })
}

export function quotaOf(body) {
  if (body?.success === false || body?.code === false || !body?.data || body.data.object !== "token_usage")
    throw new Error("Invalid New API token quota envelope")
  const d = body.data
  if (typeof d.unlimited_quota !== "boolean") throw new Error("Unknown token quota limit")
  const out = { plan: "Token 额度（不是共享钱包）", signIn: "kept", windows: [] }
  if (d.unlimited_quota) { out.plan += " · key 不限额"; return out }
  const total = d.total_granted, used = d.total_used, left = d.total_available
  if (![total, used, left].every(integer) || !Number.isSafeInteger(used + left) || used + left !== total)
    throw new Error("Inconsistent New API token quota; no percentage available")
  out.windows = [{ name: "Token 额度", used: total > 0 ? 100 * used / total : 100,
    amount: used, limit: total, unit: "New API quota", display: `${used} / ${total} quota（剩余 ${left}）` }]
  // expires_at is token expiry, never a rolling allowance reset.
  if (integer(d.expires_at) && d.expires_at > 0 && d.expires_at < 8640000000000)
    out.until = new Date(d.expires_at * 1000).toISOString()
  return out
}

export async function createPlugin(_input = {}, options = {}) {
  const cfg = optionsOf(options)
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[cfg.id] = { name: cfg.name, npm: PROTOCOLS.chat.npm, api: cfg.site + "/v1", models: {} }
    },
    provider: {
      id: cfg.id,
      async models(_provider, { auth } = {}) {
        if (!auth) return {}
        const state = stateOf(auth, cfg)
        return Object.fromEntries((await modelsOf(cfg, state)).map(m => entry(cfg, state, m)))
      },
    },
    auth: {
      provider: cfg.id,
      methods: [{
        type: "api", label: "New API 推理 key（手动分组）",
        prompts: [
          { type: "text", key: "group", message: "有效分组（从站点核对；不支持 auto）", validate: v => text(v) && v !== "auto" ? undefined : "填写固定有效分组，不能为 auto" },
          { type: "select", key: "profile", message: "计费身份（手动未验证）", options: Object.keys(cfg.profiles).map(value => ({ label: value, value })) },
        ],
        async authorize(inputs) {
          if (!text(inputs.group) || inputs.group === "auto" || !Object.hasOwn(cfg.profiles, inputs.profile))
            return { type: "failed", error: "Invalid group or billing profile" }
          return { type: "success", metadata: { site: cfg.site, group: inputs.group, profile: inputs.profile } }
        },
      }],
      async loader(getAuth) {
        stateOf(await getAuth(), cfg)
        return {
          baseURL: cfg.site + "/v1", apiKey: "new-api-plugin", // real key stays inside fetch
          async fetch(input, init = {}) {
            const request = input instanceof Request ? input : undefined
            const opts = { ...(request ? { method: request.method, body: request.body, signal: request.signal } : {}), ...init }
            const signal = opts.signal
            signal?.throwIfAborted()
            let state
            try { state = stateOf(await getAuth(), cfg) } catch { return refusal(403, "Account metadata mismatches this New API site") }
            let url, body
            try {
              url = new URL(request ? request.url : String(input))
              body = JSON.parse(typeof opts.body === "string" ? opts.body : await new Response(opts.body).text())
            } catch { return refusal(400, "A JSON inference request is required") }
            if ((opts.method ?? "POST").toUpperCase() !== "POST" || url.search || url.hash)
              return refusal(400, "Unsupported New API request")
            const parts = typeof body?.model === "string" ? body.model.split(".") : []
            const protocol = parts[4]
            let raw
            try { raw = Buffer.from(parts[5] ?? "", "base64url").toString("utf8") } catch {}
            if (parts.length !== 6 || !text(raw) || !PROTOCOLS[protocol] || body.model !== aliasOf(cfg, state, raw, protocol))
              return refusal(403, "Model alias does not belong to this account's site, group and billing profile")
            if (url.href !== cfg.site + "/v1" + PROTOCOLS[protocol].path)
              return refusal(403, "Model protocol or destination mismatches this site")
            if (cfg.models.length && !cfg.models.some(m => m.id === raw && (m.protocol ?? "chat") === protocol))
              return refusal(403, "Model is not configured for this site")
            if (!cfg.models.length && protocol !== "chat") return refusal(403, "Declare non-chat protocol explicitly")
            signal?.throwIfAborted()
            // Forward only protocol headers. Caller auth, cookies and group overrides never leave here.
            const incoming = new Headers(init.headers ?? request?.headers)
            const headers = new Headers({ "content-type": "application/json", authorization: "Bearer " + state.key })
            for (const name of ["accept", "anthropic-version", "anthropic-beta"])
              if (incoming.has(name)) headers.set(name, incoming.get(name))
            return fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, model: raw }),
              signal, redirect: "error" })
          },
        }
      },
      async usage(getAuth) {
        try {
          const state = stateOf(await getAuth(), cfg)
          return quotaOf(await readJSON(cfg, state, "/api/usage/token/"))
        } catch (e) { return { error: e.message, signIn: "kept", windows: [] } }
      },
    },
  }
}
