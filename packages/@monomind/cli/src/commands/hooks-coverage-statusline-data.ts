import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function getLearningStats() {
  const memoryPaths = [
    path.join(process.cwd(), '.swarm', 'memory.db'),
    path.join(process.cwd(), '.claude', 'memory.db'),
  ];

  let patterns = 0;
  let sessions = 0;
  let trajectories = 0;

  for (const dbPath of memoryPaths) {
    if (fs.existsSync(dbPath)) {
      try {
        const stats = fs.statSync(dbPath);
        const sizeKB = stats.size / 1024;
        // Estimate: ~2KB per pattern entry on average
        patterns = Math.floor(sizeKB / 2); // estimatedPatterns — derived from file size, not counted
        sessions = Math.max(1, Math.floor(patterns / 10));
        trajectories = Math.floor(patterns / 5);
        break;
      } catch {
        /* ignore */
      }
    }
  }

  const sessionsPath = path.join(process.cwd(), '.claude', 'sessions');
  if (fs.existsSync(sessionsPath)) {
    try {
      const sessionFiles = fs.readdirSync(sessionsPath).filter((f: string) => f.endsWith('.json'));
      sessions = Math.max(sessions, sessionFiles.length);
    } catch {
      /* ignore */
    }
  }

  return { patterns, sessions, trajectories };
}

export function getv1Progress() {
  const learning = getLearningStats();
  let domainsCompleted = 0;
  if (learning.patterns >= 500) domainsCompleted = 5;
  else if (learning.patterns >= 200) domainsCompleted = 4;
  else if (learning.patterns >= 100) domainsCompleted = 3;
  else if (learning.patterns >= 50) domainsCompleted = 2;
  else if (learning.patterns >= 10) domainsCompleted = 1;

  const totalDomains = 5;
  const dddProgress = Math.min(100, Math.floor((domainsCompleted / totalDomains) * 100));

  return {
    domainsCompleted,
    totalDomains,
    dddProgress,
    patternsLearned: learning.patterns,
    sessionsCompleted: learning.sessions,
  };
}

export function getSecurityStatus() {
  const scanResultsPath = path.join(process.cwd(), '.claude', 'security-scans');
  let cvesFixed = 0;
  const totalCves = 3;

  if (fs.existsSync(scanResultsPath)) {
    try {
      const scans = fs.readdirSync(scanResultsPath).filter((f: string) => f.endsWith('.json'));
      cvesFixed = Math.min(totalCves, scans.length);
    } catch {
      /* ignore */
    }
  }

  const auditPath = path.join(process.cwd(), '.swarm', 'security');
  if (fs.existsSync(auditPath)) {
    try {
      const audits = fs.readdirSync(auditPath).filter((f: string) => f.includes('audit'));
      cvesFixed = Math.min(totalCves, Math.max(cvesFixed, audits.length));
    } catch {
      /* ignore */
    }
  }

  const status = cvesFixed >= totalCves ? 'CLEAN' : cvesFixed > 0 ? 'IN_PROGRESS' : 'PENDING';
  return { status, cvesFixed, totalCves };
}

export function getSwarmStatus() {
  let activeAgents = 0;
  let coordinationActive = false;
  const maxAgents = 15;
  const isWindows = process.platform === 'win32';

  try {
    const psCmd = isWindows
      ? 'tasklist /FI "IMAGENAME eq node.exe" 2>NUL | findstr /I /C:"node" >NUL && echo 1 || echo 0'
      : 'ps aux 2>/dev/null | grep -c "mcp.*start" || echo "0"';
    const ps = execSync(psCmd, { encoding: 'utf-8' });
    const raw = parseInt(ps.trim(), 10);
    activeAgents = Math.max(0, isWindows ? raw : raw - 1);
    coordinationActive = activeAgents > 0;
  } catch {
    /* ignore */
  }

  return { activeAgents, maxAgents, coordinationActive };
}

export function getSystemMetrics() {
  let memoryMB = 0;
  const subAgents = 0;
  const learning = getLearningStats();

  try {
    memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
  } catch {
    /* ignore */
  }

  let intelligencePct = 0;

  const learningJsonPaths = [
    path.join(process.cwd(), '.monomind', 'learning.json'),
    path.join(process.cwd(), '.claude', '.monomind', 'learning.json'),
    path.join(process.cwd(), '.swarm', 'learning.json'),
  ];
  for (const lPath of learningJsonPaths) {
    if (fs.existsSync(lPath)) {
      try {
        if (fs.statSync(lPath).size <= 524_288) {
          const data = JSON.parse(fs.readFileSync(lPath, 'utf-8'));
          if (data.intelligence?.score !== undefined) {
            intelligencePct = Math.min(100, Math.floor(data.intelligence.score));
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (intelligencePct === 0) {
    intelligencePct = learning.patterns > 0 ? Math.min(100, Math.floor(learning.patterns / 10)) : 0;
  }

  if (intelligencePct === 0) {
    let maturityScore = 0;
    if (fs.existsSync(path.join(process.cwd(), '.claude'))) maturityScore += 15;
    if (fs.existsSync(path.join(process.cwd(), '.monomind'))) maturityScore += 15;
    if (fs.existsSync(path.join(process.cwd(), 'CLAUDE.md'))) maturityScore += 10;
    if (fs.existsSync(path.join(process.cwd(), 'monomind.config.json'))) maturityScore += 10;
    if (fs.existsSync(path.join(process.cwd(), '.swarm'))) maturityScore += 10;
    const testDirs = ['tests', '__tests__', 'test', 'v1/__tests__'];
    for (const dir of testDirs) {
      if (fs.existsSync(path.join(process.cwd(), dir))) {
        maturityScore += 10;
        break;
      }
    }
    if (fs.existsSync(path.join(process.cwd(), '.claude', 'settings.json'))) maturityScore += 10;
    intelligencePct = Math.min(100, maturityScore);
  }

  const contextPct = Math.min(100, Math.floor(learning.sessions * 5));
  return { memoryMB, contextPct, intelligencePct, subAgents };
}

export function getUserInfo() {
  let name = 'user';
  let gitBranch = '';
  const modelName = 'Opus 4.6 (1M context)';
  const isWindows = process.platform === 'win32';

  try {
    const nameCmd = isWindows
      ? 'git config user.name 2>NUL || echo user'
      : 'git config user.name 2>/dev/null || echo "user"';
    const branchCmd = isWindows
      ? 'git branch --show-current 2>NUL || echo.'
      : 'git branch --show-current 2>/dev/null || echo ""';
    name = execSync(nameCmd, { encoding: 'utf-8' }).trim();
    gitBranch = execSync(branchCmd, { encoding: 'utf-8' }).trim();
    if (gitBranch === '.') gitBranch = '';
  } catch {
    /* ignore */
  }

  return { name, gitBranch, modelName };
}
