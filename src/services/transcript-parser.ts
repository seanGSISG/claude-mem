/**
 * Transcript Parser - Parse Claude Code JSONL transcripts
 * Handles main conversation files and sub-agent transcripts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface TranscriptMessage {
  type: string;
  [key: string]: any;
}

export interface SubAgentInfo {
  id: string;
  path: string;
  messages: TranscriptMessage[];
  parentSession?: string;
}

export interface Session {
  projectPath: string;
  projectName: string;
  sessionFile: string;
  sessionId: string;
  messages: TranscriptMessage[];
  subAgents: SubAgentInfo[];
  lastModified: number;
}

export interface Project {
  path: string;
  name: string;
  sessions: Session[];
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Parse a JSONL file into messages
 */
export function parseJSONL(filePath: string): TranscriptMessage[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return { type: 'parse_error', raw: line };
      }
    });
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error);
    return [];
  }
}

/**
 * Extract agent ID from filename (e.g., "agent-abc123.jsonl" -> "abc123")
 */
function extractAgentId(filename: string): string | null {
  const match = filename.match(/^agent-(.+)\.jsonl$/);
  return match ? match[1] : null;
}

/**
 * Check if a filename is a sub-agent transcript
 */
function isSubAgentFile(filename: string): boolean {
  return filename.startsWith('agent-') && filename.endsWith('.jsonl');
}

/**
 * Check if a filename is a main session transcript
 */
function isSessionFile(filename: string): boolean {
  return filename.endsWith('.jsonl') && !isSubAgentFile(filename) && !filename.includes('-agent-');
}

/**
 * Discover all sub-agents in a project directory
 */
export function discoverSubAgents(projectPath: string): SubAgentInfo[] {
  try {
    const files = readdirSync(projectPath);
    const subAgents: SubAgentInfo[] = [];

    for (const file of files) {
      if (isSubAgentFile(file)) {
        const agentId = extractAgentId(file);
        if (agentId) {
          const filePath = join(projectPath, file);
          subAgents.push({
            id: agentId,
            path: filePath,
            messages: parseJSONL(filePath),
          });
        }
      }
    }

    return subAgents;
  } catch (error) {
    console.error(`Error discovering sub-agents in ${projectPath}:`, error);
    return [];
  }
}

/**
 * Parse a single session from a project directory
 */
export function parseSession(projectPath: string, sessionFile: string): Session | null {
  try {
    const filePath = join(projectPath, sessionFile);
    const stat = statSync(filePath);
    const messages = parseJSONL(filePath);
    const subAgents = discoverSubAgents(projectPath);

    // Extract session ID from filename (remove .jsonl extension)
    const sessionId = sessionFile.replace('.jsonl', '');

    return {
      projectPath,
      projectName: projectPath.split('/').pop() || 'unknown',
      sessionFile,
      sessionId,
      messages,
      subAgents,
      lastModified: stat.mtimeMs,
    };
  } catch (error) {
    console.error(`Error parsing session ${sessionFile}:`, error);
    return null;
  }
}

/**
 * Get all sessions for a project
 */
export function getProjectSessions(projectPath: string): Session[] {
  try {
    const files = readdirSync(projectPath);
    const sessions: Session[] = [];

    for (const file of files) {
      if (isSessionFile(file)) {
        const session = parseSession(projectPath, file);
        if (session) {
          sessions.push(session);
        }
      }
    }

    // Sort by last modified (newest first)
    return sessions.sort((a, b) => b.lastModified - a.lastModified);
  } catch (error) {
    console.error(`Error getting sessions for ${projectPath}:`, error);
    return [];
  }
}

/**
 * Discover all projects in ~/.claude/projects
 */
export function discoverProjects(): Project[] {
  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    const projects: Project[] = [];

    for (const dir of projectDirs) {
      const projectPath = join(CLAUDE_PROJECTS_DIR, dir);

      try {
        const stat = statSync(projectPath);
        if (stat.isDirectory()) {
          const sessions = getProjectSessions(projectPath);

          // Only include projects with sessions
          if (sessions.length > 0) {
            projects.push({
              path: projectPath,
              name: dir,
              sessions,
            });
          }
        }
      } catch (error) {
        // Skip directories we can't read
        continue;
      }
    }

    return projects;
  } catch (error) {
    console.error('Error discovering projects:', error);
    return [];
  }
}

/**
 * Get a specific session by project name and session ID
 */
export function getSession(projectName: string, sessionId: string): Session | null {
  const projectPath = join(CLAUDE_PROJECTS_DIR, projectName);
  const sessionFile = `${sessionId}.jsonl`;
  return parseSession(projectPath, sessionFile);
}

/**
 * Get Claude projects directory path
 */
export function getProjectsDir(): string {
  return CLAUDE_PROJECTS_DIR;
}
