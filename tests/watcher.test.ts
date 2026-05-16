import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Watcher } from "../src/watcher/watcher.js";
import { Scheduler } from "../src/watcher/scheduler.js";
import type { SyncConfig } from "../src/types.js";

function makeConfig(claudeDir: string): SyncConfig {
  return {
    claudeDir,
    syncDir: join(claudeDir, "context-sync"),
    triggerMessageCount: 10,
    fullResummarizeAfter: 4,
  };
}

describe("Watcher", () => {
  let tmpDir: string;
  let config: SyncConfig;
  let scheduler: Scheduler;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watcher-test-"));
    await mkdir(join(tmpDir, "projects", "test-project"), { recursive: true });
    await mkdir(join(tmpDir, "sessions"), { recursive: true });
    config = makeConfig(tmpDir);
    scheduler = new Scheduler(config);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("getActiveSessions는 sessions/*.json에서 메타 반환", async () => {
    await writeFile(
      join(tmpDir, "sessions", "1234.json"),
      JSON.stringify({
        pid: 1234,
        sessionId: "abc-def",
        cwd: "/test/project",
        status: "idle",
        startedAt: Date.now(),
        version: "1.0.0",
      }),
    );

    const watcher = new Watcher(scheduler, config);
    const sessions = await watcher.getActiveSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("abc-def");
    expect(sessions[0].pid).toBe(1234);
    expect(sessions[0].status).toBe("idle");
  });

  it("getActiveSessions는 파싱 실패한 파일 무시", async () => {
    await writeFile(join(tmpDir, "sessions", "bad.json"), "not json");
    await writeFile(
      join(tmpDir, "sessions", "5678.json"),
      JSON.stringify({
        pid: 5678,
        sessionId: "good-session",
        cwd: "/test",
        status: "busy",
        startedAt: Date.now(),
        version: "1.0.0",
      }),
    );

    const watcher = new Watcher(scheduler, config);
    const sessions = await watcher.getActiveSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("good-session");
  });

  it("getActiveSessions는 sessions 디렉터리 없으면 빈 배열", async () => {
    await rm(join(tmpDir, "sessions"), { recursive: true });

    const watcher = new Watcher(scheduler, config);
    const sessions = await watcher.getActiveSessions();

    expect(sessions).toEqual([]);
  });

  it("getJsonlPath는 프로젝트 경로를 디렉터리명으로 변환", () => {
    const watcher = new Watcher(scheduler, config);
    const sessionId = "b7ce126d-3d1f-4171-9bae-cb1940648902";

    const path = watcher.getJsonlPath(sessionId, "test");
    expect(path).toContain("test");
    expect(path).toContain(`${sessionId}.jsonl`);
  });

  it("startWatching 후 .jsonl 변경 시 콜백 + scheduler.markStale 호출", async () => {
    const watcher = new Watcher(scheduler, config);

    const changed = new Promise<{ sessionId: string; path: string }>(
      (resolve) => {
        watcher.onSessionChange((sessionId, path) => {
          resolve({ sessionId, path });
        });
      },
    );

    await watcher.startWatching();

    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const jsonlPath = join(
      tmpDir,
      "projects",
      "test-project",
      `${sessionId}.jsonl`,
    );
    await writeFile(jsonlPath, '{"type":"user"}\n');

    const result = await changed;
    await watcher.stopWatching();

    expect(result.sessionId).toBe(sessionId);

    const state = scheduler.getState(sessionId);
    expect(state?.isStale).toBe(true);
  }, 5000);

  it("stopWatching 후에는 이벤트 발생하지 않음", async () => {
    const watcher = new Watcher(scheduler, config);
    const changes: string[] = [];

    watcher.onSessionChange((sessionId) => {
      changes.push(sessionId);
    });

    await watcher.startWatching();
    await watcher.stopWatching();

    const sessionId = "11111111-2222-3333-4444-555555555555";
    const jsonlPath = join(tmpDir, "projects", "test-project", `${sessionId}.jsonl`);
    await writeFile(jsonlPath, '{"type":"user"}\n');
    await new Promise((r) => setTimeout(r, 500));

    expect(changes).toHaveLength(0);
  });
});
