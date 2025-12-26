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
  <!-- Marked.js for Markdown rendering -->
  <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
  <!-- Highlight.js for syntax highlighting -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
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
      margin-bottom: 12px;
    }

    .search-container {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 8px 12px;
      margin-top: 12px;
    }

    .search-container:focus-within {
      border-color: #58a6ff;
    }

    .search-input {
      flex: 1;
      background: transparent;
      border: none;
      color: #c9d1d9;
      font-size: 13px;
      outline: none;
    }

    .search-input::placeholder {
      color: #6e7681;
    }

    .search-stats {
      font-size: 11px;
      color: #8b949e;
      white-space: nowrap;
    }

    .search-nav {
      display: flex;
      gap: 4px;
    }

    .search-nav-btn {
      background: transparent;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }

    .search-nav-btn:hover {
      background: #21262d;
    }

    .search-nav-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .clear-search-btn {
      background: transparent;
      border: none;
      color: #8b949e;
      cursor: pointer;
      font-size: 14px;
      padding: 0 4px;
    }

    .clear-search-btn:hover {
      color: #c9d1d9;
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
      border-left: 4px solid #30363d;
      border-radius: 6px;
      position: relative;
    }

    /* Message type color coding */
    .message.type-user { border-left-color: #58a6ff; }      /* Blue */
    .message.type-assistant { border-left-color: #a371f7; } /* Purple */
    .message.type-tool_use { border-left-color: #f0883e; }  /* Orange */
    .message.type-tool_result { border-left-color: #3fb950; } /* Green */
    .message.type-error { border-left-color: #f85149; }     /* Red */
    .message.type-thinking { border-left-color: #79c0ff; }  /* Light Blue */
    .message.type-subagent { border-left-color: #1f6feb; }  /* Blue */

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
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .message-type-icon {
      font-size: 14px;
    }

    .message-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .message-time {
      font-size: 11px;
      color: #8b949e;
    }

    .copy-btn {
      background: #21262d;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      transition: all 0.2s;
    }

    .copy-btn:hover {
      background: #30363d;
      border-color: #484f58;
    }

    .copy-btn.copied {
      background: #238636;
      border-color: #238636;
    }

    .message-content {
      font-size: 13px;
      line-height: 1.6;
      color: #c9d1d9;
    }

    .message-content p {
      margin-bottom: 12px;
    }

    .message-content a {
      color: #58a6ff;
      text-decoration: none;
    }

    .message-content a:hover {
      text-decoration: underline;
    }

    .message-content pre {
      background: #0d1117;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
      position: relative;
    }

    .message-content code {
      background: #0d1117;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 12px;
    }

    .message-content pre code {
      background: transparent;
      padding: 0;
    }

    .code-block-wrapper {
      position: relative;
      margin: 12px 0;
    }

    .code-copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: #21262d;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .code-block-wrapper:hover .code-copy-btn {
      opacity: 1;
    }

    .code-copy-btn:hover {
      background: #30363d;
    }

    .tool-details {
      background: #0d1117;
      padding: 12px;
      border-radius: 4px;
      margin-top: 8px;
      font-size: 12px;
    }

    .tool-name {
      font-weight: 600;
      color: #f0883e;
      margin-bottom: 8px;
    }

    .tool-params {
      color: #8b949e;
    }

    .collapsible-header {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .collapsible-header:hover {
      opacity: 0.8;
    }

    .chevron {
      transition: transform 0.2s;
      font-size: 10px;
    }

    .chevron.collapsed {
      transform: rotate(-90deg);
    }

    .collapsible-content {
      max-height: 2000px;
      overflow: hidden;
      transition: max-height 0.3s ease-out;
    }

    .collapsible-content.collapsed {
      max-height: 0;
    }

    /* Search highlighting */
    .search-highlight {
      background: #ffd33d;
      color: #0d1117;
      padding: 2px 4px;
      border-radius: 2px;
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
      <div class="search-container" id="searchContainer" style="display: none;">
        <span style="color: #8b949e;">🔍</span>
        <input
          type="text"
          class="search-input"
          id="searchInput"
          placeholder="Search messages, tools, file paths..."
          autocomplete="off"
        />
        <button class="clear-search-btn" id="clearSearchBtn" title="Clear search">×</button>
        <div class="search-stats" id="searchStats"></div>
        <div class="search-nav">
          <button class="search-nav-btn" id="prevMatchBtn" title="Previous match (Shift+Enter)">↑</button>
          <button class="search-nav-btn" id="nextMatchBtn" title="Next match (Enter)">↓</button>
        </div>
      </div>
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
    let currentMessages = [];
    let searchMatches = [];
    let currentMatchIndex = -1;

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
      const searchContainer = document.getElementById('searchContainer');
      transcript.innerHTML = '';
      currentMessages = [];

      if (session.messages.length === 0) {
        searchContainer.style.display = 'none';
        transcript.innerHTML = \`
          <div class="empty-state">
            <h3>No messages</h3>
            <p>This session has no recorded messages.</p>
          </div>
        \`;
        return;
      }

      // Show search bar
      searchContainer.style.display = 'flex';
      currentMessages = session.messages;

      // Render each message
      for (let i = 0; i < session.messages.length; i++) {
        const message = session.messages[i];
        const messageDiv = renderMessage(message, i);
        transcript.appendChild(messageDiv);

        // Check if this message spawned a sub-agent
        if (message.type === 'tool_use' && message.name === 'Task') {
          // Find matching sub-agent by looking for task description in prompt
          const taskPrompt = message.input?.prompt;
          if (taskPrompt) {
            const matchingAgent = session.subAgents.find(agent => {
              // Simple heuristic: match if agent has messages
              return agent.messages.length > 0;
            });

            if (matchingAgent) {
              const subAgentCard = renderSubAgentCard(matchingAgent);
              transcript.appendChild(subAgentCard);
            }
          }
        }
      }

      // Add remaining sub-agents at the bottom if not already shown
      if (session.subAgents.length > 0) {
        const subAgentHeader = document.createElement('h3');
        subAgentHeader.textContent = 'Sub-Agents Summary';
        subAgentHeader.style.marginTop = '32px';
        subAgentHeader.style.marginBottom = '16px';
        subAgentHeader.style.color = '#8b949e';
        transcript.appendChild(subAgentHeader);

        for (const agent of session.subAgents) {
          const agentSummary = renderSubAgentSummary(agent);
          transcript.appendChild(agentSummary);
        }
      }

      // Apply syntax highlighting
      if (window.hljs) {
        document.querySelectorAll('pre code').forEach((block) => {
          hljs.highlightElement(block);
        });
      }
    }

    // Render a single message with enhanced formatting
    function renderMessage(message, index) {
      const messageDiv = document.createElement('div');
      messageDiv.className = \`message type-\${getMessageType(message)}\`;
      messageDiv.dataset.messageIndex = index;

      const header = document.createElement('div');
      header.className = 'message-header';

      const typeDiv = document.createElement('div');
      typeDiv.className = 'message-type';
      const icon = getMessageIcon(message);
      typeDiv.innerHTML = \`<span class="message-type-icon">\${icon}</span> \${getMessageTypeLabel(message)}\`;

      const actions = document.createElement('div');
      actions.className = 'message-actions';

      const time = document.createElement('div');
      time.className = 'message-time';
      time.textContent = formatTimestamp(message.timestamp);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '📋 Copy';
      copyBtn.onclick = () => copyToClipboard(extractTextContent(message), copyBtn);

      actions.appendChild(time);
      actions.appendChild(copyBtn);

      header.appendChild(typeDiv);
      header.appendChild(actions);

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = formatMessageContent(message);

      messageDiv.appendChild(header);
      messageDiv.appendChild(content);

      return messageDiv;
    }

    // Get message type for styling
    function getMessageType(message) {
      if (message.type === 'input') return 'user';
      if (message.type === 'output') return 'assistant';
      if (message.type === 'tool_use') return 'tool_use';
      if (message.type === 'tool_result') return 'tool_result';
      if (message.role === 'user') return 'user';
      if (message.role === 'assistant') return 'assistant';
      return message.type || 'unknown';
    }

    // Get icon for message type
    function getMessageIcon(message) {
      const type = getMessageType(message);
      const icons = {
        user: '👤',
        assistant: '🤖',
        tool_use: '🔧',
        tool_result: '✅',
        error: '🔴',
        thinking: '💭',
        subagent: '🔵'
      };
      return icons[type] || '📝';
    }

    // Get human-readable label for message type
    function getMessageTypeLabel(message) {
      const type = getMessageType(message);
      if (type === 'tool_use') return \`Tool: \${message.name || 'Unknown'}\`;
      if (type === 'tool_result') return 'Tool Result';
      if (type === 'user') return 'User';
      if (type === 'assistant') return 'Assistant';
      return type.replace('_', ' ').toUpperCase();
    }

    // Format message content with markdown and code highlighting
    function formatMessageContent(message) {
      let content = '';

      // Handle different message structures
      if (message.type === 'tool_use') {
        content += \`<div class="tool-details">\`;
        content += \`<div class="tool-name">Tool: \${message.name || 'Unknown'}</div>\`;

        if (message.input) {
          content += \`<div class="tool-params"><strong>Parameters:</strong></div>\`;
          content += \`<pre><code class="language-json">\${JSON.stringify(message.input, null, 2)}</code></pre>\`;
        }
        content += \`</div>\`;
      } else if (message.type === 'tool_result') {
        if (message.content && typeof message.content === 'string') {
          content += renderMarkdownOrCode(message.content);
        } else if (message.content) {
          content += \`<pre><code class="language-json">\${JSON.stringify(message.content, null, 2)}</code></pre>\`;
        }
      } else if (message.content) {
        // Handle content array (Claude API format)
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text') {
              content += renderMarkdownOrCode(block.text);
            } else if (block.type === 'tool_use') {
              content += \`<div class="tool-details">\`;
              content += \`<div class="tool-name">🔧 \${block.name}</div>\`;
              content += \`<pre><code class="language-json">\${JSON.stringify(block.input, null, 2)}</code></pre>\`;
              content += \`</div>\`;
            } else {
              content += \`<pre><code class="language-json">\${JSON.stringify(block, null, 2)}</code></pre>\`;
            }
          }
        } else if (typeof message.content === 'string') {
          content += renderMarkdownOrCode(message.content);
        } else {
          content += \`<pre><code class="language-json">\${JSON.stringify(message.content, null, 2)}</code></pre>\`;
        }
      } else if (message.text) {
        content += renderMarkdownOrCode(message.text);
      } else {
        content += \`<pre><code class="language-json">\${JSON.stringify(message, null, 2)}</code></pre>\`;
      }

      return content;
    }

    // Render markdown or code
    function renderMarkdownOrCode(text) {
      if (!text) return '';

      // Check if it's likely code (JSON, XML, etc.)
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(text);
          return \`<pre><code class="language-json">\${JSON.stringify(parsed, null, 2)}</code></pre>\`;
        } catch (e) {
          // Not valid JSON, treat as text
        }
      }

      // Render as markdown if marked.js is available
      if (window.marked) {
        try {
          return marked.parse(text);
        } catch (e) {
          return escapeHtml(text).replace(/\\n/g, '<br>');
        }
      }

      return escapeHtml(text).replace(/\\n/g, '<br>');
    }

    // Render sub-agent card (inline in timeline)
    function renderSubAgentCard(agent) {
      const card = document.createElement('div');
      card.className = 'message type-subagent';
      card.style.marginLeft = '40px';
      card.style.borderLeft = '4px solid #1f6feb';

      const header = document.createElement('div');
      header.className = 'message-header';

      const typeDiv = document.createElement('div');
      typeDiv.className = 'message-type';
      typeDiv.innerHTML = \`🔵 SUB-AGENT <span class="sub-agent-badge">\${agent.id.substring(0, 8)}</span>\`;

      const msgCount = document.createElement('div');
      msgCount.className = 'message-time';
      msgCount.textContent = \`\${agent.messages.length} messages\`;

      header.appendChild(typeDiv);
      header.appendChild(msgCount);

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = \`
        <p><strong>Agent ID:</strong> \${agent.id}</p>
        <p><strong>Messages:</strong> \${agent.messages.length}</p>
        <button class="copy-btn" onclick="alert('Sub-agent transcript viewer coming soon!')">View Transcript</button>
      \`;

      card.appendChild(header);
      card.appendChild(content);

      return card;
    }

    // Render sub-agent summary (at bottom)
    function renderSubAgentSummary(agent) {
      const agentDiv = document.createElement('div');
      agentDiv.className = 'message type-subagent';

      const header = document.createElement('div');
      header.className = 'message-header';

      const type = document.createElement('div');
      type.className = 'message-type';
      type.innerHTML = \`🔵 Sub-Agent <span class="sub-agent-badge">\${agent.id.substring(0, 8)}</span>\`;

      const msgCount = document.createElement('div');
      msgCount.className = 'message-time';
      msgCount.textContent = \`\${agent.messages.length} messages\`;

      header.appendChild(type);
      header.appendChild(msgCount);

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = \`
        <p><strong>Agent ID:</strong> <code>\${agent.id}</code></p>
        <p><strong>Messages:</strong> \${agent.messages.length}</p>
        <p><strong>Path:</strong> <code>\${agent.path}</code></p>
      \`;

      agentDiv.appendChild(header);
      agentDiv.appendChild(content);

      return agentDiv;
    }

    // Extract text content from message for copying
    function extractTextContent(message) {
      if (typeof message === 'string') return message;
      if (message.content) {
        if (Array.isArray(message.content)) {
          return message.content.map(b => b.text || JSON.stringify(b)).join('\\n');
        }
        if (typeof message.content === 'string') return message.content;
        return JSON.stringify(message.content, null, 2);
      }
      if (message.text) return message.text;
      return JSON.stringify(message, null, 2);
    }

    // Copy to clipboard
    function copyToClipboard(text, button) {
      navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = '✓ Copied!';
        button.classList.add('copied');
        setTimeout(() => {
          button.textContent = originalText;
          button.classList.remove('copied');
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
      });
    }

    // Escape HTML
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
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

    // Search functionality
    const searchInput = document.getElementById('searchInput');
    const searchStats = document.getElementById('searchStats');
    const prevMatchBtn = document.getElementById('prevMatchBtn');
    const nextMatchBtn = document.getElementById('nextMatchBtn');
    const clearSearchBtn = document.getElementById('clearSearchBtn');

    // Perform search
    function performSearch(query) {
      // Clear previous highlights
      document.querySelectorAll('.search-highlight').forEach(el => {
        const parent = el.parentNode;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      });

      searchMatches = [];
      currentMatchIndex = -1;

      if (!query || query.length < 2) {
        searchStats.textContent = '';
        prevMatchBtn.disabled = true;
        nextMatchBtn.disabled = true;
        return;
      }

      // Search in all messages
      const messages = document.querySelectorAll('.message');
      messages.forEach((message, index) => {
        const content = message.querySelector('.message-content');
        if (!content) return;

        const text = content.textContent.toLowerCase();
        const searchTerm = query.toLowerCase();

        if (text.includes(searchTerm)) {
          // Highlight matches in this message
          highlightInElement(content, searchTerm);
          searchMatches.push({ messageIndex: index, element: message });
        }
      });

      // Update UI
      if (searchMatches.length > 0) {
        currentMatchIndex = 0;
        searchStats.textContent = \`1 of \${searchMatches.length}\`;
        prevMatchBtn.disabled = false;
        nextMatchBtn.disabled = false;
        scrollToMatch(0);
      } else {
        searchStats.textContent = 'No matches';
        prevMatchBtn.disabled = true;
        nextMatchBtn.disabled = true;
      }
    }

    // Highlight search term in element
    function highlightInElement(element, searchTerm) {
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      const nodesToReplace = [];
      let node;

      while (node = walker.nextNode()) {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        const lowerSearch = searchTerm.toLowerCase();

        if (lowerText.includes(lowerSearch)) {
          nodesToReplace.push(node);
        }
      }

      nodesToReplace.forEach(node => {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        const lowerSearch = searchTerm.toLowerCase();
        const index = lowerText.indexOf(lowerSearch);

        if (index !== -1) {
          const before = text.substring(0, index);
          const match = text.substring(index, index + searchTerm.length);
          const after = text.substring(index + searchTerm.length);

          const fragment = document.createDocumentFragment();

          if (before) fragment.appendChild(document.createTextNode(before));

          const mark = document.createElement('mark');
          mark.className = 'search-highlight';
          mark.textContent = match;
          fragment.appendChild(mark);

          if (after) fragment.appendChild(document.createTextNode(after));

          node.parentNode.replaceChild(fragment, node);
        }
      });
    }

    // Navigate to next match
    function nextMatch() {
      if (searchMatches.length === 0) return;
      currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
      searchStats.textContent = \`\${currentMatchIndex + 1} of \${searchMatches.length}\`;
      scrollToMatch(currentMatchIndex);
    }

    // Navigate to previous match
    function prevMatch() {
      if (searchMatches.length === 0) return;
      currentMatchIndex = currentMatchIndex - 1;
      if (currentMatchIndex < 0) currentMatchIndex = searchMatches.length - 1;
      searchStats.textContent = \`\${currentMatchIndex + 1} of \${searchMatches.length}\`;
      scrollToMatch(currentMatchIndex);
    }

    // Scroll to match
    function scrollToMatch(index) {
      if (index < 0 || index >= searchMatches.length) return;
      const match = searchMatches[index];
      match.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      match.element.style.backgroundColor = '#1f6feb22';
      setTimeout(() => {
        match.element.style.backgroundColor = '';
      }, 1000);
    }

    // Clear search
    function clearSearch() {
      searchInput.value = '';
      performSearch('');
    }

    // Event listeners
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        performSearch(e.target.value);
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {
            prevMatch();
          } else {
            nextMatch();
          }
        } else if (e.key === 'Escape') {
          clearSearch();
          searchInput.blur();
        }
      });
    }

    if (prevMatchBtn) {
      prevMatchBtn.addEventListener('click', prevMatch);
    }

    if (nextMatchBtn) {
      nextMatchBtn.addEventListener('click', nextMatch);
    }

    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', clearSearch);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Focus search on '/'
      if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput.focus();
      }
    });

    // Initialize
    connectSSE();
    loadProjects();
  </script>
</body>
</html>`;
  }
}
