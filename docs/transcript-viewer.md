# Claude Code Transcript Viewer

A standalone web-based viewer for Claude Code transcripts with real-time updates and sub-agent support.

## Features

- 📁 **Project Browser** - Navigate all your Claude Code projects
- 📝 **Session Viewer** - View full conversation transcripts
- 🤖 **Sub-Agent Support** - See sub-agent transcripts linked to main sessions
- ⚡ **Real-Time Updates** - Live updates via Server-Sent Events (SSE)
- 🎨 **Dark Mode UI** - GitHub-inspired dark theme
- 🔍 **Message Inspection** - View all message types in detail

## Quick Start

```bash
# Start the viewer
npm run viewer

# Open in your browser
# http://localhost:3737
```

## How It Works

The transcript viewer:

1. **Discovers Projects** - Scans `~/.claude/projects/` for all JSONL transcripts
2. **Parses Transcripts** - Reads main session files and sub-agent files
3. **Links Sub-Agents** - Automatically associates `agent-*.jsonl` files with sessions
4. **Watches for Changes** - Uses Node's `fs.watch()` to detect new messages
5. **Streams Updates** - Pushes changes to browser clients via SSE

## Architecture

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  File Watcher    │───▶│  Express Server  │───▶│  Browser Client  │
│  (fs.watch)      │    │  (SSE + REST)    │    │  (HTML + JS)     │
└──────────────────┘    └──────────────────┘    └──────────────────┘
        │                        │                        │
        │                        │                        │
        ▼                        ▼                        ▼
  ~/.claude/projects/    Port 3737 (configurable)   Real-time UI
```

### Components

**Backend (`src/services/transcript-parser.ts`)**
- Parses JSONL transcript files
- Discovers sub-agent files (`agent-*.jsonl`)
- Provides project/session data structures

**Service (`src/services/viewer-service.ts`)**
- Express route handlers
- SSE connection management
- File watching and change broadcasting
- Inline HTML generation

**Entry Point (`src/bin/viewer.ts`)**
- Standalone server executable
- Configurable port via `CLAUDE_VIEWER_PORT` env var
- Graceful shutdown handling

## API Endpoints

### `GET /`
Returns the HTML viewer page

### `GET /api/events`
Server-Sent Events stream for real-time updates

**Events:**
- `connected` - Initial connection confirmation
- `heartbeat` - Keep-alive (every 30s)
- `file_change` - Transcript file was modified

### `GET /api/projects`
List all projects and sessions

**Response:**
```json
{
  "projects": [
    {
      "path": "/root/.claude/projects/my-project",
      "name": "my-project",
      "sessions": [...]
    }
  ]
}
```

### `GET /api/sessions/:projectName/:sessionId`
Get full session details including messages and sub-agents

**Response:**
```json
{
  "session": {
    "projectPath": "...",
    "sessionId": "uuid",
    "messages": [...],
    "subAgents": [
      {
        "id": "agent-id",
        "path": "/path/to/agent-xyz.jsonl",
        "messages": [...]
      }
    ]
  }
}
```

## File Structure

```
src/
├── bin/
│   └── viewer.ts              # Standalone server entry point
├── services/
│   ├── transcript-parser.ts   # JSONL parsing & project discovery
│   └── viewer-service.ts      # Express routes & SSE handling
└── utils/
    └── queue.ts               # SSE event queue

~/.claude/projects/            # Claude Code transcripts
├── project-name/
│   ├── session-uuid.jsonl     # Main conversation
│   ├── agent-abc123.jsonl     # Sub-agent transcript
│   └── agent-def456.jsonl     # Another sub-agent
```

## Configuration

### Change Port

```bash
# Use custom port
CLAUDE_VIEWER_PORT=8080 npm run viewer
```

### Environment Variables

- `CLAUDE_VIEWER_PORT` - HTTP port (default: 3737)

## Sub-Agent Support

The viewer automatically detects and displays sub-agent transcripts:

1. **Discovery** - Scans for files matching `agent-*.jsonl` pattern
2. **Association** - Links sub-agents to parent sessions based on project directory
3. **Display** - Shows sub-agent metadata and message counts in a dedicated section

### Sub-Agent File Format

Sub-agent files follow the pattern: `agent-{agentId}.jsonl`

Each line is a JSON message similar to main transcripts:
```json
{"type":"assistant","message":{"role":"assistant","content":[...]},"timestamp":"..."}
```

## Development

### Running from Source

```bash
# Install dependencies
npm install

# Start viewer
npm run viewer
```

### Adding Features

The viewer uses vanilla HTML/CSS/JavaScript for simplicity. To add features:

1. Modify `ViewerService.getViewerHTML()` in `src/services/viewer-service.ts`
2. Add new API endpoints in `ViewerService` class
3. Update the embedded JavaScript in the HTML template

### File Watching

The viewer uses Node's built-in `fs.watch()` with `recursive: true` for maximum compatibility. It watches the entire `~/.claude/projects/` directory tree for changes.

## Troubleshooting

### Viewer won't start

**Error:** `EADDRINUSE: address already in use`

**Solution:** Another process is using port 3737. Either:
- Stop the other process
- Use a different port: `CLAUDE_VIEWER_PORT=8080 npm run viewer`

### No projects showing

**Check:** Does `~/.claude/projects/` exist and contain JSONL files?

```bash
ls -la ~/.claude/projects/
```

### SSE connection failing

**Check browser console** for connection errors. SSE requires:
- No proxy blocking EventSource
- Browser supports EventSource API (all modern browsers)

### Sub-agents not appearing

**Verify files exist:**
```bash
ls ~/.claude/projects/your-project/agent-*.jsonl
```

Files must match the pattern `agent-{agentId}.jsonl` exactly.

## Comparison to Other Tools

### vs simonw/claude-code-transcripts
- ✅ Real-time viewing (theirs is static HTML generation)
- ✅ Built-in web server (theirs requires separate server)
- ✅ Sub-agent support (theirs doesn't have it)
- ❌ No GitHub Gist publishing
- ❌ No pagination (loads all messages)

### vs daaain/claude-code-log
- ✅ Web UI (theirs is TUI)
- ✅ Real-time updates (theirs is static)
- ❌ No advanced filtering/date ranges
- ❌ No token usage tracking
- ❌ No caching system

## Future Enhancements

Potential features to add:

- [ ] Advanced search across all transcripts
- [ ] Sub-agent timeline visualization
- [ ] Export to HTML/Markdown
- [ ] Message filtering by type
- [ ] Dark/light theme toggle
- [ ] Token usage statistics
- [ ] Session comparison view
- [ ] Sub-agent performance analytics

## License

AGPL-3.0 (same as claude-mem)
