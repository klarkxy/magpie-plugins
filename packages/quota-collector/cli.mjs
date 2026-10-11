#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { Collector } from "./collector.mjs"

const [command, configFile, dataFile, outputFile] = process.argv.slice(2)
if (!["once", "run", "export"].includes(command) || !configFile || !dataFile || (command === "export" && !outputFile)) {
  console.error("Usage: node cli.mjs once|run <local-config.json> <state.json>\n       node cli.mjs export <local-config.json> <state.json> <export.json>")
  process.exitCode = 1
} else {
  const collector = new Collector({ dataFile, config: async () => JSON.parse(await readFile(configFile, "utf8")) })
  const stop = () => collector.stop()
  process.on("SIGINT", stop); process.on("SIGTERM", stop)
  try {
    await collector.open()
    if (command === "once") { const sample = await collector.sample(); console.log(sample?.sources.requests === "ok" && sample?.sources.quotas === "ok" ? "Sample committed." : "Sample committed with source warnings.") }
    if (command === "export") {
      await writeFile(outputFile, JSON.stringify(collector.export(), null, 2) + "\n", { flag: "wx", mode: 0o600 })
      console.log("Anonymized evidence exported locally.")
    }
    if (command === "run") {
      console.log("Collector running. Type p + Enter to pause, r to resume, q to exit. No upload.")
      process.stdin.setEncoding("utf8")
      const input = chunk => { for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() === "p") { collector.pause(); console.log("Paused.") }
        if (line.trim() === "r") { collector.resume(); console.log("Resumed.") }
        if (line.trim() === "q") collector.stop()
      } }
      process.stdin.on("data", input)
      try { await collector.run() } finally { process.stdin.off("data", input); process.stdin.pause() }
    }
  } catch {
    console.error("Collector stopped: configuration, source processing or persistence failed. Check local configuration and state; no automatic overwrite or upload.")
    process.exitCode = 1
  } finally { await collector.close(); process.off("SIGINT", stop); process.off("SIGTERM", stop) }
}
