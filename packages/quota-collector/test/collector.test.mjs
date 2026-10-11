import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Collector, validateConfig } from "../collector.mjs"

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const PRIVATE = "DO_NOT_EXPORT_FAKE_SECRET"
const config = () => ({ baseUrl: "http://127.0.0.1:3425", effectiveAt: "2026-01-01T00:00:00Z", intervalMinutes: 5,
  coverage: "unknown", plans: [{ id: "plus", name: "Codex Plus", price: 20, currency: "USD", period: { unit: "month", count: 1 } }],
  accounts: [{ id: "account-a", provider: "codex", user: "fake-user@example.invalid", planId: "plus", poolId: "pool-a" }],
  models: { "gpt-demo": "gpt-demo" } })
const row = (extra = {}) => ({ t: "2026-10-11T00:00:00Z", provider: "codex", providerAccount: "fake-user@example.invalid", model: "gpt-demo", route_id: 1,
  in: 10, out: 20, cache_read: 5, cache_write: 4, cache_write_1h: 2, reasoning: 3, effort: "high", status: 200, handed_on: false, rejected: false,
  host: PRIVATE, session: PRIVATE, requestBody: PRIVATE, rid: PRIVATE, computerName: PRIVATE, ...extra })
const quota = (extra = {}) => ({ provider: "codex", user: "fake-user@example.invalid", kind: "subscription", readAt: "2026-10-11T00:00:00Z",
  balance: PRIVATE, name: PRIVATE, windows: [{ name: PRIVATE, used: 20, remaining: 80, amount: 2, limit: 10, unit: "credits", resetsAt: "2026-10-11T05:00:00Z" }], ...extra })

async function rig(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "quota-collector-test-"))
  const data = { quotas: [quota()], rows: [row()], now: new Date("2026-10-11T00:01:00Z"), fail: false, active: 0, maxActive: 0, delay: 0 }
  let cfg = config()
  const fetcher = async (url, options) => {
    data.active++; data.maxActive = Math.max(data.maxActive, data.active)
    try {
      if (data.delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(finish, data.delay)
        function abort() { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")) }
        function finish() { options.signal.removeEventListener("abort", abort); resolve() }
        if (options.signal.aborted) abort()
        else options.signal.addEventListener("abort", abort, { once: true })
      })
      if (data.fail) throw new Error(PRIVATE)
      return new Response(JSON.stringify(url.includes("/quotas") ? { data: data.quotas } : { rows: data.rows, total: data.rows.length }), { headers: { "content-type": "application/json" } })
    } finally { data.active-- }
  }
  const options = { dataFile: join(root, "state.json"), config: () => cfg, fetcher, clock: () => data.now, ...extra }
  const collector = await new Collector(options).open(); t.after(() => collector.close())
  return { root, options, data, collector, setConfig(value) { cfg = value } }
}

test("privacy whitelist retains numeric evidence, explicit anonymous maps and token subset semantics", async t => {
  const r = await rig(t); await r.collector.sample()
  const exported = r.collector.export(), request = exported.requests[0], window = exported.samples[0].quotas[0].windows[0]
  assert.equal(request.account.id, "account-a"); assert.equal(request.model, "gpt-demo"); assert.equal(request.effort, "high")
  assert.deepEqual(request.raw, { in: 10, out: 20, cache_read: 5, cache_write: 4, cache_write_1h: 2, reasoning: 3, status: 200 })
  assert.match(request.tokenSemantics, /output-includes-reasoning.*includes-1h/)
  assert.equal(window.raw.used, 20); assert.equal(window.unit, "credits")
  const text = JSON.stringify(exported)
  for (const privateValue of [PRIVATE, "fake-user@example.invalid", "127.0.0.1", r.root, "salt", "requestBody", '"host"', '"session"']) assert.ok(!text.includes(privateValue), privateValue)
  const disk = await readFile(r.options.dataFile, "utf8")
  assert.ok(!disk.includes(PRIVATE) && !disk.includes("fake-user@example.invalid"))
})

test("unknown remains distinct from observed zero, invalid values and ambiguous upstream reporting", async t => {
  const r = await rig(t)
  r.data.rows = [row({ in: 0, out: null, cache_read: undefined, reasoning: "3", cache_write_1h: 99 })]
  r.data.quotas = [quota({ readAt: undefined, windows: [{ name: "fake-window", used: 0 }] })]
  await r.collector.sample()
  const request = r.collector.state.requests[0], q = r.collector.state.samples[0].quotas[0]
  assert.equal(request.raw.in, 0); assert.equal(request.raw.out, null); assert.equal(request.raw.reasoning, "3")
  assert.ok(request.unknown.includes("cache_read")); assert.ok(request.invalid.includes("out")); assert.ok(request.invalid.includes("reasoning"))
  assert.ok(request.flags.includes("zero_may_be_unreported") && request.flags.includes("cache_write_subset_inconsistent"))
  assert.ok(q.flags.includes("source_time_unknown")); assert.ok(q.windows[0].unknown.includes("remaining"))
})

