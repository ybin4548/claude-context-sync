import { watch, type FSWatcher } from "chokidar";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SessionMeta, SyncConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { Scheduler } from "./scheduler.js";

export type SessionChangeCallback = (
  sessionId: string,
  jsonlPath: string,
) => void;

export class Watcher {
  private readonly projectsDir: string;
  private readonly sessionsDir: string;
  private readonly scheduler: Scheduler;
  private readonly callbacks: SessionChangeCallback[] = [];
  private fsWatcher: FSWatcher | null = null;

  constructor(scheduler: Scheduler, config: SyncConfig = DEFAULT_CONFIG) {
    const claudeDir = config.claudeDir.replace("~", homedir());
    this.projectsDir = join(claudeDir, "projects");
    this.sessionsDir = join(claudeDir, "sessions");
    this.scheduler = scheduler;
  }

  async startWatching(): Promise<void> {
    if (this.fsWatcher) return;

    // chokidar v5 타입 정의에 recursive가 누락되어 있지만 런타임에서 동작함
    this.fsWatcher = watch(this.projectsDir, {
      ignoreInitial: true,
      ...(({ recursive: true }) as Record<string, unknown>),
    });

    const handler = (filePath: string) => {
      if (!filePath.endsWith(".jsonl")) return;
      const sessionId = this.extractSessionId(filePath);
      if (!sessionId) return;

      this.scheduler.markStale(sessionId);
      for (const cb of this.callbacks) {
        cb(sessionId, filePath);
      }
    };

    this.fsWatcher.on("add", handler);
    this.fsWatcher.on("change", handler);

    await new Promise<void>((resolve) => {
      this.fsWatcher!.on("ready", resolve);
    });
  }

  async stopWatching(): Promise<void> {
    if (this.fsWatcher) {
      await this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  onSessionChange(callback: SessionChangeCallback): void {
    this.callbacks.push(callback);
  }

  async getActiveSessions(): Promise<SessionMeta[]> {
    const sessions: SessionMeta[] = [];

    try {
      const files = await readdir(this.sessionsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.sessionsDir, file), "utf-8");
          const data = JSON.parse(raw) as SessionMeta & { updatedAt?: number };
          sessions.push({
            pid: data.pid,
            sessionId: data.sessionId,
            cwd: data.cwd,
            status: data.status,
            startedAt: data.startedAt,
            version: data.version,
          });
        } catch {
          // 파싱 실패한 파일은 무시
        }
      }
    } catch {
      // sessions 디렉터리가 없으면 빈 배열
    }

    return sessions;
  }

  getJsonlPath(sessionId: string, project: string): string {
    const projectDir = project.replace(/\//g, "-");
    return join(this.projectsDir, projectDir, `${sessionId}.jsonl`);
  }

  resolveProjectFromPath(jsonlPath: string): string {
    const relative = jsonlPath.slice(this.projectsDir.length + 1);
    const projectDir = relative.split("/")[0];
    return projectDir.replace(/^-/, "/").replace(/-/g, "/");
  }

  private extractSessionId(filePath: string): string | null {
    const file = basename(filePath, ".jsonl");
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    return uuidPattern.test(file) ? file : null;
  }
}
