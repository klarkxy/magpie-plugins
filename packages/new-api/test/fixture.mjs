import http from "node:http"

export async function fakeSite() {
  const state = { calls: [], listFails: new Set(), codes: new Map(), mode: "json", closed: 0,
    quota: { object: "token_usage", total_granted: 1000, total_used: 100, total_available: 900, unlimited_quota: false, expires_at: 0 } }
  const server = http.createServer(async (req, res) => {
    const key = req.headers.authorization?.replace(/^Bearer /, "")
    if (req.url === "/v1/models") {
      res.writeHead(state.listFails.has(key) ? 503 : 200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "demo-model" }] })); return
    }
    if (req.url === "/api/usage/token/") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ code: true, data: state.quota })); return
    }
    let body = ""
    for await (const chunk of req) body += chunk
    state.calls.push({ key, url: req.url, headers: req.headers, body: JSON.parse(body) })
    const status = state.codes.get(key) ?? 200
    if (status !== 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fake upstream failure" } })); return }
    if (state.mode === "redirect") { res.writeHead(307, { location: "http://127.0.0.1:1/leak" }); res.end(); return }
    if (state.mode === "hang") {
      res.on("close", () => state.closed++); return
    }
    if (state.mode === "stream" || state.mode === "broken" || (body && JSON.parse(body).stream && state.mode === "json")) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"id":"fake","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n')
      const timer = setTimeout(() => {
        if (state.mode === "broken") { res.destroy(); return }
        res.end('data: {"id":"fake","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\ndata: [DONE]\n\n')
      }, 80)
      res.on("close", () => { state.closed++; clearTimeout(timer) }); return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "fake", object: "chat.completion", model: "demo-model", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { state, site: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export function authFor(site, group = "cheap", key = "fake-test-key-a", profile = "standard") {
  return { type: "api", key, accountId: key, metadata: { site, group, profile } }
}