test("directions are declared and preserved; resets, stale cache and quota jumps are flags only", async t => {
  const r = await rig(t)
  await r.collector.sample()
  r.data.now = new Date("2026-10-11T01:00:00Z")
  r.data.quotas = [quota({ asOf: "2026-10-10T23:00:00Z", windows: [{ name: PRIVATE, used: 0, remaining: 100, resetsAt: "2026-10-11T10:00:00Z" }] })]
  let next = config(); next.percentageDirection = "remaining"; next.effectiveAt = "2026-10-11T00:30:00Z"; r.setConfig(next)
  const sample = await r.collector.sample(), w = sample.quotas[0].windows[0]
  assert.ok(sample.quotas[0].flags.includes("stale_snapshot") && sample.quotas[0].flags.includes("cached_fallback"))
  assert.ok(w.flags.includes("reset_changed") && w.flags.includes("percentage_decreased") && w.flags.includes("remaining_increased"))
  assert.equal(w.raw.remaining, 100); assert.equal(r.collector.state.versions.at(-1).percentageDirection, "remaining")
  next = config(); next.percentageDirection = "unknown"; r.setConfig(next)
  r.data.quotas[0].windows[0].used = 80
  assert.ok((await r.collector.sample()).quotas[0].windows[0].flags.includes("percentage_jump"))
})

test("restart deduplicates attempts; delayed settlement and changed token counts preserve revisions", async t => {
  const r = await rig(t)
  r.data.rows = [row({ handed_on: true, status: 429 }), row({ t: "2026-10-11T00:00:01Z", providerAccount: "unmapped-fake", handed_on: false })]
  await r.collector.sample(); assert.equal(r.collector.state.requests.length, 2)
  await r.collector.close()
  const next = await new Collector(r.options).open(); t.after(() => next.close())
  r.data.now = new Date("2026-10-11T00:02:00Z")
  await next.sample(); assert.equal(next.state.requests.length, 2)
  r.data.rows.push(row({ t: "2026-10-11T00:00:30Z", route_id: 2, in: 30 }))
  await next.sample(); assert.equal(next.state.requests.length, 3)
  assert.ok(next.state.requests.at(-1).flags.includes("delayed_or_backfilled_record"))
  const id = next.state.requests.at(-1).id
  r.data.rows.at(-1).out = 35
  await next.sample(); assert.equal(next.state.requests.length, 4)
  assert.equal(next.state.requests.at(-1).id, id); assert.notEqual(next.state.requests.at(-1).revision, next.state.requests.at(-2).revision)
})

test("config plan price changes preserve versions and effective time without rewriting old evidence", async t => {
  const r = await rig(t); await r.collector.sample()
  const original = structuredClone(r.collector.state.samples[0]); const requestCount = r.collector.state.requests.length
  r.data.now = new Date("2026-10-11T01:00:00Z")
  const cfg = config(); cfg.effectiveAt = "2026-10-11T00:30:00Z"; cfg.plans[0].price = 25; cfg.coverage = "declared-complete"; r.setConfig(cfg)
  await r.collector.sample()
  assert.equal(r.collector.state.versions.length, 2); assert.equal(r.collector.state.versions[0].plans[0].price, 20)
  assert.equal(r.collector.state.versions[1].plans[0].price, 25); assert.equal(r.collector.state.versions[1].coverage, "declared-complete")
  assert.deepEqual(r.collector.state.samples[0], original); assert.equal(r.collector.state.requests.length, requestCount)
})

test("disconnects commit failure markers, recover, and never save remote error text", async t => {
  const r = await rig(t); r.data.fail = true
  const failed = await r.collector.sample(); assert.equal(failed.sources.quotas, "unavailable"); assert.equal(failed.sources.requests, "unavailable")
  r.data.fail = false; const recovered = await r.collector.sample()
  assert.equal(recovered.sources.quotas, "ok"); assert.equal(recovered.sources.requests, "ok")
  assert.ok(!JSON.stringify(r.collector.export()).includes(PRIVATE))
})

