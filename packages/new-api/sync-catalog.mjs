import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
const [provider, mode] = process.argv.slice(2)
if (!/^new-api-[a-f0-9]{16}$/.test(provider ?? "") || (mode && mode !== "--apply"))
  throw new Error("Usage: node sync-catalog.mjs <new-api-provider-id> [--apply]")
const executable = process.env.MAGPIE_EXE || "magpie"
const run = args => exec(executable, args, { windowsHide: true, maxBuffer: 8 << 20, timeout: 60000 })
const list = JSON.parse((await run(["plugin", "list", "--json"])).stdout)
const entry = list.providers?.find(p => p.id === provider)
if (!entry?.models?.length || entry.accounts?.some(a => a.fellBack || !Array.isArray(a.models)))
  throw new Error("All account model lists must be available before exposing the site catalog")
const models = entry.models.filter(m => typeof m.id === "string" && m.id.startsWith("na."))
if (models.length !== entry.models.length) throw new Error("Unexpected model IDs")
if (mode !== "--apply") {
  console.log(JSON.stringify({ provider, models: models.map(m => ({ id: m.id, name: m.name })), action: "--apply replaces this provider's exposed model picks and display names; account lists remain scoped" }, null, 2))
} else {
  await run(["provider", "set", provider, "models=" + models.map(m => m.id).join(",")])
  for (const m of models) await run(["model", "name", provider + "/" + m.id, m.name])
  console.log("Exposed site catalog and display names updated. Re-run explicitly after adding accounts or changing labels.")
}
