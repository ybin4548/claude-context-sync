import { describe, it, expect, vi } from "vitest";
import type { SessionMessage, SessionMeta, SessionSummary } from "../src/types.js";

const mockSummaryJson = JSON.stringify({
  task: "테스트 기능 구현",
  changedFiles: ["src/test.ts"],
  decisions: ["vitest 사용"],
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
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
    };
    setTimeout(() => cb(null, mockSummaryJson, ""), 0);
    return child;
  },
}));

const { generateFullSummary, generateIncrementalSummary, _parseSummaryJson } =
  await import("../src/summarizer/generator.js");

const meta: SessionMeta = {
  pid: 1234,
  sessionId: "test-session",
  cwd: "/test/project",
  status: "idle",
  startedAt: Date.now(),
  version: "1.0.0",
};

const messages: SessionMessage[] = [
  {
    type: "user",
    content: "테스트 기능 만들어줘",
    timestamp: "2026-01-01T00:00:00Z",
    uuid: "u1",
    parentUuid: null,
  },
  {
    type: "assistant",
    content: "vitest로 테스트를 작성하겠습니다.",
    timestamp: "2026-01-01T00:00:01Z",
    uuid: "a1",
    parentUuid: "u1",
  },
];

describe("generator", () => {
  it("generateFullSummary는 SessionSummary를 반환", async () => {
    const result = await generateFullSummary(messages, meta, "test-project");

    expect(result.sessionId).toBe("test-session");
    expect(result.project).toBe("test-project");
    expect(result.incrementalCount).toBe(0);
    expect(result.summary.task).toBe("테스트 기능 구현");
    expect(result.summary.changedFiles).toEqual(["src/test.ts"]);
  });

  it("generateIncrementalSummary는 incrementalCount를 증가", async () => {
    const existing: SessionSummary = {
      sessionId: "test-session",
      project: "test-project",
      updatedAt: "2026-01-01T00:00:00Z",
      incrementalCount: 2,
      summary: {
        task: "이전 작업",
        changedFiles: [],
        decisions: [],
        currentState: "진행 중",
        blockers: [],
        impactOnOtherSessions: [],
      },
      raw: "",
    };

    const result = await generateIncrementalSummary(existing, messages);

    expect(result.incrementalCount).toBe(3);
    expect(result.summary.task).toBe("테스트 기능 구현");
    expect(result.sessionId).toBe("test-session");
  });

  it("parseSummaryJson은 markdown 감싸진 JSON도 파싱", () => {
    const wrapped = `다음은 요약입니다:\n\`\`\`json\n${mockSummaryJson}\n\`\`\``;
    const result = _parseSummaryJson(wrapped);
    expect(result.task).toBe("테스트 기능 구현");
  });

  it("parseSummaryJson은 JSON 없으면 에러", () => {
    expect(() => _parseSummaryJson("no json here")).toThrow(
      "No JSON found",
    );
  });

  it("parseSummaryJson은 첫 번째 완전한 JSON 객체를 파싱", () => {
    const input = `설명입니다:\n${mockSummaryJson}\n추가 텍스트`;
    const result = _parseSummaryJson(input);
    expect(result.task).toBe("테스트 기능 구현");
  });

  it("parseSummaryJson은 중괄호가 포함된 문자열 값을 처리", () => {
    const json = JSON.stringify({
      task: "fix {bug} in code",
      changedFiles: [],
      decisions: [],
      currentState: "완료",
      blockers: [],
      impactOnOtherSessions: [],
    });
    const result = _parseSummaryJson(`Here: ${json}`);
    expect(result.task).toBe("fix {bug} in code");
  });
});