test("sample and scheduler never overlap; pause/resume and exit cancel pending reads", async t => {
  const r = await rig(t); r.data.delay = 25
  const a = r.collector.sample(), b = r.collector.sample(); assert.equal(a, b)
  await a; assert.equal(r.data.maxActive, 1)
  const run = r.collector.run({ intervalMs: 10 })
  await wait(15); r.collector.pause(); await wait(70)
  const pausedCount = r.collector.state.samples.length; await wait(50); assert.equal(r.collector.state.samples.length, pausedCount)
  r.collector.resume(); await wait(75); assert.ok(r.collector.state.samples.length > pausedCount)
  r.collector.stop(); await run
  const count = r.collector.state.samples.length; await wait(40); assert.equal(r.collector.state.samples.length, count)
  assert.equal(r.data.maxActive, 1)
})

test("persistence failure does not advance dedup or samples; unreadable state is not overwritten", async t => {
  let fail = false
  const r = await rig(t, { persist: async () => { if (fail) throw new Error(PRIVATE) } })
  fail = true; await assert.rejects(r.collector.sample(), /persistence failed/)
  assert.equal(r.collector.state.samples.length, 0); assert.equal(r.collector.state.requests.length, 0)
  fail = false; await r.collector.sample(); assert.equal(r.collector.state.requests.length, 1)
  await assert.rejects(new Collector(r.options).open(), /locked/)
})

test("unmapped account/pool/model remain anonymous unknown; completion and failure state are not guessed", async t => {
  const r = await rig(t); r.setConfig({ ...config(), accounts: [], models: {} })
  r.data.rows = [row({ in: 0, out: 0, status: 500, route_id: undefined, rid: undefined, effort: PRIVATE, model: PRIVATE })]
  await r.collector.sample()
  const x = r.collector.state.requests[0], q = r.collector.state.samples[0].quotas[0]
  assert.equal(x.account.mapping, "unknown"); assert.equal(x.modelMapping, "anonymous"); assert.equal(x.effort, null)
  assert.ok(x.flags.includes("failed_request_or_attempt") && x.flags.includes("attempt_identity_weak"))
  assert.ok(q.flags.includes("pool_unknown")); assert.equal(q.account.planId, null)
  assert.ok(!JSON.stringify(r.collector.export()).includes(PRIVATE))
})

test("configuration rejects nonlocal targets, embedded secrets, ambiguous mappings and unsupported directions", () => {
  for (const change of [{ baseUrl: "http://example.invalid" }, { baseUrl: "http://fake:fake@127.0.0.1" }, { intervalMinutes: 0 }, { effectiveAt: "unknown" }, { percentageDirection: "invented" },
    { accounts: [...config().accounts, { ...config().accounts[0], id: "account-b" }] }, { models: { fake: "fake-user@example.invalid" } }])
    assert.throws(() => validateConfig({ ...config(), ...change }))
})

test("unreadable state is preserved and partial pagination is marked without dropping received evidence", async t => {
  const r = await rig(t)
  await r.collector.close(); await writeFile(r.options.dataFile, "not-json-fake")
  await assert.rejects(new Collector(r.options).open(), /unreadable/)
  assert.equal(await readFile(r.options.dataFile, "utf8"), "not-json-fake")
  let pages = 0
  const root = await mkdtemp(join(tmpdir(), "quota-pages-test-"))
  const collector = await new Collector({ dataFile: join(root, "state.json"), config: config(), fetcher: async url => {
    if (url.includes("/quotas")) return new Response(JSON.stringify({ data: [] }))
    if (pages++ === 0) return new Response(JSON.stringify({ rows: [row()], total: 1000 }))
    throw new Error(PRIVATE)
  } }).open(); t.after(() => collector.close())
  const sample = await collector.sample()
  assert.equal(sample.sources.requests, "partial"); assert.ok(sample.flags.includes("ledger_read_failed")); assert.equal(collector.state.requests.length, 1)
})

test("ledger truncation, session-only provenance and reported stream errors remain explicit", async t => {
  const root = await mkdtemp(join(tmpdir(), "quota-truncated-test-"))
  const collector = await new Collector({ dataFile: join(root, "state.json"), config: { ...config(), maxPages: 1 }, fetcher: async url =>
    new Response(JSON.stringify(url.includes("/quotas") ? { data: [] } : { rows: [row({ source: "log", err: PRIVATE, status: 200 })], total: 1000 })) }).open()
  t.after(() => collector.close())
  const sample = await collector.sample(), x = collector.state.requests[0]
  assert.ok(sample.flags.includes("ledger_truncated")); assert.equal(x.source, "session-log"); assert.equal(x.reportedError, true)
  assert.ok(x.flags.includes("failed_request_or_attempt") && x.flags.includes("session_log_unverified_route"))
  assert.ok(!JSON.stringify(collector.export()).includes(PRIVATE))
})
