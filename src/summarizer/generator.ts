import { execFile } from "node:child_process";
import type { SessionMessage, SessionMeta, SessionSummary } from "../types.js";

function formatMessages(messages: SessionMessage[]): string {
  return messages
    .map((m) => `[${m.type}] (${m.timestamp})\n${m.content}`)
    .join("\n\n---\n\n");
}

const SUMMARY_JSON_SCHEMA = `{
  "task": "현재 작업 요약 (한 줄)",
  "changedFiles": ["변경된 파일 경로 배열"],
  "decisions": ["내린 결정사항 배열"],
  "currentState": "현재 진행 상태",
  "blockers": ["차단 요소 배열 (없으면 빈 배열)"],
  "impactOnOtherSessions": ["다른 세션에 영향을 줄 수 있는 사항 (없으면 빈 배열)"]
}`;

function buildFullPrompt(
  messages: string,
  meta: SessionMeta,
  sampled = false,
): string {
  const sampledNote = sampled
    ? "\n주의: 이 로그는 대용량 세션에서 구간 샘플링되었습니다. 초반(목표/설정) + 중간(user 지시) + 최근(현재 상태) 메시지입니다. 빠진 부분은 문맥으로 추론하세요.\n"
    : "";

  return `다음은 Claude Code 세션의 대화 로그입니다.
프로젝트 경로: ${meta.cwd}
세션 ID: ${meta.sessionId}
${sampledNote}
아래 JSON 스키마에 맞게 구조화된 요약을 생성하세요. JSON만 출력하세요.

${SUMMARY_JSON_SCHEMA}

---
대화 로그:
${messages}`;
}

function buildIncrementalPrompt(
  existing: SessionSummary,
  newMessages: string,
): string {
  return `기존 요약과 새로운 대화 로그를 바탕으로 요약을 업데이트하세요.
기존 요약: ${JSON.stringify(existing.summary)}

아래 JSON 스키마에 맞게 업데이트된 요약을 생성하세요. JSON만 출력하세요.

${SUMMARY_JSON_SCHEMA}

---
새로운 대화 로그:
${newMessages}`;
}

function callClaude(prompt: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "text", "--model", "haiku"],
      { maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`claude -p failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function findFirstJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("No JSON found in claude -p response");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return raw.slice(start, i + 1);
  }
  throw new Error("Unbalanced JSON in claude -p response");
}

function parseSummaryJson(
  raw: string,
): SessionSummary["summary"] {
  const json = findFirstJsonObject(raw);
  return JSON.parse(json) as SessionSummary["summary"];
}

export async function generateFullSummary(
  messages: SessionMessage[],
  meta: SessionMeta,
  project: string,
  sampled = false,
): Promise<SessionSummary> {
  const formatted = formatMessages(messages);
  const prompt = buildFullPrompt(formatted, meta, sampled);
  const raw = await callClaude(prompt);
  const summary = parseSummaryJson(raw);

  return {
    sessionId: meta.sessionId,
    project,
    updatedAt: new Date().toISOString(),
    incrementalCount: 0,
    summary,
    raw,
  };
}

export async function generateIncrementalSummary(
  existing: SessionSummary,
  newMessages: SessionMessage[],
): Promise<SessionSummary> {
  const formatted = formatMessages(newMessages);
  const prompt = buildIncrementalPrompt(existing, formatted);
  const raw = await callClaude(prompt);
  const summary = parseSummaryJson(raw);

  return {
    ...existing,
    updatedAt: new Date().toISOString(),
    incrementalCount: existing.incrementalCount + 1,
    summary,
    raw,
  };
}

export { callClaude as _callClaude, parseSummaryJson as _parseSummaryJson };
