import test from "node:test"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import net from "node:net"
import { createPlugin } from "../plugin.mjs"
import { fakeSite, authFor } from "./fixture.mjs"
import { Collector } from "../../quota-collector/collector.mjs"

const exec = promisify(execFile)
const available = process.env.MAGPIE_EXE && process.env.MAGPIE_BUN && process.env.MAGPIE_HOST
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function isolation() {
  const root = await mkdtemp(join(tmpdir(), "magpie-new-api-test-"))
  const env = { ...process.env }
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_DIR"])
    env[key] = join(root, key.toLowerCase())
  delete env.MAGPIE_NO_ACCOUNTS
  for (const dir of Object.values(env).filter(value => typeof value === "string" && value.startsWith(root))) await mkdir(dir, { recursive: true })
  const dir = join(env.XDG_CONFIG_HOME, "magpie")
  await mkdir(dir, { recursive: true })
  await mkdir(join(env.XDG_CACHE_HOME, "magpie"), { recursive: true })
  await writeFile(join(env.XDG_CACHE_HOME, "magpie", "models.json"), "{}")
  await writeFile(join(dir, "settings.json"), JSON.stringify({ noStats: true, noUsageStats: false, updateAuto: false }))
  return { root, env, dir }
}

async function wrapper(root, site, name) {
  const file = join(root, name + ".mjs")
  await writeFile(file, `import { createPlugin } from ${JSON.stringify(new URL("../plugin.mjs", import.meta.url).href)}\nexport default { server: input => createPlugin(input, { site: ${JSON.stringify(site)} }) }\n`)
  return file
}

