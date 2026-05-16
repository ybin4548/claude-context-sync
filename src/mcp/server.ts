import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Watcher } from "../watcher/watcher.js";
import { Scheduler } from "../watcher/scheduler.js";
import { Store } from "../store/store.js";
import {
  extractMessages,
  extractStratifiedMessages,
  countNewMessages,
} from "../summarizer/extractor.js";
import {
  generateFullSummary,
  generateIncrementalSummary,
} from "../summarizer/generator.js";
import type { SessionMeta, SyncConfig } from "../types.js";
import { DEFAULT_CONFIG, STRATIFIED_THRESHOLD } from "../types.js";

export function createServer(config: SyncConfig = DEFAULT_CONFIG) {
  const scheduler = new Scheduler(config);
  const watcher = new Watcher(scheduler, config);
  const store = new Store(config);

  const server = new McpServer({
    name: "claude-context-sync",
    version: "0.1.0",
  });

  server.tool(
    "list_sessions",
    "활성 Claude Code 세션 목록과 요약 상태를 반환합니다",
    async () => {
      const sessions = await watcher.getActiveSessions();
      const activeIds = new Set(sessions.map((s) => s.sessionId));
      await store.cleanup(activeIds);

      const summaries = await store.listSummaries();
      const summaryMap = new Map(summaries.map((s) => [s.sessionId, s]));

      const items = sessions.map((s) => {
        const summary = summaryMap.get(s.sessionId);
        return {
          sessionId: s.sessionId,
          project: s.cwd,
          status: s.status,
          task: summary?.summary.task ?? "(요약 없음)",
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

      const summary = await refreshIfNeeded(
        sessionId,
        meta,
        scheduler,
        store,
        watcher,
      );

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary?.summary ?? null, null, 2) },
        ],
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

      const summaries = await Promise.all(
        sessions.map((meta) =>
          refreshIfNeeded(meta.sessionId, meta, scheduler, store, watcher),
        ),
      );

      const result = summaries
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .filter((s) => !project || s.project.includes(project))
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

  return { server, watcher, scheduler, store };
}

async function refreshIfNeeded(
  sessionId: string,
  meta: SessionMeta,
  scheduler: Scheduler,
  store: Store,
  watcher: Watcher,
) {
  const project = meta.cwd;
  const jsonlPath = watcher.getJsonlPath(
    sessionId,
    meta.cwd.replace(/\//g, "-"),
  );

  let messageCount: number;
  try {
    const messages = await extractMessages(jsonlPath);
    messageCount = messages.length;
  } catch {
    return store.readSummary(sessionId);
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
        : await extractMessages(jsonlPath);
      const summary = await generateFullSummary(messages, meta, project, sampled);
      await store.writeSummary(summary);
      scheduler.recordSummarized(sessionId, "full", messageCount);
      return summary;
    }

    const existing = await store.readSummary(sessionId);
    if (existing) {
      const newMsgCount = await countNewMessages(
        jsonlPath,
        existing.updatedAt,
      );
      const messages = await extractMessages(jsonlPath);
      const newMessages = messages.slice(-newMsgCount);
      const summary = await generateIncrementalSummary(existing, newMessages);
      await store.writeSummary(summary);
      scheduler.recordSummarized(sessionId, "incremental", messageCount);
      return summary;
    }

    const sampled = messageCount > STRATIFIED_THRESHOLD;
    const messages = sampled
      ? await extractStratifiedMessages(jsonlPath)
      : await extractMessages(jsonlPath);
    const summary = await generateFullSummary(messages, meta, project, sampled);
    await store.writeSummary(summary);
    scheduler.recordSummarized(sessionId, "full", messageCount);
    return summary;
  } catch {
    return store.readSummary(sessionId);
  }
}

export async function startServer(config: SyncConfig = DEFAULT_CONFIG) {
  const { server, watcher } = createServer(config);
  await watcher.startWatching();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
