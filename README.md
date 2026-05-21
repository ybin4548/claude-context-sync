# claude-context-sync

[![npm](https://img.shields.io/npm/v/claude-context-sync)](https://www.npmjs.com/package/claude-context-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server that automatically summarizes and shares context across parallel Claude Code sessions.

When you run multiple Claude Code sessions on different tasks, each session is unaware of what the others are doing. **claude-context-sync** watches your session logs, generates structured summaries on demand, and provides real-time file conflict detection and cross-session messaging.

## Features

- **Session context sharing** — any session can see what others are working on
- **File conflict detection** — real-time alerts when multiple sessions edit the same file
- **Symbol-level conflicts** — detects shared function/class/interface edits (TypeScript, Python, Swift, Go, Rust)
- **Cross-session messaging** — send messages between sessions without switching terminals
- **Lazy evaluation** — zero cost when tools aren't called
- **Auto-cleanup** — tracked data is removed when sessions end

## Installation

```bash
npm install -g claude-context-sync
context-sync init
```

That's it. The next time you open Claude Code, the MCP server starts automatically. The `init` command also registers a conflict detection hook.

## MCP Tools

### `list_sessions`

Returns active Claude Code sessions with their current status, task summary, and any file conflicts.

### `get_session_context`

Returns the full structured summary for a specific session. Automatically re-summarizes if stale. Includes conflict information.

**Parameters**: `sessionId` (string)

### `get_all_changes`

Returns changed files and decisions across all sessions, with optional project filtering.

**Parameters**: `project` (string, optional)

### `send_message`

Sends a message to another session. Omit `targetSessionId` to broadcast to all sessions in the same project.

**Parameters**: `fromSessionId` (string), `message` (string), `project` (string), `targetSessionId` (string, optional)

### `get_messages`

Returns message history for a session.

**Parameters**: `sessionId` (string), `unreadOnly` (boolean, optional)

### `resolve_conflicts`

Clears resolved files from the conflict tracking list.

**Parameters**: `sessionId` (string), `files` (string[])

## How It Works

### Context Sharing

```
[Always running] Watcher: detects .jsonl changes → sets stale flag (zero cost)
                    ↓
[On tool call]   MCP Tool invoked → summarizes only stale sessions
                    ↓
                 Extractor → Generator (claude -p) → Store → Response
```

### Conflict Detection

```
[Always running] Watcher: detects .jsonl changes
                    ↓
                 FileTracker: parses Write/Edit tool_use events
                    ↓
                 SymbolResolver: identifies enclosing function/class/type
                    ↓
                 Writes per-session touched files

[Every message]  Hook (UserPromptSubmit): checks for new conflicts
                    ↓
                 Alerts Claude once per new conflict → Claude notifies user
```

### Messaging

```
Session A: send_message → writes to ~/.claude/context-sync/messages/{targetId}/
                    ↓
Session B: Hook detects unread message → injects into AI context
                    ↓
           Claude reads and relays to user → marks as read
```

## Architecture

Single MCP server process — no separate daemon. Claude Code launches it automatically via stdio transport.

```
src/
├── mcp/server.ts              # MCP server + 6 tools
├── watcher/
│   ├── watcher.ts             # File watching (chokidar)
│   ├── scheduler.ts           # Hybrid summarization strategy
│   ├── file-tracker.ts        # Real-time file edit tracking
│   └── symbol-resolver.ts     # Pattern-based symbol detection
├── summarizer/
│   ├── extractor.ts           # .jsonl parsing + stratified sampling
│   └── generator.ts           # claude -p invocation
├── messaging/
│   └── messenger.ts           # Cross-session message passing
├── store/store.ts             # Local summary cache
├── cli.ts                     # CLI (init + serve + hook registration)
└── types.ts                   # Shared types
```

### Summarization Strategy

- **Incremental**: updates existing summary with new messages (default)
- **Full**: regenerates from scratch (after 4 incremental updates)
- **Stratified sampling**: for large sessions (500+ messages), samples head + middle + tail
- **Cached**: returns stored summary if nothing changed (zero cost)

### Supported Languages (Symbol Detection)

| Language | Detected Symbols |
|----------|-----------------|
| TypeScript/JavaScript | function, class, interface, type, enum, const |
| Python | def, class |
| Swift | func, class, struct, protocol, enum, extension |
| Go | func, type (struct/interface) |
| Rust | fn, struct, enum, trait, impl |

Unsupported file types fall back to file-level conflict detection.

## Requirements

- Node.js 20+
- Claude Code CLI (`claude` command available)
- `jq` (for conflict detection hook)

## Feedback

We'd love to hear from you! If you have feature requests, bug reports, or just want to share how you use claude-context-sync:

- [GitHub Discussions](https://github.com/ybin4548/claude-context-sync/discussions) — ideas, questions, show & tell
- [GitHub Issues](https://github.com/ybin4548/claude-context-sync/issues) — bug reports, feature requests

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
