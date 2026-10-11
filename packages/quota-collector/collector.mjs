import { createHmac, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile, rename, unlink, open } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const NUMBERS = ["in", "out", "cache_read", "cache_write", "cache_write_1h", "reasoning", "ms", "status", "tries"]
const WINDOW_NUMBERS = ["used", "remaining", "amount", "limit"]
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "max", "xhigh", "ultra", "auto"])
const safeID = v => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v)
const timestamp = v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null
const observedNumber = v => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v) && v.length <= 30)
const numeric = v => typeof v === "number" && Number.isFinite(v)
const own = (obj, key) => Object.hasOwn(obj ?? {}, key)

export function validateConfig(input) {
  const cfg = structuredClone(input)
  const url = new URL(cfg.baseUrl ?? "http://127.0.0.1:3425")
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Collector requires a loopback Magpie gateway URL without credentials or extra path")
  cfg.baseUrl = url.origin
  cfg.intervalMinutes ??= 5
  if (!numeric(cfg.intervalMinutes) || cfg.intervalMinutes < 1 || cfg.intervalMinutes > 1440) throw new Error("intervalMinutes must be between 1 and 1440")
  cfg.staleAfterSeconds ??= Math.max(120, cfg.intervalMinutes * 120)
  if (!numeric(cfg.staleAfterSeconds) || cfg.staleAfterSeconds < 1) throw new Error("Invalid staleAfterSeconds")
  cfg.maxPages ??= 20
  if (!Number.isInteger(cfg.maxPages) || cfg.maxPages < 1 || cfg.maxPages > 200) throw new Error("Invalid maxPages")
  cfg.effectiveAt = timestamp(cfg.effectiveAt)
  if (!cfg.effectiveAt) throw new Error("effectiveAt must identify when this configuration takes effect")
  cfg.percentageDirection ??= "used"
  if (!["used", "remaining", "unknown"].includes(cfg.percentageDirection)) throw new Error("Invalid percentageDirection")
  cfg.coverage ??= "unknown"
  if (!["unknown", "declared-complete"].includes(cfg.coverage)) throw new Error("Invalid coverage declaration")
  cfg.plans ??= []; cfg.accounts ??= []; cfg.models ??= {}
  if (!Array.isArray(cfg.plans) || !Array.isArray(cfg.accounts) || typeof cfg.models !== "object" || cfg.models === null || Array.isArray(cfg.models)) throw new Error("Invalid configuration collections")
  const plans = new Set(), accounts = new Set()
  const selectors = new Set()
  for (const p of cfg.plans) {
    if (!safeID(p.id) || plans.has(p.id) || typeof p.name !== "string" || !/^[a-zA-Z0-9 ()+._-]{1,80}$/.test(p.name) ||
        !numeric(p.price) || p.price < 0 || !/^[A-Z]{3}$/.test(p.currency) || !["day", "week", "month", "year", "unknown"].includes(p.period?.unit) ||
        !Number.isInteger(p.period?.count) || p.period.count < 1) throw new Error("Invalid public plan metadata")
    plans.add(p.id)
  }
  for (const a of cfg.accounts) {
    if (!safeID(a.id) || accounts.has(a.id) || typeof a.provider !== "string" || typeof a.user !== "string" ||
        (a.planId != null && !plans.has(a.planId)) || (a.poolId != null && !safeID(a.poolId))) throw new Error("Invalid explicit account/plan/pool mapping")
    accounts.add(a.id)
    const selector = JSON.stringify([a.provider, a.user, a.from ?? ""])
    if (selectors.has(selector)) throw new Error("Account quota selectors must be unambiguous")
    selectors.add(selector)
  }
  for (const name of Object.values(cfg.models)) if (!safeID(name)) throw new Error("Model export names must be explicitly public IDs")
  return cfg
}

function rawNumbers(source, fields) {
  const out = {}, unknown = [], invalid = []
  for (const field of fields) {
    if (!own(source, field)) { unknown.push(field); continue }
    if (observedNumber(source[field])) out[field] = source[field]
    if (!numeric(source[field]) || source[field] < 0) invalid.push(field)
  }
  return { raw: out, unknown, invalid }
}

export class Collector {
  constructor({ dataFile, config, fetcher = fetch, clock = () => new Date(), persist, requestTimeoutMs = 15000 }) {
    this.file = resolve(dataFile); this.configReader = typeof config === "function" ? config : () => config
    this.fetcher = fetcher; this.clock = clock; this.persistOverride = persist; this.requestTimeoutMs = requestTimeoutMs
    this.paused = false; this.stopped = false; this.inflight = null
  }