function hostRPC(env) {
  const child = spawn(env.MAGPIE_BUN, [env.MAGPIE_HOST], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  let id = 0, pendingText = ""
  const pending = new Map()
  child.stdout.on("data", bytes => {
    pendingText += bytes.toString()
    let end
    while ((end = pendingText.indexOf("\n")) >= 0) {
      const line = pendingText.slice(0, end); pendingText = pendingText.slice(end + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const item = pending.get(msg.id)
      if (!item) continue
      if (msg.event === "head") item.status = msg.status
      else if (msg.event === "chunk") item.chunks.push(Buffer.from(msg.data, "base64"))
      else if ("result" in msg || msg.error) {
        pending.delete(msg.id); clearTimeout(item.timer)
        if (msg.error) item.reject(new Error(msg.error.message))
        else item.resolve(item.fetch ? { status: item.status, body: Buffer.concat(item.chunks).toString() } : msg.result)
      }
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id
    const timer = setTimeout(() => { pending.delete(n); reject(new Error("Host RPC timeout: " + method)) }, 20000)
    pending.set(n, { resolve, reject, timer, fetch: method === "fetch", chunks: [] })
    child.stdin.write(JSON.stringify({ id: n, method, params }) + "\n")
  })
  return { child, call }
}

test("real Magpie Bun host: account lists, failed-list guard, alias restore, restart, sites, API sign-in", { skip: !available, timeout: 90000 }, async t => {
  const f = await fakeSite(), second = await fakeSite()
  t.after(() => f.close()); t.after(() => second.close())
  const iso = await isolation(); const target = await wrapper(iso.root, f.site, "one"), target2 = await wrapper(iso.root, second.site, "two")
  const plugin = await createPlugin({}, { site: f.site }); const id = plugin.auth.provider
  const p2 = await createPlugin({}, { site: second.site }); const id2 = p2.auth.provider
  const accounts = { [id]: authFor(f.site), [id + "#b"]: authFor(f.site, "cheap", "fake-test-key-b"),
    [id + "#premium"]: authFor(f.site, "premium", "fake-test-key-premium"), [id2]: authFor(second.site) }
  const authPath = join(iso.dir, "plugin-auth.json"); await writeFile(authPath, JSON.stringify(accounts))
  const init = { authPath, directory: iso.root, plugins: [{ spec: target, target }, { spec: target2, target: target2 }] }
  let rpc = hostRPC(iso.env); t.after(() => rpc.child.kill())
  assert.ok((await rpc.call("init", init)).plugins.every(p => !p.error))
  let list = await rpc.call("providers", {})
  const provider = list.find(p => p.id === id); assert.equal(provider.accounts.length, 3)
  const cheap = provider.accounts.find(a => a.key === id).models[0]
  const premium = provider.accounts.find(a => a.key === id + "#premium").models[0]
  assert.equal(cheap, provider.accounts.find(a => a.key === id + "#b").models[0]); assert.notEqual(cheap, premium)
  assert.ok(provider.models.every(m => m.apiId === m.id))
  f.state.listFails.add("fake-test-key-premium")
  list = await rpc.call("providers", {})
  assert.equal(list.find(p => p.id === id).accounts.find(a => a.key.endsWith("#premium")).models, undefined)
  const request = { provider: id, account: id, model: cheap, npm: "@ai-sdk/openai-compatible", url: f.site + "/v1/chat/completions", body: Buffer.from(JSON.stringify({ model: cheap, messages: [] })).toString("base64") }
  const ok = await rpc.call("fetch", request); assert.equal(ok.status, 200); assert.equal(f.state.calls.at(-1).body.model, "demo-model")
  const count = f.state.calls.length
  assert.equal((await rpc.call("fetch", { ...request, account: id + "#premium" })).status, 403)
  assert.equal((await rpc.call("fetch", { ...request, provider: id2, account: id2, url: second.site + "/v1/chat/completions" })).status, 403)
  assert.equal(f.state.calls.length, count); assert.equal(second.state.calls.length, 0)
  const signed = await rpc.call("apiKey", { provider: id, method: 0, inputs: { group: "cheap", profile: "standard" }, key: "fake-test-key-c", account: "new" })
  assert.equal(signed.ok, true)
  rpc.child.kill(); rpc = hostRPC(iso.env)
  await rpc.call("init", init)
  assert.equal((await rpc.call("providers", {})).find(p => p.id === id).accounts.length, 4)
  assert.equal((await rpc.call("fetch", request)).status, 200)
  console.log("PASS real host: metadata scope survives native sign-in and restart; failed discovery still blocks wrong group/site")
})

test("real Magpie gateway: native same-group failover, no implicit cross-group, pinning, explicit route, SSE cancellation", { skip: !available, timeout: 180000 }, async t => {
  const f = await fakeSite(); t.after(() => f.close())
  const iso = await isolation(); const spec = await wrapper(iso.root, f.site, "native")
  const plugin = await createPlugin({}, { site: f.site }); const id = plugin.auth.provider
  await writeFile(join(iso.dir, "plugins.json"), JSON.stringify({ plugins: [{ spec }] }))
  await writeFile(join(iso.dir, "plugin-auth.json"), JSON.stringify({ [id]: authFor(f.site),
    [id + "#b"]: authFor(f.site, "cheap", "fake-test-key-b"), [id + "#premium"]: authFor(f.site, "premium", "fake-test-key-premium") }))
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  iso.env.MAGPIE_ADDR = "127.0.0.1:" + port
  const cli = async args => exec(iso.env.MAGPIE_EXE, args, { env: iso.env, windowsHide: true, timeout: 45000, maxBuffer: 4 << 20 })
  const { stdout } = await cli(["plugin", "list", "--json"])
  const provider = JSON.parse(stdout).providers.find(p => p.id === id)
  assert.ok(provider && provider.models.length === 2, "native CLI must discover plugin and scoped models")
  const cheap = provider.accounts.find(a => a.key === id).models[0]
  const premium = provider.accounts.find(a => a.key.endsWith("#premium")).models[0]
  let server
  const start = async () => {
    server = spawn(iso.env.MAGPIE_EXE, ["serve"], { env: iso.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let logs = ""; server.stderr.on("data", b => { logs += b.toString() }); server.stdout.on("data", b => { logs += b.toString() })
    for (let n = 0; n < 100; n++) {
      try { const res = await fetch(`http://127.0.0.1:${port}/v1/models`); if (res.ok) return } catch {}
      if (server.exitCode !== null) throw new Error("Isolated Magpie exited: " + logs)
      await delay(100)
    }
    throw new Error("Isolated gateway did not start: " + logs)
  }
  const stop = async () => {
    if (server.exitCode !== null) return
    const exited = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exited
  }
  t.after(stop)
  const send = (model, extra = {}, signal) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: f.state.mode === "stream" || f.state.mode === "broken" }), signal })
  await start()
  const scoped = id + "/" + cheap
  f.state.codes.set("fake-test-key-a", 429)
  let res = await send(scoped); let body = await res.text()
  assert.equal(res.status, 200, body)
  assert.ok(f.state.calls.some(c => c.key === "fake-test-key-a")); assert.ok(f.state.calls.some(c => c.key === "fake-test-key-b"))
  assert.ok(f.state.calls.every(c => c.key !== "fake-test-key-premium" && c.body.model === "demo-model"))
  console.log("PASS native same-group key A 429 -> key B success")
  await stop(); f.state.calls.length = 0
  f.state.codes.set("fake-test-key-b", 429); f.state.listFails.add("fake-test-key-premium")
  await start()
  res = await send(scoped); body = await res.text()
  assert.ok(res.status >= 400, body); assert.ok(f.state.calls.every(c => c.key !== "fake-test-key-premium"))
  console.log("PASS native failed model list cannot silently spend premium key")
  await stop(); f.state.calls.length = 0; f.state.codes.clear(); f.state.listFails.clear()
  await start()
  res = await send(scoped, { "X-Magpie-Account": "fake-test-key-premium" })
  // Wrong/nonexistent account pins are closed by Magpie, before any upstream send.
  assert.ok(res.status >= 400); await res.text(); assert.equal(f.state.calls.length, 0)
  f.state.codes.set("fake-test-key-a", 429)
  res = await send(scoped, { "X-Magpie-Account": "fake-test-key-a" })
  body = await res.text(); assert.ok(res.status >= 400, body)
  assert.ok(f.state.calls.length > 0 && f.state.calls.every(c => c.key === "fake-test-key-a"))
  console.log("PASS native account pin never replaces the pinned key")
  await exec(process.execPath, [fileURLToPath(new URL("../sync-catalog.mjs", import.meta.url)), id, "--apply"], { env: iso.env, windowsHide: true, timeout: 90000 })
  const route = await cli(["group", "add", "Explicit", "models=" + scoped + "," + id + "/" + premium, "routing=order"])
  assert.match(route.stdout, /explicit/i)
  f.state.codes.set("fake-test-key-a", 429); f.state.codes.set("fake-test-key-b", 429)
  res = await send("group/explicit"); body = await res.text(); assert.equal(res.status, 200, body)
  assert.ok(f.state.calls.some(c => c.key === "fake-test-key-premium"))
  console.log("PASS explicit cross-group route succeeds only when requested")
  await stop(); f.state.calls.length = 0; f.state.codes.clear(); f.state.mode = "stream"
  await start()
  res = await send(scoped); body = await res.text(); assert.equal(res.status, 200); assert.match(body, /\[DONE\]/)
  const before = f.state.calls.length
  const ctl = new AbortController(); res = await send(scoped, {}, ctl.signal)
  const reader = res.body.getReader(); await reader.read(); ctl.abort(); await reader.cancel().catch(() => {})
  await delay(180); assert.equal(f.state.calls.length, before + 1)
  console.log("PASS native SSE and cancellation cause no replay")
  f.state.mode = "broken"; f.state.calls.length = 0
  res = await send(scoped); await res.text().catch(() => {})
  await delay(100); assert.equal(f.state.calls.length, 1)
  console.log("PASS interrupted stream after first content is not replayed")
  const collector = await new Collector({ dataFile: join(iso.root, "evidence-state.json"), config: {
    baseUrl: `http://127.0.0.1:${port}`, effectiveAt: "2026-01-01T00:00:00Z", accounts: [
      { id: "account-a", provider: id, user: "fake-test-key-a" },
      { id: "account-b", provider: id, user: "fake-test-key-b" },
      { id: "account-premium", provider: id, user: "fake-test-key-premium" },
    ], models: { [cheap]: "demo-model", [premium]: "demo-model" },
  } }).open()
  t.after(() => collector.close())
  const sample = await collector.sample()
  assert.equal(sample.sources.quotas, "ok"); assert.equal(sample.sources.requests, "ok")
  assert.ok(collector.state.requests.length > 0)
  const evidence = JSON.stringify(collector.export())
  assert.ok(!evidence.includes("fake-test-key") && !evidence.includes(iso.root) && !evidence.includes(f.site))
  console.log("PASS collector reads real Magpie quota/ledger APIs with anonymous output")
})
