import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { scanSourceFiles } from './analyze.js';

// Code subcommand
export const codeCommand: Command = {
  name: 'code',
  description: 'Static code analysis and quality assessment',
  options: [
    { name: 'path', short: 'p', type: 'string', description: 'Path to analyze', default: '.' },
    {
      name: 'type',
      short: 't',
      type: 'string',
      description: 'Analysis type: quality, complexity, security',
      default: 'quality',
    },
    {
      name: 'format',
      short: 'f',
      type: 'string',
      description: 'Output format: text, json',
      default: 'text',
    },
  ],
  examples: [
    { command: 'monomind analyze code -p ./src', description: 'Analyze source directory' },
    { command: 'monomind analyze code --type complexity', description: 'Run complexity analysis' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const targetPath = resolve((ctx.flags.path as string) || '.');
    const analysisType = (ctx.flags.type as string) || 'quality';
    const formatJson = (ctx.flags.format as string) === 'json';

    output.writeln();
    output.writeln(output.bold('Code Analysis'));
    output.writeln(output.dim('-'.repeat(50)));

    const spinner = output.createSpinner({ text: `Analyzing ${targetPath}...`, spinner: 'dots' });
    spinner.start();

    try {
      const files = await scanSourceFiles(targetPath);
      if (files.length === 0) {
        spinner.stop();
        output.printWarning('No source files found');
        return { success: true };
      }

      const fileStats: Array<{
        file: string;
        loc: number;
        todos: number;
        functions: number;
        imports: number;
        maxNesting: number;
        securityIssues: string[];
      }> = [];

      for (const filePath of files) {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const nonEmpty = lines.filter(
          (l) => l.trim().length > 0 && !/^\s*(\/\/|\/\*|\*\s|#)/.test(l),
        ).length;
        const todos = (content.match(/\b(TODO|FIXME|HACK|XXX)\b/gi) || []).length;
        const fns = (
          content.match(
            /(?:export\s+)?(?:async\s+)?function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
          ) || []
        ).length;
        const imps =
          (content.match(/^import\s+/gm) || []).length +
          (content.match(/require\s*\(/g) || []).length;

        let maxNesting = 0;
        let nesting = 0;
        for (const line of lines) {
          nesting += (line.match(/\{/g) || []).length;
          nesting -= (line.match(/\}/g) || []).length;
          if (nesting > maxNesting) maxNesting = nesting;
        }

        const securityIssues: string[] = [];
        if (/\beval\s*\(/.test(content)) securityIssues.push('eval()');
        if (/\bexec\s*\(/.test(content)) securityIssues.push('exec()');
        if (/\.innerHTML\s*=/.test(content)) securityIssues.push('innerHTML');
        if (/dangerouslySetInnerHTML/.test(content)) securityIssues.push('dangerouslySetInnerHTML');
        if (/['"](?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{3,}['"]/i.test(content))
          securityIssues.push('hardcoded secret');
        if (/new\s+Function\s*\(/.test(content)) securityIssues.push('new Function()');

        fileStats.push({
          file: filePath,
          loc: nonEmpty,
          todos,
          functions: fns,
          imports: imps,
          maxNesting,
          securityIssues,
        });
      }

      spinner.stop();

      const totalLoc = fileStats.reduce((s, f) => s + f.loc, 0);
      const totalTodos = fileStats.reduce((s, f) => s + f.todos, 0);
      const totalFunctions = fileStats.reduce((s, f) => s + f.functions, 0);
      const totalImports = fileStats.reduce((s, f) => s + f.imports, 0);
      const avgFileSize = Math.round(totalLoc / files.length);
      const longestFile = fileStats.reduce((a, b) => (a.loc > b.loc ? a : b));
      const avgFnPerFile = (totalFunctions / files.length).toFixed(1);
      const deepestNesting = fileStats.reduce((a, b) => (a.maxNesting > b.maxNesting ? a : b));
      const allSecurityIssues = fileStats.filter((f) => f.securityIssues.length > 0);

      if (formatJson) {
        const jsonData = {
          type: analysisType,
          path: targetPath,
          files: files.length,
          totalLoc,
          totalTodos,
          totalFunctions,
          totalImports,
          avgFileSize,
          fileStats: fileStats.map((f) => ({
            relativePath: path.relative(targetPath, f.file),
            loc: f.loc,
            todos: f.todos,
            functions: f.functions,
            imports: f.imports,
            maxNesting: f.maxNesting,
            securityIssues: f.securityIssues,
          })),
        };
        output.printJson(jsonData);
        return { success: true, data: jsonData };
      }

      if (analysisType === 'quality') {
        output.printBox(
          [
            `Files: ${files.length}`,
            `Lines of Code: ${totalLoc.toLocaleString()}`,
            `Avg File Size: ${avgFileSize} LOC`,
            `TODO/FIXME: ${totalTodos}`,
            `Functions: ${totalFunctions}`,
            `Imports: ${totalImports}`,
          ].join('\n'),
          'Quality Summary',
        );
        output.writeln();
        output.writeln(output.bold('Largest Files'));
        output.writeln(output.dim('-'.repeat(60)));
        const top10 = [...fileStats].sort((a, b) => b.loc - a.loc).slice(0, 10);
        output.printTable({
          columns: [
            { key: 'file', header: 'File', width: 45 },
            { key: 'loc', header: 'LOC', width: 8, align: 'right' as const },
            { key: 'fns', header: 'Fns', width: 6, align: 'right' as const },
            { key: 'todos', header: 'TODOs', width: 7, align: 'right' as const },
          ],
          data: top10.map((f) => ({
            file: path.relative(targetPath, f.file),
            loc: f.loc,
            fns: f.functions,
            todos: f.todos,
          })),
        });
        if (totalTodos > 0) {
          output.writeln();
          output.printWarning(
            `${totalTodos} TODO/FIXME comments found across ${fileStats.filter((f) => f.todos > 0).length} files`,
          );
        }
      } else if (analysisType === 'complexity') {
        output.printBox(
          [
            `Files: ${files.length}`,
            `Total Functions: ${totalFunctions}`,
            `Avg Functions/File: ${avgFnPerFile}`,
            `Deepest Nesting: ${deepestNesting.maxNesting} levels (${path.relative(targetPath, deepestNesting.file)})`,
            `Longest File: ${longestFile.loc} LOC (${path.relative(targetPath, longestFile.file)})`,
          ].join('\n'),
          'Complexity Summary',
        );
        output.writeln();
        output.writeln(output.bold('High Complexity Files (nesting > 5)'));
        output.writeln(output.dim('-'.repeat(60)));
        const complex = fileStats
          .filter((f) => f.maxNesting > 5)
          .sort((a, b) => b.maxNesting - a.maxNesting);
        if (complex.length === 0) {
          output.printSuccess('No files with excessive nesting detected');
        } else {
          output.printTable({
            columns: [
              { key: 'file', header: 'File', width: 45 },
              { key: 'nesting', header: 'Max Nest', width: 10, align: 'right' as const },
              { key: 'fns', header: 'Fns', width: 6, align: 'right' as const },
              { key: 'loc', header: 'LOC', width: 8, align: 'right' as const },
            ],
            data: complex.slice(0, 15).map((f) => ({
              file: path.relative(targetPath, f.file),
              nesting: f.maxNesting,
              fns: f.functions,
              loc: f.loc,
            })),
          });
        }
      } else if (analysisType === 'security') {
        output.printBox(
          [
            `Files Scanned: ${files.length}`,
            `Files with Issues: ${allSecurityIssues.length}`,
            `Total Issues: ${allSecurityIssues.reduce((s, f) => s + f.securityIssues.length, 0)}`,
          ].join('\n'),
          'Security Summary',
        );
        if (allSecurityIssues.length === 0) {
          output.writeln();
          output.printSuccess('No common security patterns detected');
        } else {
          output.writeln();
          output.writeln(output.bold('Security Concerns'));
          output.writeln(output.dim('-'.repeat(60)));
          output.printTable({
            columns: [
              { key: 'file', header: 'File', width: 40 },
              { key: 'issues', header: 'Issues', width: 35 },
            ],
            data: allSecurityIssues.map((f) => ({
              file: path.relative(targetPath, f.file),
              issues: f.securityIssues.join(', '),
            })),
          });
        }
      } else {
        output.printWarning(
          `Unknown analysis type: ${analysisType}. Use quality, complexity, or security.`,
        );
      }

      return { success: true };
    } catch (error) {
      spinner.stop();
      const message = error instanceof Error ? error.message : String(error);
      output.printError(`Code analysis failed: ${message}`);
      return { success: false, exitCode: 1 };
    }
  },
};