  async open() {
    await mkdir(dirname(this.file), { recursive: true })
    try { this.lock = await open(this.file + ".lock", "wx", 0o600) } catch { throw new Error("Collector state is locked; stop the other collector before opening it") }
    try {
      let state
      try { state = JSON.parse(await readFile(this.file, "utf8")) } catch (e) { if (e.code !== "ENOENT") throw new Error("Collector state is unreadable; preserve it and restore a backup") }
      if (state && (state.schema !== 1 || !/^[a-f0-9]{64}$/.test(state.salt) || !Array.isArray(state.samples) || !Array.isArray(state.requests) || !Array.isArray(state.versions)))
        throw new Error("Unsupported collector state")
      this.state = state ?? { schema: 1, salt: randomBytes(32).toString("hex"), samples: [], requests: [], versions: [] }
      // Persist the salt before sampling so failed/restarted first reads keep stable pseudonyms.
      await this.commit(this.state)
      return this
    } catch (e) { await this.close(); throw e }
  }

  hash(value) { return createHmac("sha256", this.state.salt).update(JSON.stringify(value)).digest("hex").slice(0, 32) }

  async commit(next) {
    try {
      if (this.persistOverride) await this.persistOverride(next)
      else {
        const scratch = this.file + ".tmp"
        await writeFile(scratch, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
        await rename(scratch, this.file)
      }
    } catch { throw new Error("Collector persistence failed; sample was not committed") }
    this.state = next
  }

  account(source, cfg, quota) {
    const matches = cfg.accounts.filter(a => {
      if (a.provider !== source.provider) return false
      if (quota) return a.user === (source.user ?? "") && (a.from ?? "") === (source.from ?? "")
      if ((a.computer ?? "") !== (source.computer ?? "")) return false
      return Boolean((source.providerAccount && (a.providerAccount ?? a.user) === source.providerAccount) ||
        (source.providerKeyId && a.providerKeyId === source.providerKeyId))
    })
    const match = matches.length === 1 ? matches[0] : null
    return match ? { id: match.id, mapping: "explicit", planId: match.planId ?? null, poolId: match.poolId ?? null } : {
      id: "unknown-" + this.hash([cfg.baseUrl, quota ? "quota-account" : "request-account", source.provider, source.user ?? source.providerAccount ?? null, source.providerKeyId ?? null, source.from ?? source.computer ?? null]),
      mapping: "unknown", planId: null, poolId: null,
    }
  }

  version(cfg) {
    return { id: "config-" + this.hash(cfg), effectiveAt: cfg.effectiveAt, sourceId: "source-" + this.hash(cfg.baseUrl),
      percentageDirection: cfg.percentageDirection, coverage: cfg.coverage,
      plans: cfg.plans.map(p => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, period: { unit: p.period.unit, count: p.period.count } })),
      accounts: cfg.accounts.map(a => ({ id: a.id, planId: a.planId ?? null, poolId: a.poolId ?? null })) }
  }

  quota(source, cfg, collectedAt, previous) {
    const account = this.account(source, cfg, true)
    const flags = []
    const readAt = timestamp(source.readAt), asOf = timestamp(source.asOf)
    if (!readAt) flags.push("source_time_unknown")
    if (own(source, "error") && source.error) flags.push("source_error")
    if (asOf) flags.push("cached_fallback")
    if (readAt && Date.parse(collectedAt) - Date.parse(readAt) > cfg.staleAfterSeconds * 1000) flags.push("stale_snapshot")
    if (readAt && Date.parse(readAt) > Date.parse(collectedAt) + 60000) flags.push("source_time_in_future")
    if (account.mapping === "unknown") flags.push("account_mapping_unknown")
    if (account.poolId === null) flags.push("pool_unknown")
    const windows = (Array.isArray(source.windows) ? source.windows : []).map(w => {
      const values = rawNumbers(w, WINDOW_NUMBERS)
      const id = "window-" + this.hash([cfg.baseUrl, account.id, typeof w.name === "string" ? w.name : null, typeof w.pool === "string" ? w.pool : null])
      const resetsAt = timestamp(w.resetsAt)
      const windowFlags = []
      if (values.unknown.length) windowFlags.push("fields_unknown")
      if (values.invalid.length) windowFlags.push("invalid_numbers")
      if (!resetsAt) windowFlags.push("reset_unknown")
      const before = previous?.windows.find(x => x.id === id)
      if (before?.resetsAt && resetsAt && before.resetsAt !== resetsAt) windowFlags.push("reset_changed")
      if (before && numeric(w.used) && numeric(before.raw.used) && w.used < before.raw.used) windowFlags.push("percentage_decreased")
      if (before && numeric(w.used) && numeric(before.raw.used) && Math.abs(w.used - before.raw.used) >= 30) windowFlags.push("percentage_jump")
      if (before && numeric(w.remaining) && numeric(before.raw.remaining) && w.remaining > before.raw.remaining) windowFlags.push("remaining_increased")
      if (numeric(w.used) && w.used === 0) windowFlags.push("zero_may_be_unreported")
      if (!w.name) windowFlags.push("window_identity_weak")
      return { id, raw: values.raw, unknown: values.unknown, invalid: values.invalid, resetsAt,
        unit: ["credits", "tokens", "requests", "quota", "New API quota", "USD", "CNY"].includes(w.unit) ? w.unit : null,
        unitId: typeof w.unit === "string" ? "unit-" + this.hash(w.unit) : null,
        unlimited: typeof w.unlimited === "boolean" ? w.unlimited : null, flags: windowFlags }
    })
    return { account, providerId: "provider-" + this.hash(source.provider), kind: ["subscription", "plan", "balance"].includes(source.kind) ? source.kind : "unknown",
      sourceReadAt: readAt, sourceAsOf: asOf, windows, flags }
  }

  request(row, cfg, collectedAt, previousAt) {
    const account = this.account(row, cfg, false)
    const values = rawNumbers(row, NUMBERS)
    const time = timestamp(row.t)
    const handedOn = typeof row.handed_on === "boolean" ? row.handed_on : null
    const rejected = typeof row.rejected === "boolean" ? row.rejected : null
    const identity = [cfg.baseUrl, row.t, row.route_id, row.provider, row.providerAccount, row.providerKeyId, row.computer, row.rid, row.response_id, row.model, row.ep, handedOn, rejected]
    const flags = ["upstream_usage_reporting_unknown", "completion_time_unknown"]
    if (!time) flags.push("request_time_unknown")
    if (values.unknown.length) flags.push("fields_unknown")
    if (values.invalid.length) flags.push("invalid_numbers")
    if (numeric(row.in) && row.in === 0 || numeric(row.out) && row.out === 0) flags.push("zero_may_be_unreported")
    if (time && previousAt && Date.parse(time) < Date.parse(previousAt)) flags.push("delayed_or_backfilled_record")
    if (account.mapping === "unknown") flags.push("account_mapping_unknown")
    if (numeric(row.cache_write_1h) && numeric(row.cache_write) && row.cache_write_1h > row.cache_write) flags.push("cache_write_subset_inconsistent")
    if (numeric(row.reasoning) && numeric(row.out) && row.reasoning > row.out) flags.push("reasoning_subset_inconsistent")
    const reportedError = typeof row.err === "string" ? row.err.length > 0 : null
    if (numeric(row.status) && row.status >= 400 || reportedError) flags.push("failed_request_or_attempt")
    if (row.source === "log") flags.push("session_log_unverified_route")
    if (!row.rid && !row.route_id) flags.push("attempt_identity_weak")
    const model = Object.hasOwn(cfg.models, row.model) ? cfg.models[row.model] : "model-" + this.hash(row.model ?? null)
    const result = { id: "event-" + this.hash(identity), account: { id: account.id, mapping: account.mapping }, providerId: "provider-" + this.hash(row.provider),
      routeId: row.route_id ? "route-" + this.hash([cfg.baseUrl, row.computer, row.route_id]) : null,
      model, modelMapping: Object.hasOwn(cfg.models, row.model) ? "explicit" : "anonymous",
      effort: EFFORTS.has(row.effort) ? row.effort : null, requestTime: time,
      handedOn, rejected, reportedError, source: row.source === "log" ? "session-log" : !row.source ? "gateway-ledger" : "unknown",
      raw: values.raw, unknown: values.unknown, invalid: values.invalid,
      tokenSemantics: "magpie-normalized-uncached-input-output-includes-reasoning-cache-write-includes-1h", flags }
    // Observation timing flags are not a new revision of unchanged source data.
    result.revision = this.hash({ ...result, flags: undefined })
    result.firstObservedAt = collectedAt
    return result
  }

  async json(cfg, path, signal) {
    const headers = process.env.MAGPIE_COLLECTOR_TOKEN ? { authorization: "Bearer " + process.env.MAGPIE_COLLECTOR_TOKEN } : {}
    const response = await this.fetcher(cfg.baseUrl + path, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]), redirect: "error" })
    if (!response.ok) throw new Error("HTTP " + response.status)
    return response.json()
  }

  sample() {
    if (!this.state) return Promise.reject(new Error("Open collector state before sampling"))
    if (this.paused || this.stopped) return Promise.resolve(null)
    if (this.inflight) return this.inflight
    this.inflight = this.collect().finally(() => { this.inflight = null })
    return this.inflight
  }

  async collect() {
    const cfg = validateConfig(await this.configReader())
    const collectedAt = this.clock().toISOString(), version = this.version(cfg)
    if (Date.parse(cfg.effectiveAt) > Date.parse(collectedAt)) throw new Error("Configuration is not effective yet")
    this.controller = new AbortController()
    const signal = this.controller.signal
    const sample = { collectedAt, finishedAt: null, configVersion: version.id, sourceId: version.sourceId,
      quotas: [], requestRevisions: [], flags: [], sources: { quotas: "unknown", requests: "unknown" } }
    const previous = this.state.samples.at(-1)
    const rawRows = []
    try {
      const quotas = await this.json(cfg, "/v1/magpie/quotas", signal)
      if (!Array.isArray(quotas.data)) throw new Error("Bad quota schema")
      sample.quotas = quotas.data.map(q => {
        const id = this.account(q, cfg, true).id
        return this.quota(q, cfg, collectedAt, previous?.quotas.find(x => x.account.id === id))
      })
      sample.sources.quotas = "ok"
    } catch { sample.sources.quotas = "unavailable"; sample.flags.push("quota_read_failed") }
    try {
      for (let page = 0; page < cfg.maxPages; page++) {
        const body = await this.json(cfg, `/v1/magpie/usage/requests?period=30d&limit=500&offset=${page * 500}`, signal)
        if (!Array.isArray(body.rows) || !Number.isInteger(body.total) || body.total < 0) throw new Error("Bad ledger schema")
        rawRows.push(...body.rows)
        if (page > 0) sample.flags.push("ledger_pagination_not_atomic")
        if (rawRows.length >= body.total || !body.rows.length) break
        if (page === cfg.maxPages - 1) sample.flags.push("ledger_truncated")
      }
      sample.sources.requests = "ok"
    } catch { sample.sources.requests = rawRows.length ? "partial" : "unavailable"; sample.flags.push("ledger_read_failed") }
    if (signal.aborted) sample.flags.push(this.stopped ? "collector_stopped" : "collector_paused")
    const next = structuredClone(this.state)
    if (!next.versions.some(v => v.id === version.id)) next.versions.push(version)
    const seen = new Set(next.requests.map(r => r.id + ":" + r.revision))
    for (const raw of rawRows) {
      const request = this.request(raw, cfg, collectedAt, previous?.collectedAt)
      const key = request.id + ":" + request.revision
      if (!seen.has(key)) { seen.add(key); next.requests.push(request); sample.requestRevisions.push({ id: request.id, revision: request.revision }) }
    }
    sample.flags = [...new Set(sample.flags)]
    sample.finishedAt = this.clock().toISOString(); next.samples.push(sample)
    await this.commit(next)
    return sample
  }

  pause() { this.paused = true; this.controller?.abort(); this.wake?.() }
  resume() { this.paused = false; this.wake?.() }
  stop() { this.stopped = true; this.controller?.abort(); this.wake?.() }

  async run({ intervalMs } = {}) {
    while (!this.stopped) {
      if (!this.paused) await this.sample()
      if (this.stopped) break
      const cfg = validateConfig(await this.configReader())
      await new Promise(resolve => {
        const timer = setTimeout(finish, this.paused ? 60000 : intervalMs ?? cfg.intervalMinutes * 60000)
        const self = this
        function finish() { clearTimeout(timer); self.wake = null; resolve() }
        this.wake = finish
      })
    }
  }

  export() {
    const { schema, versions, samples, requests } = this.state
    return { schema, format: "magpie-quota-evidence", exportedAt: this.clock().toISOString(), versions, samples, requests,
      limitations: ["Magpie fields are already normalized; missing vendor usage may appear as zero", "In-flight requests are absent until logged; start time is not completion time", "Account and pool mapping requires explicit configuration", "External consumption coverage is a user declaration", "Import adapter for real-api-pricing is not yet aligned"] }
  }

  async close() {
    this.stop()
    if (this.inflight) await this.inflight.catch(() => {})
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.file + ".lock").catch(() => {}) }
  }
}
