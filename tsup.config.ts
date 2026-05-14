import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { "mcp/server": "src/mcp/server.ts" },
    format: ["esm"],
    target: "node20",
    splitting: true,
  },
]);
