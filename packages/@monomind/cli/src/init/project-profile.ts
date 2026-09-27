/**
 * Project profile detection (language, framework, package manager, layout)
 * used by the shared-instructions and CLAUDE.md generators.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Project Profile ───────────────────────────────────────────────────────────

export interface ProjectProfile {
  name: string;
  description: string;
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'unknown';
  framework: string[]; // e.g. ['react', 'nextjs']
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'cargo' | 'poetry' | 'uv' | 'pip' | 'unknown';
  testFramework: string[]; // e.g. ['vitest', 'jest']
  buildTool: string[]; // e.g. ['vite', 'tsc', 'esbuild']
  isMonorepo: boolean;
  monorepoTool: string; // 'pnpm-workspaces' | 'turborepo' | 'nx' | ''
  database: string[]; // e.g. ['postgres', 'sqlite']
  hasDocker: boolean;
  hasCi: boolean;
  ciTool: string; // 'github-actions' | 'circleci' | 'gitlab-ci' | ''
  maxFileLines: number | null; // from CLAUDE.md if present
  srcDir: string; // 'src' | 'packages' | 'lib' | 'app' | ''
  testDir: string; // 'tests' | 'test' | '__tests__' | 'spec' | ''
  version: string;
  isPublicNpm: boolean;
}

const MAX_JSON_READ_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024; // 2 MB for plain-text config files

function readJSON(p: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size > MAX_JSON_READ_BYTES) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function fileExists(cwd: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(cwd, ...parts));
}

function detectSrcDir(cwd: string): string {
  for (const d of ['src', 'packages', 'lib', 'app']) {
    if (fs.existsSync(path.join(cwd, d)) && fs.statSync(path.join(cwd, d)).isDirectory()) {
      return d;
    }
  }
  return '';
}

function detectTestDir(cwd: string): string {
  for (const d of ['tests', 'test', '__tests__', 'spec']) {
    if (fs.existsSync(path.join(cwd, d)) && fs.statSync(path.join(cwd, d)).isDirectory()) {
      return d;
    }
  }
  return '';
}

function extractMaxFileLines(claudeMd: string): number | null {
  const m = claudeMd.match(/(?:keep|max|under|limit).*?(\d{3,4})\s*lines/i);
  return m ? parseInt(m[1], 10) : null;
}

export function detectProjectProfile(cwd: string): ProjectProfile {
  const profile: ProjectProfile = {
    name: path.basename(cwd),
    description: '',
    language: 'unknown',
    framework: [],
    packageManager: 'unknown',
    testFramework: [],
    buildTool: [],
    isMonorepo: false,
    monorepoTool: '',
    database: [],
    hasDocker: false,
    hasCi: false,
    ciTool: '',
    maxFileLines: null,
    srcDir: detectSrcDir(cwd),
    testDir: detectTestDir(cwd),
    version: '0.0.0',
    isPublicNpm: false,
  };

  // ── package.json (Node/TS/JS) ──────────────────────────────────────────────
  const pkg = readJSON(path.join(cwd, 'package.json'));
  if (pkg) {
    profile.name = (pkg.name as string) || profile.name;
    profile.description = (pkg.description as string) || '';
    profile.version = (pkg.version as string) || '0.0.0';
    profile.isPublicNpm = !(pkg.private as boolean);

    const deps = {
      ...((pkg.dependencies as Record<string, string>) || {}),
      ...((pkg.devDependencies as Record<string, string>) || {}),
      ...((pkg.peerDependencies as Record<string, string>) || {}),
    };

    // Language — a root package.json is common even in non-JS repos (e.g. to
    // declare a single tooling dependency; see GH #241). Don't let its mere
    // presence outrank a stronger, single-purpose manifest for another
    // stack: go.mod, Cargo.toml, and pyproject.toml are deliberate,
    // single-stack acts, whereas package.json is the ecosystem's cheap
    // catch-all that any repo can carry for an unrelated reason. When one of
    // those is present, leave `language` 'unknown' here so the dedicated
    // per-language blocks below (already gated on `language === 'unknown'`)
    // claim it — and, just as importantly, reset `packageManager` off
    // 'npm' too, which is what actually drives the "Install dependencies" /
    // "Run tests" commands in the generated file.
    const hasStrongerStackMarker =
      fileExists(cwd, 'go.mod') ||
      fileExists(cwd, 'Cargo.toml') ||
      fileExists(cwd, 'pyproject.toml');
    if (!hasStrongerStackMarker) {
      profile.language =
        deps.typescript || fileExists(cwd, 'tsconfig.json') ? 'typescript' : 'javascript';
    }

    // Package manager
    if (fileExists(cwd, 'pnpm-lock.yaml') || fileExists(cwd, 'pnpm-workspace.yaml'))
      profile.packageManager = 'pnpm';
    else if (fileExists(cwd, 'yarn.lock')) profile.packageManager = 'yarn';
    else if (fileExists(cwd, 'bun.lockb')) profile.packageManager = 'bun';
    else profile.packageManager = 'npm';

    // Monorepo
    if (
      fileExists(cwd, 'pnpm-workspace.yaml') ||
      (pkg.workspaces && profile.packageManager === 'pnpm')
    ) {
      profile.isMonorepo = true;
      profile.monorepoTool = 'pnpm-workspaces';
    } else if (pkg.workspaces) {
      profile.isMonorepo = true;
      profile.monorepoTool = 'npm-workspaces';
    }
    if (deps.turbo || fileExists(cwd, 'turbo.json')) {
      profile.isMonorepo = true;
      profile.monorepoTool = 'turborepo';
    }
    if (deps.nx || fileExists(cwd, 'nx.json')) {
      profile.isMonorepo = true;
      profile.monorepoTool = 'nx';
    }

    // Framework
    if (deps.next) profile.framework.push('nextjs');
    else if (deps.react) profile.framework.push('react');
    if (deps.vue) profile.framework.push('vue');
    if (deps.nuxt || deps.nuxt3) profile.framework.push('nuxt');
    if (deps['@angular/core']) profile.framework.push('angular');
    if (deps.svelte || deps['@sveltejs/kit']) profile.framework.push('svelte');
    if (deps.express) profile.framework.push('express');
    if (deps.fastify) profile.framework.push('fastify');
    if (deps.hono) profile.framework.push('hono');
    if (deps['@nestjs/core']) profile.framework.push('nestjs');
    if (deps.elysia) profile.framework.push('elysia');

    // Testing
    if (deps.vitest) profile.testFramework.push('vitest');
    if (deps.jest || deps['@jest/core']) profile.testFramework.push('jest');
    if (deps.mocha) profile.testFramework.push('mocha');
    if (deps['@playwright/test']) profile.testFramework.push('playwright');
    if (deps.cypress) profile.testFramework.push('cypress');

    // Build
    if (deps.vite || fileExists(cwd, 'vite.config.ts') || fileExists(cwd, 'vite.config.js'))
      profile.buildTool.push('vite');
    if (deps.esbuild) profile.buildTool.push('esbuild');
    if (deps.webpack) profile.buildTool.push('webpack');
    if (deps.rollup) profile.buildTool.push('rollup');
    if (fileExists(cwd, 'tsconfig.json') && profile.buildTool.length === 0)
      profile.buildTool.push('tsc');

    // Database
    if (deps.pg || deps.postgres || deps['@neondatabase/serverless'])
      profile.database.push('postgres');
    if (deps['better-sqlite3'] || deps['@libsql/client'] || deps['sql.js'])
      profile.database.push('sqlite');
    if (deps.mongoose || deps.mongodb) profile.database.push('mongodb');
    if (deps.redis || deps.ioredis) profile.database.push('redis');
    if (deps['drizzle-orm']) profile.database.push('drizzle');
    if (deps.prisma || deps['@prisma/client']) profile.database.push('prisma');
    if (deps['@supabase/supabase-js']) profile.database.push('supabase');
  }

  // ── Cargo.toml (Rust) ──────────────────────────────────────────────────────
  if (fileExists(cwd, 'Cargo.toml') && profile.language === 'unknown') {
    profile.language = 'rust';
    profile.packageManager = 'cargo';
    try {
      const cargoPath = path.join(cwd, 'Cargo.toml');
      if (fs.statSync(cargoPath).size > MAX_TEXT_READ_BYTES) throw new Error('too large');
      const cargo = fs.readFileSync(cargoPath, 'utf-8');
      const nameM = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameM) profile.name = nameM[1];
      if (fileExists(cwd, 'Cargo.lock') && cargo.includes('[workspace]')) profile.isMonorepo = true;
      if (cargo.includes('axum') || cargo.includes('actix') || cargo.includes('warp'))
        profile.framework.push('web');
      if (cargo.includes('tokio')) profile.framework.push('tokio');
      if (cargo.includes('serde')) profile.framework.push('serde');
    } catch {
      /* skip */
    }
  }

  // ── pyproject.toml / requirements.txt (Python) ────────────────────────────
  if (
    (fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'requirements.txt')) &&
    profile.language === 'unknown'
  ) {
    profile.language = 'python';
    if (fileExists(cwd, 'poetry.lock')) profile.packageManager = 'poetry';
    else if (fileExists(cwd, 'uv.lock')) profile.packageManager = 'uv';
    else profile.packageManager = 'pip';
    try {
      const ppPath = path.join(cwd, 'pyproject.toml');
      if (fs.existsSync(ppPath) && fs.statSync(ppPath).size > MAX_TEXT_READ_BYTES)
        throw new Error('too large');
      const pp = fs.readFileSync(ppPath, 'utf-8');
      if (pp.includes('fastapi') || pp.includes('FastAPI')) profile.framework.push('fastapi');
      if (pp.includes('django')) profile.framework.push('django');
      if (pp.includes('flask')) profile.framework.push('flask');
      if (pp.includes('pytest')) profile.testFramework.push('pytest');
      if (pp.includes('sqlalchemy')) profile.database.push('sqlalchemy');
    } catch {
      /* skip */
    }
  }

  // ── go.mod (Go) ───────────────────────────────────────────────────────────
  if (fileExists(cwd, 'go.mod') && profile.language === 'unknown') {
    profile.language = 'go';
    profile.packageManager = 'unknown'; // go mod doesn't have a separate PM
    try {
      const gomodPath = path.join(cwd, 'go.mod');
      if (fs.statSync(gomodPath).size > MAX_TEXT_READ_BYTES) throw new Error('too large');
      const gomod = fs.readFileSync(gomodPath, 'utf-8');
      if (gomod.includes('gin-gonic/gin')) profile.framework.push('gin');
      if (gomod.includes('labstack/echo')) profile.framework.push('echo');
      if (gomod.includes('gofiber/fiber')) profile.framework.push('fiber');
    } catch {
      /* skip */
    }
  }

  // ── Infrastructure detection ───────────────────────────────────────────────
  profile.hasDocker =
    fileExists(cwd, 'Dockerfile') ||
    fileExists(cwd, 'docker-compose.yml') ||
    fileExists(cwd, 'docker-compose.yaml');

  if (fileExists(cwd, '.github', 'workflows')) {
    profile.hasCi = true;
    profile.ciTool = 'github-actions';
  } else if (fileExists(cwd, '.circleci')) {
    profile.hasCi = true;
    profile.ciTool = 'circleci';
  } else if (fileExists(cwd, '.gitlab-ci.yml')) {
    profile.hasCi = true;
    profile.ciTool = 'gitlab-ci';
  }

  // ── CLAUDE.md conventions extraction ──────────────────────────────────────
  try {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath) && fs.statSync(claudeMdPath).size > MAX_TEXT_READ_BYTES)
      throw new Error('too large');
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    profile.maxFileLines = extractMaxFileLines(claudeMd);
  } catch {
    /* skip */
  }

  return profile;
}
