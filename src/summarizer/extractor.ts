import { readFile } from "node:fs/promises";
import type {
  SessionMessage,
  JournalEntry,
  ContentBlock,
} from "../types.js";

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

function parseEntry(line: string): JournalEntry | null {
  try {
    return JSON.parse(line) as JournalEntry;
  } catch {
    return null;
  }
}

function toSessionMessage(entry: JournalEntry): SessionMessage | null {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (!entry.message?.content) return null;
  if (entry.isSidechain) return null;

  const text = extractTextContent(entry.message.content);
  if (!text.trim()) return null;

  return {
    type: entry.type as "user" | "assistant",
    content: text,
    timestamp: entry.timestamp ?? "",
    uuid: entry.uuid ?? "",
    parentUuid: entry.parentUuid ?? null,
  };
}

export async function extractMessages(
  jsonlPath: string,
): Promise<SessionMessage[]> {
  const raw = await readFile(jsonlPath, "utf-8");
  const messages: SessionMessage[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    const msg = toSessionMessage(entry);
    if (msg) messages.push(msg);
  }

  return messages;
}

export async function extractRecentMessages(
  jsonlPath: string,
  count: number,
): Promise<SessionMessage[]> {
  const all = await extractMessages(jsonlPath);
  return all.slice(-count);
}

export async function countNewMessages(
  jsonlPath: string,
  since: string,
): Promise<number> {
  const all = await extractMessages(jsonlPath);
  const sinceTime = new Date(since).getTime();
  return all.filter((m) => new Date(m.timestamp).getTime() > sinceTime).length;
}
