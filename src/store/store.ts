import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionSummary, IndexEntry, SyncConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

function resolvePath(path: string): string {
  return path.startsWith("~") ? path.replace("~", homedir()) : path;
}

export class Store {
  private readonly syncDir: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;

  constructor(config: SyncConfig = DEFAULT_CONFIG) {
    this.syncDir = resolvePath(config.syncDir);
    this.sessionsDir = join(this.syncDir, "sessions");
    this.indexPath = join(this.syncDir, "index.json");
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  async writeSummary(summary: SessionSummary): Promise<void> {
    await this.ensureDirectories();

    const mdPath = join(this.sessionsDir, `${summary.sessionId}-summary.md`);
    await writeFile(mdPath, summary.raw, "utf-8");

    const index = await this.readIndex();
    const existing = index.findIndex((e) => e.sessionId === summary.sessionId);
    const entry: IndexEntry = {
      sessionId: summary.sessionId,
      project: summary.project,
      updatedAt: summary.updatedAt,
    };
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf-8");

    const dataPath = join(this.sessionsDir, `${summary.sessionId}.json`);
    await writeFile(dataPath, JSON.stringify(summary, null, 2), "utf-8");
  }

  async readSummary(sessionId: string): Promise<SessionSummary | null> {
    const dataPath = join(this.sessionsDir, `${sessionId}.json`);
    try {
      const raw = await readFile(dataPath, "utf-8");
      return JSON.parse(raw) as SessionSummary;
    } catch {
      return null;
    }
  }

  async listSummaries(): Promise<SessionSummary[]> {
    const index = await this.readIndex();
    const summaries: SessionSummary[] = [];
    for (const entry of index) {
      const summary = await this.readSummary(entry.sessionId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  async deleteSummary(sessionId: string): Promise<void> {
    const mdPath = join(this.sessionsDir, `${sessionId}-summary.md`);
    const dataPath = join(this.sessionsDir, `${sessionId}.json`);

    await Promise.all([
      unlink(mdPath).catch(() => {}),
      unlink(dataPath).catch(() => {}),
    ]);

    const index = await this.readIndex();
    const filtered = index.filter((e) => e.sessionId !== sessionId);
    await writeFile(this.indexPath, JSON.stringify(filtered, null, 2), "utf-8");
  }

  private async readIndex(): Promise<IndexEntry[]> {
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      return JSON.parse(raw) as IndexEntry[];
    } catch {
      return [];
    }
  }
}
