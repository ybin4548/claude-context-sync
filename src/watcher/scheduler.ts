import type { SyncConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

export type Strategy = "full" | "incremental" | "cached";

export interface SessionState {
  isStale: boolean;
  incrementalCount: number;
  lastMessageCount: number;
  lastSummarizedAt: string | null;
}

export class Scheduler {
  private readonly states = new Map<string, SessionState>();
  private readonly triggerCount: number;
  private readonly fullAfter: number;

  constructor(config: SyncConfig = DEFAULT_CONFIG) {
    this.triggerCount = config.triggerMessageCount;
    this.fullAfter = config.fullResummarizeAfter;
  }

  markStale(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.isStale = true;
  }

  getStrategy(sessionId: string, currentMessageCount: number): Strategy {
    const state = this.getOrCreate(sessionId);

    if (!state.isStale) return "cached";

    const newMessages = currentMessageCount - state.lastMessageCount;
    if (newMessages < this.triggerCount) return "cached";

    if (state.incrementalCount >= this.fullAfter) return "full";

    return "incremental";
  }

  recordSummarized(
    sessionId: string,
    strategy: "full" | "incremental",
    messageCount: number,
  ): void {
    const state = this.getOrCreate(sessionId);
    state.isStale = false;
    state.lastMessageCount = messageCount;
    state.lastSummarizedAt = new Date().toISOString();

    if (strategy === "full") {
      state.incrementalCount = 0;
    } else {
      state.incrementalCount += 1;
    }
  }

  seedState(
    sessionId: string,
    messageCount: number,
    incrementalCount: number,
  ): void {
    const state = this.getOrCreate(sessionId);
    state.lastMessageCount = messageCount;
    state.incrementalCount = incrementalCount;
    state.lastSummarizedAt = new Date().toISOString();
  }

  getState(sessionId: string): SessionState | undefined {
    return this.states.get(sessionId);
  }

  private getOrCreate(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        isStale: false,
        incrementalCount: 0,
        lastMessageCount: 0,
        lastSummarizedAt: null,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }
}
