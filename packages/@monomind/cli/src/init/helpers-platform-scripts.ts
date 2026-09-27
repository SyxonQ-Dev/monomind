/**
 * Helper script generators: Windows daemon manager, batch wrapper and the
 * cross-platform session manager.
 */

/**
 * Generate Windows PowerShell daemon manager
 */
export function generateWindowsDaemonManager(): string {
  return `# Monomind Daemon Manager for Windows
# PowerShell script for managing background processes

param(
    [Parameter(Position=0)]
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'SilentlyContinue'
$MonomindDir = Join-Path $PWD '.monomind'
$PidDir = Join-Path $MonomindDir 'pids'

# Ensure directories exist
if (-not (Test-Path $PidDir)) {
    New-Item -ItemType Directory -Path $PidDir -Force | Out-Null
}

function Get-DaemonStatus {
    param([string]$Name, [string]$PidFile)

    if (Test-Path $PidFile) {
        $pid = Get-Content $PidFile
        $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($process) {
            return @{ Running = $true; Pid = $pid }
        }
    }
    return @{ Running = $false; Pid = $null }
}

function Start-SwarmMonitor {
    $pidFile = Join-Path $PidDir 'swarm-monitor.pid'
    $status = Get-DaemonStatus -Name 'swarm-monitor' -PidFile $pidFile

    if ($status.Running) {
        Write-Host "Swarm monitor already running (PID: $($status.Pid))" -ForegroundColor Yellow
        return
    }

    Write-Host "Starting swarm monitor..." -ForegroundColor Cyan
    $process = Start-Process -FilePath 'node' -ArgumentList @(
        '-e',
        'setInterval(() => { require("fs").writeFileSync(".monomind/metrics/monoswarm-activity.json", JSON.stringify({monoswarm:{active:true,agent_count:0},timestamp:Date.now()})) }, 5000)'
    ) -PassThru -WindowStyle Hidden

    $process.Id | Out-File $pidFile
    Write-Host "Swarm monitor started (PID: $($process.Id))" -ForegroundColor Green
}

function Stop-SwarmMonitor {
    $pidFile = Join-Path $PidDir 'swarm-monitor.pid'
    $status = Get-DaemonStatus -Name 'swarm-monitor' -PidFile $pidFile

    if (-not $status.Running) {
        Write-Host "Swarm monitor not running" -ForegroundColor Yellow
        return
    }

    Stop-Process -Id $status.Pid -Force
    Remove-Item $pidFile -Force
    Write-Host "Swarm monitor stopped" -ForegroundColor Green
}

function Show-Status {
    Write-Host ""
    Write-Host "Monomind Daemon Status" -ForegroundColor Cyan
    Write-Host "=============================" -ForegroundColor Cyan

    $swarmPid = Join-Path $PidDir 'swarm-monitor.pid'
    $swarmStatus = Get-DaemonStatus -Name 'swarm-monitor' -PidFile $swarmPid

    if ($swarmStatus.Running) {
        Write-Host "  Swarm Monitor: RUNNING (PID: $($swarmStatus.Pid))" -ForegroundColor Green
    } else {
        Write-Host "  Swarm Monitor: STOPPED" -ForegroundColor Red
    }
    Write-Host ""
}

switch ($Action) {
    'start' {
        Start-SwarmMonitor
        Show-Status
    }
    'stop' {
        Stop-SwarmMonitor
        Show-Status
    }
    'restart' {
        Stop-SwarmMonitor
        Start-Sleep -Seconds 1
        Start-SwarmMonitor
        Show-Status
    }
    'status' {
        Show-Status
    }
}
`;
}

/**
 * Generate Windows batch file wrapper
 */
export function generateWindowsBatchWrapper(): string {
  return `@echo off
REM Monomind - Windows Batch Wrapper
REM Routes to PowerShell daemon manager

PowerShell -ExecutionPolicy Bypass -File "%~dp0daemon-manager.ps1" %*
`;
}

/**
 * Generate cross-platform session manager
 */
export function generateCrossPlatformSessionManager(): string {
  return `#!/usr/bin/env node
/**
 * Monomind Cross-Platform Session Manager
 * Works on Windows, macOS, and Linux
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Platform-specific paths
const platform = os.platform();
const homeDir = os.homedir();

// Get data directory based on platform
function getDataDir() {
  const localDir = path.join(process.cwd(), '.monomind', 'sessions');
  if (fs.existsSync(path.dirname(localDir))) {
    return localDir;
  }

  switch (platform) {
    case 'win32':
      return path.join(process.env.APPDATA || homeDir, 'monomind', 'sessions');
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'monomind', 'sessions');
    default:
      return path.join(homeDir, '.monomind', 'sessions');
  }
}

const SESSION_DIR = getDataDir();
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const commands = {
  start: () => {
    ensureDir(SESSION_DIR);
    const sessionId = \`session-\${Date.now()}\`;
    const session = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      platform: platform,
      cwd: process.cwd(),
      context: {},
      metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 }
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    console.log(\`Session started: \${sessionId}\`);
    return session;
  },

  restore: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No session to restore');
      return null;
    }
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.restoredAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    console.log(\`Session restored: \${session.id}\`);
    return session;
  },

  end: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.endedAt = new Date().toISOString();
    session.duration = Date.now() - new Date(session.startedAt).getTime();

    const archivePath = path.join(SESSION_DIR, \`\${session.id}.json\`);
    fs.writeFileSync(archivePath, JSON.stringify(session, null, 2));
    fs.unlinkSync(SESSION_FILE);

    console.log(\`Session ended: \${session.id}\`);
    console.log(\`Duration: \${Math.round(session.duration / 1000 / 60)} minutes\`);
    return session;
  },

  status: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    const duration = Date.now() - new Date(session.startedAt).getTime();
    console.log(\`Session: \${session.id}\`);
    console.log(\`Platform: \${session.platform}\`);
    console.log(\`Started: \${session.startedAt}\`);
    console.log(\`Duration: \${Math.round(duration / 1000 / 60)} minutes\`);
    return session;
  }
};

// CLI
const [,, command, ...args] = process.argv;
if (command && commands[command]) {
  commands[command](...args);
} else {
  console.log('Usage: session.js <start|restore|end|status>');
  console.log(\`Platform: \${platform}\`);
  console.log(\`Data dir: \${SESSION_DIR}\`);
}

module.exports = commands;
`;
}
