import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createPlugin } from "./plugin.mjs"

// Non-secret site options only. Never place keys in this file.
const [configFile, outputFile] = process.argv.slice(2)
if (!configFile || !outputFile) throw new Error("Usage: node setup.mjs <site-options.json> <site-plugin.mjs>")
const config = JSON.parse(await readFile(configFile, "utf8"))
const allowed = ["site", "name", "profiles", "models"]
if (Object.keys(config).some(k => !allowed.includes(k))) throw new Error("Unexpected configuration field; keys belong in Magpie account storage")
await createPlugin({}, config)
const output = resolve(outputFile)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `import { createPlugin } from ${JSON.stringify(new URL("./plugin.mjs", import.meta.url).href)}\nexport default { server: input => createPlugin(input, ${JSON.stringify(config, null, 2)}) }\n`, { flag: "wx" })
console.log("Created site plugin; keep the package at its current location.")
