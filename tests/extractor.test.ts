import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractMessages,
  extractRecentMessages,
  countNewMessages,
} from "../src/summarizer/extractor.js";

function jsonl(...entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

describe("extractor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extractor-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts user and assistant messages", async () => {
    const path = join(tmpDir, "session.jsonl");
    await writeFile(
      path,
      jsonl(
        { type: "permission-mode", permissionMode: "default" },
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "안녕하세요" },
        },
        {
          type: "attachment",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:00:01Z",
        },
        {
          type: "assistant",
          uuid: "as1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:00:02Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "생각 중..." },
              { type: "text", text: "반갑습니다" },
            ],
          },
        },
      ),
    );

    const messages = await extractMessages(path);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe("user");
    expect(messages[0].content).toBe("안녕하세요");
    expect(messages[1].type).toBe("assistant");
    expect(messages[1].content).toBe("반갑습니다");
  });

  it("skips sidechain messages", async () => {
    const path = join(tmpDir, "session.jsonl");
    await writeFile(
      path,
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          isSidechain: false,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "메인 체인" },
        },
        {
          type: "user",
          uuid: "u2",
          parentUuid: "u1",
          isSidechain: true,
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "user", content: "사이드 체인" },
        },
      ),
    );

    const messages = await extractMessages(path);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("메인 체인");
  });

  it("skips entries with empty text content", async () => {
    const path = join(tmpDir, "session.jsonl");
    await writeFile(
      path,
      jsonl(
        {
          type: "assistant",
          uuid: "as1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "생각만..." }],
          },
        },
        {
          type: "assistant",
          uuid: "as2",
          parentUuid: "as1",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "실제 응답" }],
          },
        },
      ),
    );

    const messages = await extractMessages(path);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("실제 응답");
  });

  it("handles malformed JSON lines gracefully", async () => {
    const path = join(tmpDir, "session.jsonl");
    await writeFile(
      path,
      [
        "not valid json",
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "정상 메시지" },
        }),
        "",
      ].join("\n"),
    );

    const messages = await extractMessages(path);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("정상 메시지");
  });

  it("extractRecentMessages returns last N messages", async () => {
    const path = join(tmpDir, "session.jsonl");
    const entries = Array.from({ length: 10 }, (_, i) => ({
      type: "user",
      uuid: `u${i}`,
      parentUuid: i > 0 ? `u${i - 1}` : null,
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      message: { role: "user", content: `메시지 ${i}` },
    }));
    await writeFile(path, jsonl(...entries));

    const recent = await extractRecentMessages(path, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe("메시지 7");
    expect(recent[2].content).toBe("메시지 9");
  });

  it("countNewMessages counts messages after given timestamp", async () => {
    const path = join(tmpDir, "session.jsonl");
    await writeFile(
      path,
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "이전" },
        },
        {
          type: "user",
          uuid: "u2",
          parentUuid: "u1",
          timestamp: "2026-01-01T01:00:00Z",
          message: { role: "user", content: "이후 1" },
        },
        {
          type: "assistant",
          uuid: "as1",
          parentUuid: "u2",
          timestamp: "2026-01-01T02:00:00Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "이후 2" }],
          },
        },
      ),
    );

    const count = await countNewMessages(path, "2026-01-01T00:30:00Z");
    expect(count).toBe(2);
  });

  it("joins multiple text blocks in assistant content", async () => {
    const path = join(tmpDir, "session.jsonl");
    await writeFile(
      path,
      jsonl({
        type: "assistant",
        uuid: "as1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "첫 번째" },
            { type: "text", text: "두 번째" },
          ],
        },
      }),
    );

    const messages = await extractMessages(path);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("첫 번째\n두 번째");
  });
});
