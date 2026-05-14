import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/store.js";
import type { SessionSummary, SyncConfig } from "../src/types.js";

function makeConfig(syncDir: string): SyncConfig {
  return {
    claudeDir: join(syncDir, ".."),
    syncDir,
    triggerMessageCount: 10,
    fullResummarizeAfter: 4,
  };
}

function makeSummary(id: string, project = "test-project"): SessionSummary {
  return {
    sessionId: id,
    project,
    updatedAt: new Date().toISOString(),
    incrementalCount: 0,
    summary: {
      task: "테스트 작업",
      changedFiles: ["src/index.ts"],
      decisions: ["vitest 사용"],
      currentState: "진행 중",
      blockers: [],
      impactOnOtherSessions: [],
    },
    raw: `# Session ${id}\n테스트 요약`,
  };
}

describe("Store", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "store-test-"));
    store = new Store(makeConfig(tmpDir));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("ensureDirectories creates sessions directory", async () => {
    await store.ensureDirectories();
    const { stat } = await import("node:fs/promises");
    const s = await stat(join(tmpDir, "sessions"));
    expect(s.isDirectory()).toBe(true);
  });

  it("writeSummary then readSummary round-trips", async () => {
    const summary = makeSummary("abc-123");
    await store.writeSummary(summary);

    const read = await store.readSummary("abc-123");
    expect(read).not.toBeNull();
    expect(read!.sessionId).toBe("abc-123");
    expect(read!.summary.task).toBe("테스트 작업");
    expect(read!.raw).toContain("테스트 요약");
  });

  it("readSummary returns null for nonexistent session", async () => {
    const read = await store.readSummary("nonexistent");
    expect(read).toBeNull();
  });

  it("listSummaries returns all written summaries", async () => {
    await store.writeSummary(makeSummary("s1"));
    await store.writeSummary(makeSummary("s2"));
    await store.writeSummary(makeSummary("s3"));

    const list = await store.listSummaries();
    expect(list).toHaveLength(3);
    const ids = list.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  it("writeSummary updates existing entry", async () => {
    const s1 = makeSummary("abc");
    await store.writeSummary(s1);

    const s2 = { ...s1, summary: { ...s1.summary, task: "변경된 작업" } };
    await store.writeSummary(s2);

    const read = await store.readSummary("abc");
    expect(read!.summary.task).toBe("변경된 작업");

    const list = await store.listSummaries();
    expect(list).toHaveLength(1);
  });

  it("deleteSummary removes session data", async () => {
    await store.writeSummary(makeSummary("del-me"));
    await store.deleteSummary("del-me");

    const read = await store.readSummary("del-me");
    expect(read).toBeNull();

    const list = await store.listSummaries();
    expect(list).toHaveLength(0);
  });

  it("deleteSummary on nonexistent session does not throw", async () => {
    await expect(store.deleteSummary("nope")).resolves.not.toThrow();
  });

  it("cleanup removes summaries for inactive sessions", async () => {
    await store.writeSummary(makeSummary("active-1"));
    await store.writeSummary(makeSummary("active-2"));
    await store.writeSummary(makeSummary("dead-1"));
    await store.writeSummary(makeSummary("dead-2"));

    const activeIds = new Set(["active-1", "active-2"]);
    const removed = await store.cleanup(activeIds);

    expect(removed.sort()).toEqual(["dead-1", "dead-2"]);
    expect(await store.listSummaries()).toHaveLength(2);
    expect(await store.readSummary("dead-1")).toBeNull();
    expect(await store.readSummary("active-1")).not.toBeNull();
  });
});
