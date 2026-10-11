import { createPlugin } from "./plugin.mjs"

// An object export prevents Magpie from treating library helpers as plugins.
export default { server: createPlugin }
