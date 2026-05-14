# claude-context-sync

[![npm](https://img.shields.io/npm/v/claude-context-sync)](https://www.npmjs.com/package/claude-context-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server that automatically summarizes and shares context across parallel Claude Code sessions.

When you run multiple Claude Code sessions on different tasks, each session is unaware of what the others are doing. **claude-context-sync** watches your session logs, generates structured summaries on demand, and exposes them as MCP tools — so any session can instantly see what's happening elsewhere.

## How It Works

```
[Always running] Watcher: detects .jsonl changes → sets stale flag (zero cost)
                    ↓
[On tool call]   MCP Tool invoked → summarizes only stale sessions
                    ↓
                 Extractor: extracts user/assistant messages
                    ↓
                 Generator: runs claude -p for structured summary (hybrid strategy)
                    ↓
                 Store: caches summary locally
                    ↓
                 MCP Server: returns result
```

**Key principle**: If no MCP tool is called, `claude -p` is never invoked → zero token cost.

## Installation

```bash
npm install -g claude-context-sync
context-sync init
```

That's it. The next time you open Claude Code, the MCP server starts automatically.

## MCP Tools

### `list_sessions`

Returns active Claude Code sessions with their current status and task summary.

### `get_session_context`

Returns the full structured summary for a specific session. Automatically re-summarizes if the session data is stale.

**Parameters**: `sessionId` (string)

### `get_all_changes`

Returns changed files and decisions across all sessions, with optional project filtering.

**Parameters**: `project` (string, optional)

## Architecture

Single MCP server process — no separate daemon. Claude Code launches it automatically via stdio transport.

```
src/
├── mcp/server.ts        # MCP server entry point + 3 tools
├── watcher/
│   ├── watcher.ts       # File watching (chokidar)
│   └── scheduler.ts     # Hybrid strategy (incremental vs full)
├── summarizer/
│   ├── extractor.ts     # .jsonl parsing
│   └── generator.ts     # claude -p invocation
├── store/store.ts       # Local summary cache
├── cli.ts               # CLI (init + serve)
└── types.ts             # Shared types
```

### Summarization Strategy

- **Incremental**: updates existing summary with new messages (default)
- **Full**: regenerates summary from scratch (after 4 incremental updates)
- **Cached**: returns stored summary if nothing changed (zero cost)

## Requirements

- Node.js 20+
- Claude Code CLI (`claude` command available)

## Development

```bash
git clone https://github.com/ybin4548/claude-context-sync.git
cd claude-context-sync
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
