/**
 * Viewer Service - Real-time web viewer for Claude Code transcripts
 * Uses Server-Sent Events (SSE) for live updates
 */

import { Request, Response } from 'express';
import { watch } from 'fs';
import { Queue } from '../utils/queue.js';
import {
  discoverProjects,
  getSession,
  getProjectsDir,
  type Project,
  type Session,
} from './transcript-parser.js';

interface SSEClient {
  id: string;
  queue: Queue<SSEEvent>;
  res: Response;
}

interface SSEEvent {
  type: string;
  data: any;
}

/**
 * ViewerService manages SSE connections and file watching for real-time transcript updates
 */
export class ViewerService {
  private clients: Map<string, SSEClient> = new Map();
  private watcher: any = null;
  private nextClientId = 1;

  constructor() {
    this.startFileWatcher();
  }

  /**
   * Start watching ~/.claude/projects for changes
   */
  private startFileWatcher(): void {
    const projectsDir = getProjectsDir();

    try {
      this.watcher = watch(projectsDir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          // Broadcast file change event to all connected clients
          this.broadcast('file_change', {
            eventType,
            filename,
            timestamp: Date.now(),
          });
        }
      });

      console.log(`[Viewer] Watching ${projectsDir} for changes`);
    } catch (error) {
      console.error('[Viewer] Failed to start file watcher:', error);
    }
  }

  /**
   * Broadcast an event to all connected SSE clients
   */
  private broadcast(type: string, data: any): void {
    const event: SSEEvent = { type, data };

    for (const [clientId, client] of this.clients.entries()) {
      try {
        client.queue.enqueue(event);
        this.sendQueuedEvents(client);
      } catch (error) {
        console.error(`[Viewer] Error broadcasting to client ${clientId}:`, error);
        this.clients.delete(clientId);
      }
    }
  }

  /**
   * Send queued events to a specific client
   */
  private sendQueuedEvents(client: SSEClient): void {
    while (!client.queue.isEmpty()) {
      const event = client.queue.dequeue();
      if (event) {
        const data = JSON.stringify(event);
        client.res.write(`data: ${data}\n\n`);
      }
    }
  }

  /**
   * GET /viewer - Serve the main HTML page
   */
  handleViewerPage(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html');
    res.send(this.getViewerHTML());
  }

  /**
   * GET /viewer/api/events - SSE endpoint for real-time updates
   */
  handleSSE(req: Request, res: Response): void {
    const clientId = `client-${this.nextClientId++}`;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Create client
    const client: SSEClient = {
      id: clientId,
      queue: new Queue<SSEEvent>(),
      res,
    };

    this.clients.set(clientId, client);

    // Send initial connection event
    const connectEvent = JSON.stringify({ type: 'connected', data: { clientId } });
    res.write(`data: ${connectEvent}\n\n`);

    // Send heartbeat every 30 seconds
    const heartbeatInterval = setInterval(() => {
      if (this.clients.has(clientId)) {
        const heartbeat = JSON.stringify({ type: 'heartbeat', data: { timestamp: Date.now() } });
        res.write(`data: ${heartbeat}\n\n`);
      }
    }, 30000);

    // Clean up on disconnect
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      this.clients.delete(clientId);
      console.log(`[Viewer] Client ${clientId} disconnected`);
    });

    console.log(`[Viewer] Client ${clientId} connected`);
  }

  /**
   * GET /viewer/api/projects - Get all projects and sessions
   */
  handleGetProjects(_req: Request, res: Response): void {
    try {
      const projects = discoverProjects();
      res.json({ projects });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /viewer/api/sessions/:projectName/:sessionId - Get a specific session
   */
  handleGetSession(req: Request, res: Response): void {
    try {
      const { projectName, sessionId } = req.params;
      const session = getSession(projectName, sessionId);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json({ session });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.watcher) {
      this.watcher.close();
    }

    // Close all SSE connections
    for (const [clientId, client] of this.clients.entries()) {
      client.res.end();
      this.clients.delete(clientId);
    }
  }

  /**
   * Generate the viewer HTML page
   */
  private getViewerHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Code Transcript Viewer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: 300px;
      background: #161b22;
      border-right: 1px solid #30363d;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 20px;
      background: #0d1117;
      border-bottom: 1px solid #30363d;
    }

    .sidebar-header h1 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .connection-status {
      font-size: 12px;
      color: #8b949e;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6e7681;
    }

    .status-dot.connected {
      background: #238636;
    }

    .sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }

    .project {
      margin-bottom: 16px;
    }

    .project-name {
      font-size: 13px;
      font-weight: 600;
      color: #58a6ff;
      padding: 6px 8px;
      cursor: pointer;
      border-radius: 6px;
      transition: background 0.2s;
    }

    .project-name:hover {
      background: #1c2128;
    }

    .project-name.expanded {
      background: #1c2128;
    }

    .sessions {
      margin-left: 12px;
      margin-top: 4px;
      display: none;
    }

    .sessions.visible {
      display: block;
    }

    .session-item {
      font-size: 12px;
      padding: 6px 8px;
      cursor: pointer;
      border-radius: 4px;
      margin-bottom: 2px;
      transition: background 0.2s;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .session-item:hover {
      background: #1c2128;
    }

    .session-item.active {
      background: #1f6feb;
      color: #fff;
    }

    .session-time {
      font-size: 10px;
      color: #8b949e;
    }

    /* Main content */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .viewer-header {
      padding: 20px;
      background: #0d1117;
      border-bottom: 1px solid #30363d;
    }

    .viewer-header h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .viewer-header .session-info {
      font-size: 12px;
      color: #8b949e;
    }

    .transcript {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }

    .message {
      margin-bottom: 20px;
      padding: 16px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
    }

    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #30363d;
    }

    .message-type {
      font-size: 12px;
      font-weight: 600;
      color: #58a6ff;
      text-transform: uppercase;
    }

    .message-time {
      font-size: 11px;
      color: #8b949e;
    }

    .message-content {
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .message-content pre {
      background: #0d1117;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }

    .sub-agent-badge {
      display: inline-block;
      font-size: 10px;
      padding: 2px 8px;
      background: #1f6feb;
      color: #fff;
      border-radius: 12px;
      margin-left: 8px;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #8b949e;
    }

    .empty-state h3 {
      font-size: 16px;
      margin-bottom: 8px;
    }

    .empty-state p {
      font-size: 13px;
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: #0d1117;
    }

    ::-webkit-scrollbar-thumb {
      background: #30363d;
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #484f58;
    }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-header">
      <h1>Claude Code Transcripts</h1>
      <div class="connection-status">
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
      </div>
    </div>
    <div class="sidebar-content" id="projectList">
      <!-- Projects will be loaded here -->
    </div>
  </div>

  <!-- Main content -->
  <div class="main-content">
    <div class="viewer-header">
      <h2 id="sessionTitle">Select a session to view</h2>
      <div class="session-info" id="sessionInfo"></div>
    </div>
    <div class="transcript" id="transcript">
      <div class="empty-state">
        <h3>No session selected</h3>
        <p>Choose a project and session from the sidebar to view its transcript.</p>
      </div>
    </div>
  </div>

  <script>
    // SSE connection
    let eventSource = null;
    let currentSession = null;

    // Connect to SSE
    function connectSSE() {
      eventSource = new EventSource('/viewer/api/events');

      eventSource.onopen = () => {
        updateConnectionStatus(true);
      };

      eventSource.onerror = () => {
        updateConnectionStatus(false);
        // Reconnect after 5 seconds
        setTimeout(connectSSE, 5000);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleSSEEvent(data);
        } catch (e) {
          console.error('Error parsing SSE event:', e);
        }
      };
    }

    // Handle SSE events
    function handleSSEEvent(event) {
      switch (event.type) {
        case 'connected':
          console.log('SSE connected:', event.data);
          break;
        case 'heartbeat':
          // Keep connection alive
          break;
        case 'file_change':
          console.log('File changed:', event.data);
          // Reload current session if it was modified
          if (currentSession) {
            loadSession(currentSession.projectName, currentSession.sessionId);
          }
          // Reload project list
          loadProjects();
          break;
      }
    }

    // Update connection status UI
    function updateConnectionStatus(connected) {
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');

      if (connected) {
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
      } else {
        statusDot.classList.remove('connected');
        statusText.textContent = 'Disconnected';
      }
    }

    // Load projects
    async function loadProjects() {
      try {
        const response = await fetch('/viewer/api/projects');
        const { projects } = await response.json();
        renderProjects(projects);
      } catch (error) {
        console.error('Error loading projects:', error);
      }
    }

    // Render projects in sidebar
    function renderProjects(projects) {
      const projectList = document.getElementById('projectList');
      projectList.innerHTML = '';

      for (const project of projects) {
        const projectDiv = document.createElement('div');
        projectDiv.className = 'project';

        const projectName = document.createElement('div');
        projectName.className = 'project-name';
        projectName.textContent = project.name;
        projectName.onclick = () => toggleProject(projectName, sessionsDiv);

        const sessionsDiv = document.createElement('div');
        sessionsDiv.className = 'sessions';

        for (const session of project.sessions) {
          const sessionItem = document.createElement('div');
          sessionItem.className = 'session-item';

          const sessionName = document.createElement('span');
          sessionName.textContent = session.sessionId.substring(0, 20) + '...';

          const sessionTime = document.createElement('span');
          sessionTime.className = 'session-time';
          sessionTime.textContent = formatTime(session.lastModified);

          sessionItem.appendChild(sessionName);
          sessionItem.appendChild(sessionTime);
          sessionItem.onclick = () => {
            // Remove active class from all sessions
            document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
            sessionItem.classList.add('active');
            loadSession(project.name, session.sessionId);
          };

          sessionsDiv.appendChild(sessionItem);
        }

        projectDiv.appendChild(projectName);
        projectDiv.appendChild(sessionsDiv);
        projectList.appendChild(projectDiv);
      }
    }

    // Toggle project expansion
    function toggleProject(projectName, sessionsDiv) {
      projectName.classList.toggle('expanded');
      sessionsDiv.classList.toggle('visible');
    }

    // Load a specific session
    async function loadSession(projectName, sessionId) {
      try {
        const response = await fetch(\`/viewer/api/sessions/\${projectName}/\${sessionId}\`);
        const { session } = await response.json();

        currentSession = { projectName, sessionId };

        // Update header
        document.getElementById('sessionTitle').textContent = sessionId;
        document.getElementById('sessionInfo').textContent = \`Project: \${projectName} • Messages: \${session.messages.length} • Sub-agents: \${session.subAgents.length}\`;

        // Render transcript
        renderTranscript(session);
      } catch (error) {
        console.error('Error loading session:', error);
      }
    }

    // Render transcript messages
    function renderTranscript(session) {
      const transcript = document.getElementById('transcript');
      transcript.innerHTML = '';

      if (session.messages.length === 0) {
        transcript.innerHTML = \`
          <div class="empty-state">
            <h3>No messages</h3>
            <p>This session has no recorded messages.</p>
          </div>
        \`;
        return;
      }

      for (const message of session.messages) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';

        const header = document.createElement('div');
        header.className = 'message-header';

        const type = document.createElement('div');
        type.className = 'message-type';
        type.textContent = message.type || 'unknown';

        const time = document.createElement('div');
        time.className = 'message-time';
        time.textContent = formatTimestamp(message.timestamp);

        header.appendChild(type);
        header.appendChild(time);

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = formatMessageContent(message);

        messageDiv.appendChild(header);
        messageDiv.appendChild(content);
        transcript.appendChild(messageDiv);
      }

      // Add sub-agent section if present
      if (session.subAgents.length > 0) {
        const subAgentHeader = document.createElement('h3');
        subAgentHeader.textContent = 'Sub-Agents';
        subAgentHeader.style.marginTop = '32px';
        subAgentHeader.style.marginBottom = '16px';
        transcript.appendChild(subAgentHeader);

        for (const agent of session.subAgents) {
          const agentDiv = document.createElement('div');
          agentDiv.className = 'message';

          const header = document.createElement('div');
          header.className = 'message-header';

          const type = document.createElement('div');
          type.className = 'message-type';
          type.innerHTML = \`Sub-Agent <span class="sub-agent-badge">\${agent.id.substring(0, 8)}</span>\`;

          const msgCount = document.createElement('div');
          msgCount.className = 'message-time';
          msgCount.textContent = \`\${agent.messages.length} messages\`;

          header.appendChild(type);
          header.appendChild(msgCount);

          const content = document.createElement('div');
          content.className = 'message-content';
          content.textContent = \`Agent ID: \${agent.id}\\nMessages: \${agent.messages.length}\\nPath: \${agent.path}\`;

          agentDiv.appendChild(header);
          agentDiv.appendChild(content);
          transcript.appendChild(agentDiv);
        }
      }
    }

    // Format message content for display
    function formatMessageContent(message) {
      if (typeof message === 'string') return message;
      if (message.content) return JSON.stringify(message.content, null, 2);
      if (message.text) return message.text;
      return JSON.stringify(message, null, 2);
    }

    // Format timestamp
    function formatTimestamp(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return date.toLocaleString();
    }

    // Format time ago
    function formatTime(timestamp) {
      const now = Date.now();
      const diff = now - timestamp;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);

      if (minutes < 1) return 'just now';
      if (minutes < 60) return \`\${minutes}m ago\`;
      if (hours < 24) return \`\${hours}h ago\`;
      return \`\${days}d ago\`;
    }

    // Initialize
    connectSSE();
    loadProjects();
  </script>
</body>
</html>`;
  }
}
