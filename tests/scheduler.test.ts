import { describe, it, expect } from "vitest";
import { Scheduler } from "../src/watcher/scheduler.js";
import type { SyncConfig } from "../src/types.js";

const config: SyncConfig = {
  claudeDir: "~/.claude",
  syncDir: "~/.claude/context-sync",
  triggerMessageCount: 10,
  fullResummarizeAfter: 4,
};

describe("Scheduler", () => {
  it("새 세션은 cached 반환", () => {
    const s = new Scheduler(config);
    expect(s.getStrategy("s1", 0)).toBe("cached");
  });

  it("stale이지만 새 메시지가 부족하면 cached", () => {
    const s = new Scheduler(config);
    s.markStale("s1");
    expect(s.getStrategy("s1", 5)).toBe("cached");
  });

  it("stale + 새 메시지 10개 이상이면 incremental", () => {
    const s = new Scheduler(config);
    s.markStale("s1");
    expect(s.getStrategy("s1", 10)).toBe("incremental");
  });

  it("incremental 4회 누적 후 full 판정", () => {
    const s = new Scheduler(config);

    for (let i = 0; i < 4; i++) {
      s.markStale("s1");
      const count = (i + 1) * 10;
      expect(s.getStrategy("s1", count)).toBe("incremental");
      s.recordSummarized("s1", "incremental", count);
    }

    s.markStale("s1");
    expect(s.getStrategy("s1", 50)).toBe("full");
  });

  it("full 요약 후 incrementalCount 리셋", () => {
    const s = new Scheduler(config);

    for (let i = 0; i < 4; i++) {
      s.markStale("s1");
      s.recordSummarized("s1", "incremental", (i + 1) * 10);
    }

    s.recordSummarized("s1", "full", 50);
    const state = s.getState("s1");
    expect(state?.incrementalCount).toBe(0);
    expect(state?.isStale).toBe(false);
  });

  it("recordSummarized 후 stale 해제", () => {
    const s = new Scheduler(config);
    s.markStale("s1");
    s.recordSummarized("s1", "incremental", 10);

    expect(s.getStrategy("s1", 10)).toBe("cached");
  });

  it("seedState는 기존 요약 상태를 복원", () => {
    const s = new Scheduler(config);
    s.seedState("s1", 500, 2);
    s.markStale("s1");

    // lastMessageCount=500, currentMessageCount=500 → newMessages=0 < trigger → cached
    expect(s.getStrategy("s1", 500)).toBe("cached");

    // 새 메시지 추가되면 incremental (incrementalCount=2 < fullAfter=4)
    expect(s.getStrategy("s1", 510)).toBe("incremental");
  });

  it("seedState 후 incrementalCount가 fullAfter 이상이면 full", () => {
    const s = new Scheduler(config);
    s.seedState("s1", 500, 4);
    s.markStale("s1");

    expect(s.getStrategy("s1", 510)).toBe("full");
  });

  it("서로 다른 세션은 독립적으로 관리", () => {
    const s = new Scheduler(config);
    s.markStale("s1");
    s.markStale("s2");

    s.recordSummarized("s1", "incremental", 10);

    expect(s.getStrategy("s1", 10)).toBe("cached");
    expect(s.getStrategy("s2", 10)).toBe("incremental");
  });
});
