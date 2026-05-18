import { readFile, writeFile, readdir, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SyncConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

interface TouchedSession {
  sessionId: string;
  project: string;
  files: string[];
  updatedAt: string;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: { file_path?: string };
}

interface JournalLine {
  type: string;
  message?: {
    content?: ContentBlock[];
  };
}

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function resolveSyncDir(config: SyncConfig): string {
  const dir = config.syncDir;
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? dir.replace("~/", `${homedir()}/`) : dir;
}

export class FileTracker {
  private readonly touchedDir: string;
  private readonly sessionFiles = new Map<string, Set<string>>();
  private readonly sessionOffsets = new Map<string, number>();

  constructor(config: SyncConfig = DEFAULT_CONFIG) {
    this.touchedDir = join(resolveSyncDir(config), "touched");
  }

  async processNewEntries(
    sessionId: string,
    jsonlPath: string,
    project: string,
  ): Promise<void> {
    const lastOffset = this.sessionOffsets.get(sessionId) ?? 0;

    let fileSize: number;
    try {
      const s = await stat(jsonlPath);
      fileSize = s.size;
    } catch {
      return;
    }

    if (fileSize <= lastOffset) return;

    const raw = await readFile(jsonlPath, "utf-8");
    const newContent = raw.slice(lastOffset);
    this.sessionOffsets.set(sessionId, raw.length);

    const files = this.sessionFiles.get(sessionId) ?? new Set<string>();
    let changed = false;

    for (const line of newContent.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalLine;
        if (entry.type !== "assistant") continue;
        const blocks = entry.message?.content;
        if (!Array.isArray(blocks)) continue;

        for (const block of blocks) {
          if (
            block.type === "tool_use" &&
            block.name &&
            WRITE_TOOLS.has(block.name) &&
            block.input?.file_path
          ) {
            if (!files.has(block.input.file_path)) {
              files.add(block.input.file_path);
              changed = true;
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    if (changed) {
      this.sessionFiles.set(sessionId, files);
      await this.writeTouchedFile(sessionId, project, files);
    }
  }

  async getConflicts(project: string): Promise<{ file: string; sessionIds: string[] }[]> {
    const allTouched = await this.readAllTouched();
    const projectSessions = allTouched.filter((t) => t.project === project);

    if (projectSessions.length < 2) return [];

    const fileToSessions = new Map<string, string[]>();
    for (const session of projectSessions) {
      for (const file of session.files) {
        const list = fileToSessions.get(file) ?? [];
        list.push(session.sessionId);
        fileToSessions.set(file, list);
      }
    }

    const conflicts: { file: string; sessionIds: string[] }[] = [];
    for (const [file, sessionIds] of fileToSessions) {
      if (sessionIds.length >= 2) {
        conflicts.push({ file, sessionIds });
      }
    }

    return conflicts;
  }

  async resolveConflicts(
    sessionId: string,
    files: string[],
  ): Promise<string[]> {
    const current = this.sessionFiles.get(sessionId);
    const resolved: string[] = [];

    if (current) {
      for (const file of files) {
        if (current.delete(file)) resolved.push(file);
      }
    }

    const touchedPath = join(this.touchedDir, `${sessionId}.json`);
    try {
      const raw = await readFile(touchedPath, "utf-8");
      const data = JSON.parse(raw) as TouchedSession;
      data.files = data.files.filter((f) => !files.includes(f));
      if (data.files.length === 0) {
        await unlink(touchedPath).catch(() => {});
      } else {
        await writeFile(touchedPath, JSON.stringify(data, null, 2), "utf-8");
      }
    } catch {
      // file doesn't exist
    }

    const reportedPath = join(
      this.touchedDir,
      "..",
      "reported-conflicts.json",
    );
    try {
      const raw = await readFile(reportedPath, "utf-8");
      const reported = JSON.parse(raw) as string[];
      const updated = reported.filter((f) => !files.includes(f));
      await writeFile(reportedPath, JSON.stringify(updated), "utf-8");
    } catch {
      // no reported file
    }

    return resolved;
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessionFiles.delete(sessionId);
    this.sessionOffsets.delete(sessionId);
    const touchedPath = join(this.touchedDir, `${sessionId}.json`);
    await unlink(touchedPath).catch(() => {});
  }

  private async writeTouchedFile(
    sessionId: string,
    project: string,
    files: Set<string>,
  ): Promise<void> {
    await mkdir(this.touchedDir, { recursive: true });
    const data: TouchedSession = {
      sessionId,
      project,
      files: [...files],
      updatedAt: new Date().toISOString(),
    };
    const filePath = join(this.touchedDir, `${sessionId}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  private async readAllTouched(): Promise<TouchedSession[]> {
    const result: TouchedSession[] = [];
    try {
      const files = await readdir(this.touchedDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.touchedDir, file), "utf-8");
          result.push(JSON.parse(raw) as TouchedSession);
        } catch {
          // skip corrupted files
        }
      }
    } catch {
      // directory doesn't exist yet
    }
    return result;
  }
}
