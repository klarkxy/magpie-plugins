import test from "node:test"
import assert from "node:assert/strict"
import { createPlugin, quotaOf, normalizeSite } from "../plugin.mjs"
import { fakeSite, authFor } from "./fixture.mjs"

async function rig(t, options = {}) {
  const f = await fakeSite(); t.after(() => f.close())
  const plugin = await createPlugin({}, { site: f.site, profiles: { standard: { multiplier: 0.5 }, vip: { multiplier: 2 } }, ...options })
  return { ...f, plugin }
}

test("stable aliases scope group/profile/site; multiplier changes only display", async t => {
  const r = await rig(t); const a = authFor(r.site)
  const first = await r.plugin.provider.models({}, { auth: a })
  const other = await createPlugin({}, { site: r.site, profiles: { standard: { multiplier: 3 } } })
  const second = await other.provider.models({}, { auth: a })
  assert.deepEqual(Object.keys(first), Object.keys(second)); assert.match(Object.values(first)[0].name, /×0.5.*手动未验证/)
  assert.equal(Object.values(first)[0].api.id, Object.keys(first)[0])
  for (const different of [authFor(r.site, "premium"), authFor(r.site, "cheap", "fake-test-key-b", "vip")]) {
    assert.notDeepEqual(Object.keys(first), Object.keys(await r.plugin.provider.models({}, { auth: different })))
  }
})

test("send checks group even when lists fail, then restores alias and strips caller secrets", async t => {
  const r = await rig(t); let auth = authFor(r.site)
  const alias = Object.keys(await r.plugin.provider.models({}, { auth }))[0]
  const loader = await r.plugin.auth.loader(async () => auth)
  r.state.listFails.add(auth.key)
  await assert.rejects(r.plugin.provider.models({}, { auth }), /503/)
  const opts = { method: "POST", headers: { authorization: "Bearer fake-caller", cookie: "fake-cookie", "x-new-api-group": "premium" }, body: JSON.stringify({ model: alias, messages: [] }) }
  let res = await loader.fetch(r.site + "/v1/chat/completions", opts)
  assert.equal(res.status, 200); await res.text()
  assert.equal(r.state.calls[0].body.model, "demo-model"); assert.equal(r.state.calls[0].key, auth.key)
  assert.equal(r.state.calls[0].headers.cookie, undefined); assert.equal(r.state.calls[0].headers["x-new-api-group"], undefined)
  auth = authFor(r.site, "premium")
  res = await loader.fetch(r.site + "/v1/chat/completions", opts)
  assert.equal(res.status, 403); assert.equal(r.state.calls.length, 1)
  auth = authFor("https://example.invalid")
  assert.equal((await loader.fetch(r.site + "/v1/chat/completions", opts)).status, 403)
})

test("reject raw/tampered aliases, other site/path/protocol, auto and missing metadata", async t => {
  const r = await rig(t); const auth = authFor(r.site)
  const id = Object.keys(await r.plugin.provider.models({}, { auth }))[0]
  const { fetch } = await r.plugin.auth.loader(async () => auth)
  for (const model of ["demo-model", id + ".extra", id.replace(".chat.", ".responses."), id.replace(/^na\./, "bad.")])
    assert.equal((await fetch(r.site + "/v1/chat/completions", { body: JSON.stringify({ model }) })).status, 403)
  for (const url of ["http://127.0.0.1:1/v1/chat/completions", r.site + "/v1/responses", r.site + "/v1/chat/completions?group=premium"])
    assert.ok((await fetch(url, { body: JSON.stringify({ model: id }) })).status >= 400)
  for (const a of [authFor(r.site, "auto"), authFor(r.site, "auto "), { type: "api", key: auth.key }]) await assert.rejects(r.plugin.auth.loader(async () => a))
  assert.equal(r.state.calls.length, 0)
})

test("manual model protocols and capabilities are explicit; no list fetch needed", async t => {
  for (const [protocol, npm, path] of [["responses", "@ai-sdk/openai", "/responses"], ["messages", "@ai-sdk/anthropic", "/messages"]]) {
  const r = await rig(t, { models: [{ id: "demo-model", protocol, context: 4000, output: 1000, tools: true }] })
  const auth = authFor(r.site); r.state.listFails.add(auth.key)
  const models = await r.plugin.provider.models({}, { auth }); const m = Object.values(models)[0]
  assert.equal(m.api.npm, npm); assert.equal(m.capabilities.input.image, false)
  const loader = await r.plugin.auth.loader(async () => auth)
  const res = await loader.fetch(r.site + "/v1" + path, { body: JSON.stringify({ model: m.id, input: "hello" }) })
  assert.equal(res.status, 200); await res.text(); assert.equal(r.state.calls[0].body.model, "demo-model")
  }
})

test("HTTP errors, SSE bytes, cancellation and redirect refusal", async t => {
  const r = await rig(t); const auth = authFor(r.site)
  const model = Object.keys(await r.plugin.provider.models({}, { auth }))[0]
  const loader = await r.plugin.auth.loader(async () => auth)
  const send = signal => loader.fetch(r.site + "/v1/chat/completions", { body: JSON.stringify({ model, stream: true }), signal })
  for (const status of [400, 401, 403, 429, 500, 503]) {
    r.state.codes.set(auth.key, status); const res = await send(); assert.equal(res.status, status); await res.text()
  }
  r.state.codes.clear(); r.state.mode = "stream"
  assert.match(await (await send()).text(), /\[DONE\]/)
  r.state.mode = "redirect"; await assert.rejects(send())
  r.state.mode = "hang"
  const ctl = new AbortController(); const p = send(ctl.signal)
  setTimeout(() => ctl.abort(), 40); await assert.rejects(p, { name: "AbortError" })
  const count = r.state.calls.length
  await assert.rejects(send(AbortSignal.abort()), { name: "AbortError" }); assert.equal(r.state.calls.length, count)
})

test("quota is token scope, never wallet or expiry as reset; anomalies stay unknown", async t => {
  const r = await rig(t); const auth = authFor(r.site)
  const u = await r.plugin.auth.usage(async () => auth)
  assert.equal(u.windows[0].used, 10); assert.equal(u.balance, undefined); assert.equal(u.windows[0].resetsAt, undefined)
  for (const patch of [{ total_used: -1 }, { total_available: 50 }, { unlimited_quota: null }, { total_used: "100" }]) {
    assert.throws(() => quotaOf({ data: { ...r.state.quota, ...patch } }))
  }
  r.state.quota = { ...r.state.quota, total_used: -1 }
  const bad = await r.plugin.auth.usage(async () => auth)
  assert.deepEqual(bad.windows, []); assert.ok(bad.error)
  assert.deepEqual(quotaOf({ data: { object: "token_usage", unlimited_quota: true } }).windows, [])
})

test("configuration refuses unsafe site URLs", () => {
  for (const url of ["http://example.com", "https://fake:fake@example.com", "https://example.com?key=fake", "https://example.com#fragment"])
    assert.throws(() => normalizeSite(url))
  assert.equal(normalizeSite("https://example.com/sub/"), "https://example.com/sub")
})
