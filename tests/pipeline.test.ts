import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMessages } from "../src/summarizer/extractor.js";
import { Store } from "../src/store/store.js";
import { Scheduler } from "../src/watcher/scheduler.js";
import type { SessionMeta, SyncConfig } from "../src/types.js";

const mockSummaryJson = JSON.stringify({
  task: "파이프라인 테스트",
  changedFiles: ["src/pipeline.ts"],
  decisions: ["통합 테스트 추가"],
  currentState: "완료",
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
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
    };
    setTimeout(() => cb(null, mockSummaryJson, ""), 0);
    return child;
  },
}));

const { generateFullSummary } = await import("../src/summarizer/generator.js");

describe("extractor → generator → store 파이프라인", () => {
  let tmpDir: string;
  let store: Store;
  let scheduler: Scheduler;

  const config: SyncConfig = {
    claudeDir: "",
    syncDir: "",
    triggerMessageCount: 2,
    fullResummarizeAfter: 4,
  };

  const meta: SessionMeta = {
    pid: 1,
    sessionId: "pipe-session",
    cwd: "/test",
    status: "idle",
    startedAt: Date.now(),
    version: "1.0.0",
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
    config.syncDir = tmpDir;
    store = new Store(config);
    scheduler = new Scheduler(config);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("전체 파이프라인: extract → schedule → generate → store", async () => {
    const jsonlPath = join(tmpDir, "session.jsonl");
    await writeFile(
      jsonlPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "기능 구현해줘" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "구현하겠습니다" }],
          },
        }),
      ].join("\n"),
    );

    // 1. Extract
    const messages = await extractMessages(jsonlPath);
    expect(messages).toHaveLength(2);

    // 2. Schedule
    scheduler.markStale("pipe-session");
    const strategy = scheduler.getStrategy("pipe-session", messages.length);
    expect(strategy).toBe("incremental");

    // 3. Generate
    const summary = await generateFullSummary(messages, meta, "test-project");
    expect(summary.summary.task).toBe("파이프라인 테스트");

    // 4. Store
    await store.writeSummary(summary);
    const read = await store.readSummary("pipe-session");
    expect(read).not.toBeNull();
    expect(read!.summary.task).toBe("파이프라인 테스트");

    // 5. Record
    scheduler.recordSummarized("pipe-session", "incremental", messages.length);
    expect(scheduler.getStrategy("pipe-session", messages.length)).toBe("cached");
  });
});
