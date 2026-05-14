export interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "busy" | "idle";
  startedAt: number;
  version: string;
}

export interface SessionMessage {
  type: "user" | "assistant" | "system" | "attachment";
  role?: string;
  content: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  updatedAt: string;
  incrementalCount: number;
  summary: {
    task: string;
    changedFiles: string[];
    decisions: string[];
    currentState: string;
    blockers: string[];
    impactOnOtherSessions: string[];
  };
  raw: string;
}

export interface SyncConfig {
  claudeDir: string;
  syncDir: string;
  triggerMessageCount: number;
  fullResummarizeAfter: number;
}

export const DEFAULT_CONFIG: SyncConfig = {
  claudeDir: "~/.claude",
  syncDir: "~/.claude/context-sync",
  triggerMessageCount: 10,
  fullResummarizeAfter: 4,
};
