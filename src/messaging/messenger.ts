import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SyncConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

export interface Message {
  id: string;
  from: string;
  to: string;
  project: string;
  message: string;
  timestamp: string;
  read: boolean;
}

function resolveSyncDir(config: SyncConfig): string {
  const dir = config.syncDir;
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? dir.replace("~/", `${homedir()}/`) : dir;
}

export class Messenger {
  private readonly messagesDir: string;

  constructor(config: SyncConfig = DEFAULT_CONFIG) {
    this.messagesDir = join(resolveSyncDir(config), "messages");
  }

  async send(
    from: string,
    to: string,
    project: string,
    message: string,
  ): Promise<Message> {
    const sessionDir = join(this.messagesDir, to);
    await mkdir(sessionDir, { recursive: true });

    const msg: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from,
      to,
      project,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    };

    await writeFile(
      join(sessionDir, `${msg.id}.json`),
      JSON.stringify(msg, null, 2),
      "utf-8",
    );

    return msg;
  }

  async broadcast(
    from: string,
    project: string,
    message: string,
    allSessionIds: string[],
  ): Promise<number> {
    const targets = allSessionIds.filter((id) => id !== from);
    await Promise.all(
      targets.map((to) => this.send(from, to, project, message)),
    );
    return targets.length;
  }

  async getUnread(sessionId: string): Promise<Message[]> {
    const messages = await this.readSessionMessages(sessionId);
    return messages.filter((m) => !m.read);
  }

  async markAsRead(sessionId: string): Promise<number> {
    const sessionDir = join(this.messagesDir, sessionId);
    const messages = await this.readSessionMessages(sessionId);
    let count = 0;

    for (const msg of messages) {
      if (!msg.read) {
        msg.read = true;
        await writeFile(
          join(sessionDir, `${msg.id}.json`),
          JSON.stringify(msg, null, 2),
          "utf-8",
        );
        count++;
      }
    }

    return count;
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    return this.readSessionMessages(sessionId);
  }

  private async readSessionMessages(sessionId: string): Promise<Message[]> {
    const sessionDir = join(this.messagesDir, sessionId);
    const messages: Message[] = [];

    try {
      const files = await readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(sessionDir, file), "utf-8");
          messages.push(JSON.parse(raw) as Message);
        } catch {
          // skip corrupted
        }
      }
    } catch {
      // directory doesn't exist
    }

    return messages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }
}
