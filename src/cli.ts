import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { startServer } from "./mcp/server.js";

const CONFIG_PATH = join(homedir(), ".claude.json");
const SERVER_KEY = "claude-context-sync";

async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function init() {
  const config = await readConfig();
  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (mcpServers[SERVER_KEY]) {
    console.log("✅ claude-context-sync is already registered.");
    return;
  }

  mcpServers[SERVER_KEY] = {
    type: "stdio",
    command: "context-sync",
    args: ["serve"],
  };
  config.mcpServers = mcpServers;

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  console.log("✅ Registered claude-context-sync MCP server.");
  console.log(`   Config: ${CONFIG_PATH}`);
  console.log("   It will activate on your next Claude Code session.");
}

const command = process.argv[2];

switch (command) {
  case "init":
    init().catch((err: Error) => {
      console.error("❌ Init failed:", err.message);
      process.exit(1);
    });
    break;
  case "serve":
    startServer().catch((err: Error) => {
      console.error("❌ Server failed:", err.message);
      process.exit(1);
    });
    break;
  default:
    console.log("Usage:");
    console.log("  context-sync init    Register MCP server in Claude Code");
    console.log("  context-sync serve   Start MCP server (called automatically)");
    process.exit(command ? 1 : 0);
}
