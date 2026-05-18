import { readFile, writeFile, readdir, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SyncConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { resolveSymbol } from "./symbol-resolver.js";

interface FileSymbol {
  file: string;
  symbols: string[];
}

interface TouchedSession {
  sessionId: string;
  project: string;
  files: FileSymbol[];
  updatedAt: string;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: { file_path?: string; old_string?: string };
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
  private readonly sessionFileSymbols = new Map<string, Map<string, Set<string>>>();
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

    const fileMap = this.sessionFileSymbols.get(sessionId) ?? new Map<string, Set<string>>();
    let changed = false;

    const pendingSymbols: { filePath: string; snippet: string }[] = [];

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
            const filePath = block.input.file_path;
            if (!fileMap.has(filePath)) {
              fileMap.set(filePath, new Set());
              changed = true;
            }
            if (block.input.old_string) {
              pendingSymbols.push({ filePath, snippet: block.input.old_string });
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    for (const { filePath, snippet } of pendingSymbols) {
      const symbol = await resolveSymbol(filePath, snippet);
      if (symbol) {
        const symbols = fileMap.get(filePath)!;
        if (!symbols.has(symbol)) {
          symbols.add(symbol);
          changed = true;
        }
      }
    }

    if (changed) {
      this.sessionFileSymbols.set(sessionId, fileMap);
      await this.writeTouchedFile(sessionId, project, fileMap);
    }
  }

  async getConflicts(project: string): Promise<{
    file: string;
    sessionIds: string[];
    symbols: string[];
  }[]> {
    const allTouched = await this.readAllTouched();
    const projectSessions = allTouched.filter((t) => t.project === project);

    if (projectSessions.length < 2) return [];

    const fileToSessions = new Map<string, { sessionId: string; symbols: string[] }[]>();
    for (const session of projectSessions) {
      for (const entry of session.files) {
        const list = fileToSessions.get(entry.file) ?? [];
        list.push({ sessionId: session.sessionId, symbols: entry.symbols });
        fileToSessions.set(entry.file, list);
      }
    }

    const conflicts: { file: string; sessionIds: string[]; symbols: string[] }[] = [];
    for (const [file, sessions] of fileToSessions) {
      if (sessions.length < 2) continue;

      const allSymbols = sessions.flatMap((s) => s.symbols);
      const symbolCounts = new Map<string, number>();
      for (const sym of allSymbols) {
        symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1);
      }
      const sharedSymbols = [...symbolCounts.entries()]
        .filter(([, count]) => count >= 2)
        .map(([sym]) => sym);

      conflicts.push({
        file,
        sessionIds: sessions.map((s) => s.sessionId),
        symbols: sharedSymbols,
      });
    }

    return conflicts;
  }

  async resolveConflicts(
    sessionId: string,
    files: string[],
  ): Promise<string[]> {
    const current = this.sessionFileSymbols.get(sessionId);
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
      data.files = data.files.filter((f) => !files.includes(f.file));
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
    this.sessionFileSymbols.delete(sessionId);
    this.sessionOffsets.delete(sessionId);
    const touchedPath = join(this.touchedDir, `${sessionId}.json`);
    await unlink(touchedPath).catch(() => {});
  }

  async cleanup(activeSessionIds: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    try {
      const files = await readdir(this.touchedDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const sessionId = file.replace(".json", "");
        if (!activeSessionIds.has(sessionId)) {
          await this.clearSession(sessionId);
          removed.push(sessionId);
        }
      }
    } catch {
      // directory doesn't exist
    }
    return removed;
  }

  private async writeTouchedFile(
    sessionId: string,
    project: string,
    fileMap: Map<string, Set<string>>,
  ): Promise<void> {
    await mkdir(this.touchedDir, { recursive: true });
    const data: TouchedSession = {
      sessionId,
      project,
      files: [...fileMap.entries()].map(([file, symbols]) => ({
        file,
        symbols: [...symbols],
      })),
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
