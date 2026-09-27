/**
 * Shell-command parsing for the Cursor preToolUse write gate
 * (hook-before-edit.mjs): where a shell command writes, and what it writes.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SENSITIVE_PATH, isGeneratedPath } from './hook-lib.mjs';

function shellCommand(input) {
  if (typeof input.command === 'string') return input.command;
  if (input.args && typeof input.args.command === 'string') return input.args.command;
  return '';
}

function shellRedirectPath(command) {
  if (!command || typeof command !== 'string') return '';
  const match = command.match(/(?:^|[\s;&|])(?:>>?|1>>?)\s*(?:"([^"]+)"|'([^']+)'|([^<>\s]+))/);
  return (match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function shellWriteDestination(command) {
  return shellRedirectPath(command) || shellTeeDestination(command) || shellCopyPaths(command)?.dest || shellPythonWriteDestination(command) || '';
}

function shellPythonWriteDestination(command) {
  if (!/\bpython(?:3)?\b/.test(command || '')) return '';
  const directPath = firstMatch(command, /(?:^|[^\w.])(?:pathlib\.)?Path\(\s*(["'])(.*?)\1\s*\)\s*\.write_text\s*\(/);
  if (directPath) return directPath;

  const pathsByVar = new Map();
  const assignmentRe = /\b([A-Za-z_]\w*)\s*=\s*(?:pathlib\.)?Path\(\s*(["'])(.*?)\2\s*\)/g;
  let assignment;
  while ((assignment = assignmentRe.exec(command))) {
    pathsByVar.set(assignment[1], assignment[3]);
  }

  const writeVarRe = /\b([A-Za-z_]\w*)\.write_text\s*\(/g;
  let writeVar;
  while ((writeVar = writeVarRe.exec(command))) {
    const candidate = pathsByVar.get(writeVar[1]);
    if (candidate) return candidate;
  }

  return firstMatch(command, /\bopen\(\s*(["'])(.*?)\1\s*,\s*(["'])[wax](?:\+)?b?\3/);
}

function firstMatch(value, re) {
  const match = String(value || '').match(re);
  return (match?.[2] || '').trim();
}

function shellTeeDestination(command) {
  const words = shellWords(command);
  const teeIndex = words.findIndex((word) => path.basename(word) === 'tee');
  if (teeIndex === -1) return '';
  for (const word of words.slice(teeIndex + 1)) {
    if (['&&', '||', ';', '|'].includes(word)) break;
    if (word === '--') continue;
    if (word.startsWith('-')) continue;
    return word;
  }
  return '';
}

function shellCopiedFileContent(command, cwd) {
  const source = shellCopyPaths(command)?.source;
  if (!source) return '';
  const sourcePath = path.isAbsolute(source) ? source : path.resolve(cwd, source);
  if (!isInsideProject(sourcePath, cwd)) return '';
  if (SENSITIVE_PATH.test(sourcePath) || isGeneratedPath(sourcePath, cwd)) return '';
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return '';
    return fs.readFileSync(sourcePath, 'utf-8');
  } catch {
    return '';
  }
}

function shellCopyPaths(command) {
  const words = shellWords(command);
  if (words.length < 3 || path.basename(words[0]) !== 'cp') return null;
  const args = [];
  for (const word of words.slice(1)) {
    if (['&&', '||', ';', '|'].includes(word)) break;
    if (word === '--') continue;
    if (word.startsWith('-')) continue;
    args.push(word);
  }
  if (args.length < 2) return null;
  return { source: args[args.length - 2], dest: args[args.length - 1] };
}

function shellWords(command) {
  if (!command || typeof command !== 'string') return [];
  const words = [];
  const re = /"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)'|([^\s]+)/g;
  let match;
  while ((match = re.exec(command))) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["'])/g, '$1'));
  }
  return words;
}

function shellHereDocContent(command) {
  if (!command || typeof command !== 'string') return '';
  const markerMatch = command.match(/<<-?\s*['"]?([A-Za-z0-9_.-]+)['"]?[^\r\n]*\r?\n/);
  if (!markerMatch) return '';
  const marker = markerMatch[1];
  const start = (markerMatch.index || 0) + markerMatch[0].length;
  const rest = command.slice(start);
  const endRe = new RegExp(`\\r?\\n${escapeRegExp(marker)}(?:\\r?\\n|$)`);
  const end = rest.search(endRe);
  return end >= 0 ? rest.slice(0, end) : '';
}

function shellPythonWriteContent(command) {
  if (!/\bpython(?:3)?\b/.test(command || '')) return '';
  const script = shellHereDocContent(command) || command;
  return pythonStringArg(script, /\.write_text\s*\(\s*/g) || pythonStringArg(script, /\.write\s*\(\s*/g);
}

function pythonStringArg(script, prefixRe) {
  let prefix;
  while ((prefix = prefixRe.exec(script))) {
    const start = prefixRe.lastIndex;
    const triple = script.slice(start, start + 3);
    if (triple === "'''" || triple === '"""') {
      const end = script.indexOf(triple, start + 3);
      if (end !== -1) return script.slice(start + 3, end);
      continue;
    }
    const quote = script[start];
    if (quote !== '"' && quote !== "'") continue;
    let out = '';
    for (let i = start + 1; i < script.length; i++) {
      const ch = script[i];
      if (ch === '\\') {
        out += script[i + 1] || '';
        i += 1;
      } else if (ch === quote) {
        return out;
      } else {
        out += ch;
      }
    }
  }
  return '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativePath(filePath, cwd) {
  try {
    const rel = path.relative(cwd, filePath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
    return rel.split(path.sep).join('/');
  } catch {
    return filePath;
  }
}

function isInsideProject(filePath, cwd) {
  try {
    const rel = path.relative(cwd, filePath).split(path.sep).join('/');
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export {
  shellCommand,
  shellWriteDestination,
  shellCopiedFileContent,
  shellHereDocContent,
  shellPythonWriteContent,
  relativePath,
  isInsideProject,
};
