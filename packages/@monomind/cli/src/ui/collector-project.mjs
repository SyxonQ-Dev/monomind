import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileStat, listDir, readJSON } from './collector-helpers.mjs';
import { collectMemoryFiles } from './collector-status.mjs';

// ---------------------------------------------------------------------------
// Section collectors
// ---------------------------------------------------------------------------

function collectProject(projectDir) {
  let name = path.basename(projectDir);
  const pkgPath = path.join(projectDir, 'package.json');
  const pkg = readJSON(pkgPath);
  if (pkg?.name) {
    name = pkg.name;
  }
  return { dir: projectDir, name };
}

function getClaudeProjectSessionsDir(projectDir) {
  // Claude Code stores sessions in ~/.claude/projects/<slug>/ not in the project itself
  const homeDir = os.homedir();
  const slug = projectDir.replace(/\//g, '-');
  const globalSessions = path.join(homeDir, '.claude', 'projects', slug);
  if (fs.existsSync(globalSessions)) return globalSessions;
  // Fallback to local .claude/sessions
  return path.join(projectDir, '.claude', 'sessions');
}

function collectSessions(projectDir) {
  const sessionsDir = getClaudeProjectSessionsDir(projectDir);
  const entries = listDir(sessionsDir);
  const list = entries
    .filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
    .map((f) => {
      const filePath = path.join(sessionsDir, f);
      const stat = fileStat(filePath);
      const id = path.basename(f, path.extname(f));
      return {
        id,
        file: filePath,
        mtime: stat ? stat.mtimeMs : null,
        size: stat ? stat.size : null,
      };
    })
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

  const memFiles = collectMemoryFiles(projectDir);

  return {
    list,
    count: list.length,
    palace: {
      count: memFiles.length,
    },
  };
}

const _appendedSwarmIds = new Set();

function collectSwarm(projectDir) {
  const merged = readJSON(path.join(projectDir, '.swarm', 'state.json')) || {};

  const terminalStatuses = ['stopped', 'terminated', 'completed', 'error'];
  const swarmId = merged.swarmId || merged.id;
  if (swarmId && terminalStatuses.includes(merged.status) && !_appendedSwarmIds.has(swarmId)) {
    _appendedSwarmIds.add(swarmId);
    const agents = (merged.agents || merged.agentPlan || []).map((a) => ({
      id: a.id || a.type || a.role,
      type: a.type || a.role || '?',
      role: a.role || 'worker',
      tasksCompleted: a.tasksCompleted || a.count || 0,
      tasksFailed: a.tasksFailed || 0,
      messageCount: a.messageCount || 0,
      utilization: a.utilization || 0,
    }));
    const entry = {
      swarmId,
      topology: merged.topology || '—',
      consensus: merged.consensus || '—',
      strategy: merged.strategy || '—',
      status: merged.status,
      agents,
      messages: merged.messages || [],
      errors: merged.errors || [],
      findings: merged.findings || [],
      taskCount: merged.taskCount || 0,
      completedTasks: merged.completedTasks || 0,
      failedTasks: merged.failedTasks || 0,
      startedAt: merged.startedAt || merged.createdAt || new Date().toISOString(),
      endedAt: merged.stoppedAt || merged.endedAt || new Date().toISOString(),
      durationMs: 0,
    };
    if (entry.startedAt && entry.endedAt) {
      entry.durationMs = new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime();
    }
    try {
      appendSwarmHistory(projectDir, entry);
    } catch {}
  }

  return {
    state: merged,
    activity: readJSON(path.join(base, 'metrics', 'monoswarm-activity.json')) || {},
    suggestion: {},
    config: readJSON(path.join(base, 'swarm-config.json')) || {},
  };
}

function appendSwarmHistory(projectDir, entry) {
  const dir = path.join(projectDir, '.monomind', 'swarm');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const historyPath = path.join(dir, 'history.jsonl');
  fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
}

function collectAgents(projectDir) {
  const base = path.join(projectDir, '.monomind');
  const regsDir = path.join(base, 'agents', 'registrations');
  const regFiles = listDir(regsDir).filter((f) => f.endsWith('.json'));
  const registrations = regFiles
    .map((f) => {
      return readJSON(path.join(regsDir, f));
    })
    .filter(Boolean);

  const registry = readJSON(path.join(base, 'registry.json')) || {};

  return {
    registrations,
    registry,
    count: registrations.length,
  };
}

export {
  collectAgents,
  collectProject,
  collectSessions,
  collectSwarm,
  getClaudeProjectSessionsDir,
};
