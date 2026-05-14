import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { startServer } from "./mcp/server.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const SERVER_KEY = "claude-context-sync";

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function init() {
  const settings = await readSettings();
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;

  if (mcpServers[SERVER_KEY]) {
    console.log("✅ claude-context-sync MCP 서버가 이미 등록되어 있습니다.");
    return;
  }

  mcpServers[SERVER_KEY] = {
    command: "context-sync",
    args: ["serve"],
    type: "stdio",
  };
  settings.mcpServers = mcpServers;

  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  console.log("✅ claude-context-sync MCP 서버를 등록했습니다.");
  console.log(`   설정 파일: ${SETTINGS_PATH}`);
  console.log("   다음 Claude Code 세션부터 자동으로 활성화됩니다.");
}

const command = process.argv[2];

switch (command) {
  case "init":
    init().catch((err: Error) => {
      console.error("❌ 초기화 실패:", err.message);
      process.exit(1);
    });
    break;
  case "serve":
    startServer().catch((err: Error) => {
      console.error("❌ 서버 시작 실패:", err.message);
      process.exit(1);
    });
    break;
  default:
    console.log("사용법:");
    console.log("  context-sync init    MCP 서버를 Claude Code에 등록");
    console.log("  context-sync serve   MCP 서버 시작 (자동 호출됨)");
    process.exit(command ? 1 : 0);
}
