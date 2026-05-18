import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Watcher } from "../watcher/watcher.js";
import { Scheduler } from "../watcher/scheduler.js";
import { Store } from "../store/store.js";
import {
  extractMessages,
  extractStratifiedMessages,
  countNewMessagesFromArray,
} from "../summarizer/extractor.js";
import {
  generateFullSummary,
  generateIncrementalSummary,
} from "../summarizer/generator.js";
import { Messenger } from "../messaging/messenger.js";
import type { SessionMeta, SessionSummary, SyncConfig } from "../types.js";
import { DEFAULT_CONFIG, STRATIFIED_THRESHOLD, VERSION } from "../types.js";

const CONCURRENCY_LIMIT = 3;

export function createServer(config: SyncConfig = DEFAULT_CONFIG) {
  const scheduler = new Scheduler(config);
  const watcher = new Watcher(scheduler, config);
  const store = new Store(config);
  const messenger = new Messenger(config);
  let lastCleanupAt = 0;
  const refreshLocks = new Map<string, Promise<SessionSummary | null>>();

  function refreshIfNeeded(
    sessionId: string,
    meta: SessionMeta,
  ): Promise<SessionSummary | null> {
    const inflight = refreshLocks.get(sessionId);
    if (inflight) return inflight;

    const promise = doRefresh(sessionId, meta);
    refreshLocks.set(sessionId, promise);
    return promise.finally(() => refreshLocks.delete(sessionId));
  }

  async function doRefresh(
    sessionId: string,
    meta: SessionMeta,
  ): Promise<SessionSummary | null> {
    const project = meta.cwd;
    const jsonlPath = watcher.getJsonlPath(sessionId, meta.cwd);

    let allMessages;
    try {
      allMessages = await extractMessages(jsonlPath);
    } catch {
      return store.readSummary(sessionId);
    }

    const messageCount = allMessages.length;

    if (!scheduler.getState(sessionId)) {
      const existing = await store.readSummary(sessionId);
      if (existing) {
        scheduler.seedState(sessionId, messageCount, existing.incrementalCount);
      }
      scheduler.markStale(sessionId);
    }

    const strategy = scheduler.getStrategy(sessionId, messageCount);

    if (strategy === "cached") {
      return store.readSummary(sessionId);
    }

    try {
      if (strategy === "full") {
        const sampled = messageCount > STRATIFIED_THRESHOLD;
        const messages = sampled
          ? await extractStratifiedMessages(jsonlPath)
          : allMessages;
        const summary = await generateFullSummary(messages, meta, project, sampled);
        await store.writeSummary(summary);
        scheduler.recordSummarized(sessionId, "full", messageCount);
        return summary;
      }

      const existing = await store.readSummary(sessionId);
      if (existing) {
        const newMsgCount = countNewMessagesFromArray(
          allMessages,
          existing.updatedAt,
        );
        const newMessages = allMessages.slice(-newMsgCount);
        const summary = await generateIncrementalSummary(existing, newMessages);
        await store.writeSummary(summary);
        scheduler.recordSummarized(sessionId, "incremental", messageCount);
        return summary;
      }

      const sampled = messageCount > STRATIFIED_THRESHOLD;
      const messages = sampled
        ? await extractStratifiedMessages(jsonlPath)
        : allMessages;
      const summary = await generateFullSummary(messages, meta, project, sampled);
      await store.writeSummary(summary);
      scheduler.recordSummarized(sessionId, "full", messageCount);
      return summary;
    } catch {
      return store.readSummary(sessionId);
    }
  }

  const server = new McpServer({
    name: "claude-context-sync",
    version: VERSION,
  });

  server.tool(
    "list_sessions",
    "활성 Claude Code 세션 목록과 요약 상태를 반환합니다",
    async () => {
      const sessions = await watcher.getActiveSessions();

      const now = Date.now();
      if (now - lastCleanupAt > 60_000) {
        const activeIds = new Set(sessions.map((s) => s.sessionId));
        await Promise.all([
          store.cleanup(activeIds),
          watcher.fileTracker.cleanup(activeIds),
        ]);
        lastCleanupAt = now;
      }

      const summaries = await store.listSummaries();
      const summaryMap = new Map(summaries.map((s) => [s.sessionId, s]));

      const projects = [...new Set(sessions.map((s) => s.cwd))];
      const allConflicts = new Map<string, { file: string; sessionIds: string[]; symbols: string[] }[]>();
      for (const project of projects) {
        const conflicts = await watcher.fileTracker.getConflicts(project);
        if (conflicts.length > 0) allConflicts.set(project, conflicts);
      }

      const items = sessions.map((s) => {
        const summary = summaryMap.get(s.sessionId);
        const projectConflicts = allConflicts.get(s.cwd);
        const myConflicts = projectConflicts
          ?.filter((c) => c.sessionIds.includes(s.sessionId))
          .map((c) => ({
            file: c.file,
            sessions: c.sessionIds.filter((id) => id !== s.sessionId),
            ...(c.symbols.length > 0 && { symbols: c.symbols }),
          }));
        return {
          sessionId: s.sessionId,
          project: s.cwd,
          status: s.status,
          task: summary?.summary.task ?? "(요약 없음)",
          ...(myConflicts?.length && { conflicts: myConflicts }),
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
      };
    },
  );

  server.tool(
    "get_session_context",
    "특정 세션의 구조화된 요약을 반환합니다. 낙후된 경우 자동으로 재요약합니다.",
    { sessionId: z.string().describe("조회할 세션 ID") },
    async ({ sessionId }) => {
      const sessions = await watcher.getActiveSessions();
      const meta = sessions.find((s) => s.sessionId === sessionId);
      if (!meta) {
        return {
          content: [{ type: "text" as const, text: `세션 ${sessionId}을 찾을 수 없습니다` }],
          isError: true,
        };
      }

      const summary = await refreshIfNeeded(sessionId, meta);
      if (!summary) {
        return {
          content: [{ type: "text" as const, text: "null" }],
        };
      }

      const projectConflicts = await watcher.fileTracker.getConflicts(meta.cwd);
      const myConflicts = projectConflicts
        .filter((c) => c.sessionIds.includes(sessionId))
        .map((c) => ({
          file: c.file,
          sessions: c.sessionIds.filter((id) => id !== sessionId),
          ...(c.symbols.length > 0 && { symbols: c.symbols }),
        }));

      const result = {
        ...summary.summary,
        ...(myConflicts.length > 0 && { conflicts: myConflicts }),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "get_all_changes",
    "모든 세션의 변경 파일과 결정사항을 통합하여 반환합니다",
    {
      project: z
        .string()
        .optional()
        .describe("필터링할 프로젝트 경로 (생략 시 전체)"),
    },
    async ({ project }) => {
      const sessions = await watcher.getActiveSessions();
      const filtered = project
        ? sessions.filter((s) => s.cwd === project)
        : sessions;

      const summaries: (SessionSummary | null)[] = [];
      for (let i = 0; i < filtered.length; i += CONCURRENCY_LIMIT) {
        const batch = filtered.slice(i, i + CONCURRENCY_LIMIT);
        const results = await Promise.all(
          batch.map((meta) => refreshIfNeeded(meta.sessionId, meta)),
        );
        summaries.push(...results);
      }

      const result = summaries
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({
          sessionId: s.sessionId,
          project: s.project,
          changedFiles: s.summary.changedFiles,
          decisions: s.summary.decisions,
        }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "resolve_conflicts",
    "충돌이 해결된 파일을 추적 목록에서 제거합니다",
    {
      sessionId: z.string().describe("충돌을 해결한 세션 ID"),
      files: z.array(z.string()).describe("해결된 파일 경로 배열"),
    },
    async ({ sessionId, files }) => {
      const resolved = await watcher.fileTracker.resolveConflicts(
        sessionId,
        files,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              resolved.length > 0
                ? `${resolved.length}개 파일 충돌 해결됨: ${resolved.join(", ")}`
                : "해결할 충돌이 없습니다",
          },
        ],
      };
    },
  );

  server.tool(
    "send_message",
    "다른 세션에 메시지를 전달합니다. targetSessionId 생략 시 같은 프로젝트의 모든 세션에 브로드캐스트합니다.",
    {
      fromSessionId: z.string().describe("발신 세션 ID"),
      message: z.string().describe("전달할 메시지"),
      project: z.string().describe("프로젝트 경로"),
      targetSessionId: z
        .string()
        .optional()
        .describe("대상 세션 ID (생략 시 브로드캐스트)"),
    },
    async ({ fromSessionId, message, project, targetSessionId }) => {
      if (targetSessionId) {
        const msg = await messenger.send(
          fromSessionId,
          targetSessionId,
          project,
          message,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `메시지 전송 완료 → ${targetSessionId} (id: ${msg.id})`,
            },
          ],
        };
      }

      const sessions = await watcher.getActiveSessions();
      const projectSessions = sessions
        .filter((s) => s.cwd === project)
        .map((s) => s.sessionId);
      const count = await messenger.broadcast(
        fromSessionId,
        project,
        message,
        projectSessions,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `브로드캐스트 완료 → ${count}개 세션에 전송`,
          },
        ],
      };
    },
  );

  server.tool(
    "get_messages",
    "세션의 수신 메시지 이력을 조회합니다",
    {
      sessionId: z.string().describe("조회할 세션 ID"),
      unreadOnly: z
        .boolean()
        .optional()
        .describe("읽지 않은 메시지만 조회 (기본: false)"),
    },
    async ({ sessionId, unreadOnly }) => {
      const messages = unreadOnly
        ? await messenger.getUnread(sessionId)
        : await messenger.getHistory(sessionId);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(messages, null, 2) },
        ],
      };
    },
  );

  return { server, watcher, scheduler, store, messenger };
}

export async function startServer(config: SyncConfig = DEFAULT_CONFIG) {
  const { server, watcher } = createServer(config);
  await watcher.startWatching();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
