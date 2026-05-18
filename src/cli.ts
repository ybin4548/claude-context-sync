import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startServer } from "./mcp/server.js";

const CONFIG_PATH = join(homedir(), ".claude.json");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
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
    await registerHook();
    console.log("   It will activate on your next Claude Code session.");
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

  await registerHook();
  console.log("   It will activate on your next Claude Code session.");
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function registerHook() {
  const scriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "conflict-check.sh",
  );

  type HookCommand = { type: string; command: string };
  type HookMatcher = { matcher?: string; hooks?: HookCommand[] };

  const settings = await readSettings();
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const existing = (hooks.UserPromptSubmit ?? []) as HookMatcher[];

  const alreadyRegistered = existing.some((entry) =>
    entry.hooks?.some((h) => h.command === scriptPath),
  );
  if (alreadyRegistered) {
    console.log("✅ Conflict detection hook is already registered.");
    return;
  }

  existing.push({
    matcher: "",
    hooks: [{ type: "command", command: scriptPath }],
  });

  hooks.UserPromptSubmit = existing;
  settings.hooks = hooks;
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  console.log("✅ Registered conflict detection hook.");
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
