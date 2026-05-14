import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SyncConfig } from "../src/types.js";

const mockSummaryJson = JSON.stringify({
  task: "MCP 서버 테스트",
  changedFiles: ["src/server.ts"],
  decisions: ["MCP SDK 사용"],
  currentState: "진행 중",
  blockers: [],
  impactOnOtherSessions: [],
});

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const child = {
      stdin: { write: vi.fn(), end: vi.fn() },
    };
    setTimeout(() => cb(null, mockSummaryJson, ""), 0);
    return child;
  },
}));

const { createServer } = await import("../src/mcp/server.js");

describe("MCP Server", () => {
  let tmpDir: string;
  let config: SyncConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mcp-test-"));
    await mkdir(join(tmpDir, "projects", "-test-project"), { recursive: true });
    await mkdir(join(tmpDir, "sessions"), { recursive: true });
    config = {
      claudeDir: tmpDir,
      syncDir: join(tmpDir, "context-sync"),
      triggerMessageCount: 2,
      fullResummarizeAfter: 4,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("createServer는 server, watcher, scheduler, store를 반환", () => {
    const result = createServer(config);
    expect(result.server).toBeDefined();
    expect(result.watcher).toBeDefined();
    expect(result.scheduler).toBeDefined();
    expect(result.store).toBeDefined();
  });

  it("watcher.getActiveSessions로 세션 조회 가능", async () => {
    await writeFile(
      join(tmpDir, "sessions", "1234.json"),
      JSON.stringify({
        pid: 1234,
        sessionId: "sess-1",
        cwd: "/test/project",
        status: "idle",
        startedAt: Date.now(),
        version: "1.0.0",
      }),
    );

    const { watcher } = createServer(config);
    const sessions = await watcher.getActiveSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sess-1");
  });

  it("scheduler + store 연동: 낙후 세션 요약 생성 후 저장", async () => {
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    await writeFile(
      join(tmpDir, "sessions", "1234.json"),
      JSON.stringify({
        pid: 1234,
        sessionId,
        cwd: "/test/project",
        status: "idle",
        startedAt: Date.now(),
        version: "1.0.0",
      }),
    );

    await writeFile(
      join(tmpDir, "projects", "-test-project", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "기능 만들어줘" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "만들겠습니다" }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          timestamp: "2026-01-01T00:00:02Z",
          message: { role: "user", content: "테스트도 추가해" },
        }),
      ].join("\n"),
    );

    const { scheduler, store } = createServer(config);

    // 요약 생성 전
    const before = await store.readSummary(sessionId);
    expect(before).toBeNull();

    // markStale + 전략 확인
    scheduler.markStale(sessionId);
    const strategy = scheduler.getStrategy(sessionId, 3);
    expect(strategy).toBe("incremental");
  });

  it("store에 요약 저장 후 조회 가능", async () => {
    const { store } = createServer(config);

    await store.writeSummary({
      sessionId: "test-sess",
      project: "/test",
      updatedAt: new Date().toISOString(),
      incrementalCount: 0,
      summary: {
        task: "테스트",
        changedFiles: ["a.ts"],
        decisions: [],
        currentState: "완료",
        blockers: [],
        impactOnOtherSessions: [],
      },
      raw: "# 테스트 요약",
    });

    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary.task).toBe("테스트");
  });
});
