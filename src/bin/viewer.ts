#!/usr/bin/env node
/**
 * Standalone Claude Code Transcript Viewer
 * Run with: npm run viewer
 */

import express from 'express';
import { ViewerService } from '../services/viewer-service.js';

const PORT = parseInt(process.env.CLAUDE_VIEWER_PORT || '3737', 10);

async function main() {
  const app = express();
  const viewerService = new ViewerService();

  // Register viewer routes
  app.get('/', viewerService.handleViewerPage.bind(viewerService));
  app.get('/api/events', viewerService.handleSSE.bind(viewerService));
  app.get('/api/projects', viewerService.handleGetProjects.bind(viewerService));
  app.get('/api/sessions/:projectName/:sessionId', viewerService.handleGetSession.bind(viewerService));

  // Start server
  await new Promise<void>((resolve, reject) => {
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║  Claude Code Transcript Viewer                            ║
║                                                            ║
║  🌐 Server running at: http://localhost:${PORT}             ║
║  📁 Watching: ~/.claude/projects                          ║
║                                                            ║
║  Press Ctrl+C to stop                                      ║
╚════════════════════════════════════════════════════════════╝
      `);
      resolve();
    }).on('error', reject);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n\nShutting down...');
    viewerService.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
