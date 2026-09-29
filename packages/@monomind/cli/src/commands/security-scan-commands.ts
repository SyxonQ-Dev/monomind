import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { findCodePatternsInDir } from './security-scan-code-patterns.js';
import { exportHealthSarif, findingsToSarif } from './security-scan-sarif.js';
import {
  createScanCoverage,
  describeScanGaps,
  findSecretsInDir,
  type SecretFinding,
  scanHadErrors,
} from './security-scan-secrets.js';

// ─── scan subcommand ─────────────────────────────────────────────────────────

export const scanCommand: Command = {
  name: 'scan',
  description: 'Run security scan on target (code, dependencies)',
  options: [
    {
      name: 'target',
      short: 't',
      type: 'string',
      description: 'Target path to scan',
      default: '.',
    },
    {
      name: 'depth',
      short: 'd',
      type: 'string',
      description: 'Scan depth: quick, standard, deep',
      default: 'standard',
    },
    { name: 'type', type: 'string', description: 'Scan type: code, deps, all', default: 'all' },
    {
      name: 'output',
      short: 'o',
      type: 'string',
      description: 'Output format: text, json, sarif',
      default: 'text',
    },
    {
      name: 'fix',
      short: 'f',
      type: 'boolean',
      description: 'Auto-fix vulnerabilities where possible',
    },
  ],
  examples: [
    { command: 'monomind security scan -t ./src', description: 'Scan source directory' },
    {
      command: 'monomind security scan --depth deep --fix',
      description: 'Deep scan with auto-fix',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // -o json|sarif: stdout carries only the document (#495).
    const machine = ctx.flags.output === 'json' || ctx.flags.output === 'sarif';
    return output.reserveStdout(machine, () => runScan(ctx));
  },
};

async function runScan(ctx: CommandContext): Promise<CommandResult> {
  const target = (ctx.flags.target as string) || '.';
  const depth = (ctx.flags.depth as string) || 'standard';
  const scanType = (ctx.flags.type as string) || 'all';
  const fix = ctx.flags.fix as boolean;
  const rawOutputFormat = (ctx.flags.output as string) || 'text';
  const outputFormat =
    rawOutputFormat === 'json' || rawOutputFormat === 'sarif' ? rawOutputFormat : 'text';

  if (scanType === 'container') {
    output.printError('container scanning is not implemented — no container engine exists');
    return { success: false };
  }

  if (target !== '.') {
    try {
      const resolvedTgt = realpathSync(resolve(target));
      const cwd = realpathSync(process.cwd());
      if (!resolvedTgt.startsWith(cwd + sep) && resolvedTgt !== cwd) {
        output.printError('--target must be within the current working directory');
        return { success: false };
      }
    } catch {
      output.printError(`--target path does not exist or is not accessible: ${target}`);
      return { success: false };
    }
  }

  if (!output.isQuiet()) {
    output.writeln();
    output.writeln(output.bold('Security Scan'));
    output.writeln(output.dim('─'.repeat(50)));
  }

  const spinner = output.createSpinner({ text: `Scanning ${target}...`, spinner: 'dots' });
  spinner.start();

  const findings: Array<{
    severity: string;
    type: string;
    location: string;
    description: string;
    rawSeverity: 'critical' | 'high' | 'medium' | 'low';
  }> = [];
  const coverage = createScanCoverage();
  let criticalCount = 0,
    highCount = 0,
    mediumCount = 0,
    lowCount = 0;

  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { execSync } = await import('node:child_process');

    if (scanType === 'all' || scanType === 'deps') {
      spinner.setText('Checking dependencies with npm audit...');
      try {
        const packageJsonPath = path.resolve(target, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          let auditResult: string;
          try {
            auditResult = execSync('npm audit --json', {
              cwd: path.resolve(target),
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 30_000,
            });
          } catch (auditErr: any) {
            auditResult = auditErr.stdout || '{}';
          }

          try {
            const audit = JSON.parse(auditResult);
            if (audit.vulnerabilities) {
              for (const [pkg, vuln] of Object.entries(
                audit.vulnerabilities as Record<
                  string,
                  { severity: string; via: Array<string | { title?: string; url?: string }> }
                >,
              )) {
                const sev = vuln.severity || 'low';
                const firstVia = Array.isArray(vuln.via) ? vuln.via[0] : undefined;
                const title =
                  firstVia && typeof firstVia === 'object' && firstVia.title
                    ? firstVia.title
                    : 'Vulnerability';
                if (sev === 'critical') criticalCount++;
                else if (sev === 'high') highCount++;
                else if (sev === 'moderate' || sev === 'medium') mediumCount++;
                else lowCount++;

                findings.push({
                  severity:
                    sev === 'critical'
                      ? output.error('CRITICAL')
                      : sev === 'high'
                        ? output.warning('HIGH')
                        : sev === 'moderate' || sev === 'medium'
                          ? output.warning('MEDIUM')
                          : output.info('LOW'),
                  type: 'Dependency CVE',
                  location: `package.json:${pkg}`,
                  description: title.substring(0, 35),
                  rawSeverity:
                    sev === 'critical'
                      ? 'critical'
                      : sev === 'high'
                        ? 'high'
                        : sev === 'moderate' || sev === 'medium'
                          ? 'medium'
                          : 'low',
                });
              }
            }
          } catch (e) {
            /* JSON parse failed */ if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
              console.error('[security-scan] failed to parse npm audit output:', e);
          }
        }
      } catch (e) {
        /* npm audit failed */ if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
          console.error('[security-scan] dependency check failed:', e);
      }
    }

    if (scanType === 'all' || scanType === 'code') {
      spinner.setText('Scanning for hardcoded secrets...');
      const scanDepth = depth === 'deep' ? 10 : depth === 'standard' ? 5 : 3;
      const prevCount = findings.length;
      findSecretsInDir(path.resolve(target), scanDepth, path.resolve(target), findings, coverage);
      highCount += findings.length - prevCount;
    }

    if ((scanType === 'all' || scanType === 'code') && depth !== 'quick') {
      spinner.setText('Analyzing code patterns...');
      const codeScanDepth = depth === 'deep' ? 10 : 5;
      const prevFindingsLength = findings.length;
      findCodePatternsInDir(
        path.resolve(target),
        codeScanDepth,
        path.resolve(target),
        findings,
        coverage,
      );
      for (const f of findings.slice(prevFindingsLength)) {
        if (f.rawSeverity === 'high') highCount++;
        else if (f.rawSeverity === 'medium') mediumCount++;
      }
    }

    const gaps = describeScanGaps(coverage);
    if (gaps.length > 0) {
      spinner.stop(output.warning('Scan finished with INCOMPLETE coverage'));
    } else {
      spinner.complete('Scan complete');
    }

    output.writeln();
    if (outputFormat === 'json') {
      const jsonPayload = {
        target,
        depth,
        type: scanType,
        findings: findings.map((f) => ({
          severity: f.rawSeverity,
          type: f.type,
          location: f.location,
          description: f.description,
        })),
        summary: {
          critical: criticalCount,
          high: highCount,
          medium: mediumCount,
          low: lowCount,
          total: findings.length,
        },
        coverage: {
          filesScanned: coverage.filesScanned,
          dirsScanned: coverage.dirsScanned,
          complete: gaps.length === 0,
          gaps,
        },
      };
      output.printDocument(jsonPayload);
    } else if (outputFormat === 'sarif') {
      const sarifDoc = exportHealthSarif(findingsToSarif(findings), resolve(target));
      output.printDocument(sarifDoc);
    } else if (findings.length > 0) {
      output.printTable({
        columns: [
          { key: 'severity', header: 'Severity', width: 12 },
          { key: 'type', header: 'Type', width: 18 },
          { key: 'location', header: 'Location', width: 25 },
          { key: 'description', header: 'Description', width: 35 },
        ],
        data: findings.slice(0, 20),
      });
      if (findings.length > 20)
        output.writeln(output.dim(`... and ${findings.length - 20} more issues`));
    } else if (gaps.length > 0) {
      // Never present an incomplete scan as a clean bill of health.
      output.writeln(
        output.warning(
          'No security issues found in the parts that could be scanned — coverage was INCOMPLETE (see below).',
        ),
      );
    } else {
      output.writeln(output.success('No security issues found!'));
    }

    if (outputFormat === 'text') {
      if (gaps.length > 0) {
        output.writeln();
        output.writeln(output.warning('Incomplete coverage:'));
        for (const g of gaps) output.writeln(output.warning(`  - ${g}`));
      }

      output.writeln();
      output.printBox(
        [
          `Target: ${target}`,
          `Depth: ${depth}`,
          `Type: ${scanType}`,
          ``,
          `Critical: ${criticalCount}  High: ${highCount}  Medium: ${mediumCount}  Low: ${lowCount}`,
          `Total Issues: ${findings.length}`,
          ``,
          `Coverage: ${coverage.filesScanned} file(s) in ${coverage.dirsScanned} dir(s) scanned`,
          `Coverage status: ${gaps.length === 0 ? 'complete' : `INCOMPLETE (${gaps.length} gap type(s))`}`,
        ].join('\n'),
        'Scan Summary',
      );
    }

    if (fix && criticalCount + highCount > 0) {
      const resolvedTarget = realpathSync(path.resolve(target));
      const cwd = realpathSync(process.cwd());
      if (!resolvedTarget.startsWith(cwd + path.sep) && resolvedTarget !== cwd) {
        output.writeln();
        output.printError(
          '--fix is only allowed when --target is within the current working directory',
        );
        return { success: false };
      }
      output.writeln();
      const fixSpinner = output.createSpinner({
        text: 'Attempting to fix vulnerabilities...',
        spinner: 'dots',
      });
      fixSpinner.start();
      try {
        execSync('npm audit fix', {
          cwd: resolvedTarget,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        fixSpinner.succeed('completed (verify with a re-scan)');
      } catch (fixErr) {
        // npm audit fix exits non-zero when it can't resolve everything
        // automatically — surface that instead of reporting success.
        const status = (fixErr as { status?: number })?.status;
        fixSpinner.fail(
          `npm audit fix exited with ${status ?? 'an error'} — some fixes could not be applied automatically (verify with a re-scan)`,
        );
      }
    }

    // A scan that hit real read errors cannot certify anything — fail loudly.
    // Depth truncation is a configured limit, not an error, so it is reported
    // above but does not by itself flip the exit status.
    if (scanHadErrors(coverage)) return { success: false };
    return { success: findings.length === 0 || (criticalCount === 0 && highCount === 0) };
  } catch (error) {
    spinner.fail('Scan failed');
    output.printError(`Error: ${error}`);
    return { success: false };
  }
}

// ─── secrets subcommand ──────────────────────────────────────────────────────

export const secretsCommand: Command = {
  name: 'secrets',
  description: 'Detect hardcoded secrets in codebase',
  options: [
    { name: 'path', short: 'p', type: 'string', description: 'Path to scan', default: '.' },
    {
      name: 'depth',
      short: 'd',
      type: 'string',
      description: 'Scan depth: quick, standard, deep',
      default: 'standard',
    },
  ],
  examples: [
    { command: 'monomind security secrets', description: 'Scan current directory for secrets' },
    {
      command: 'monomind security secrets -p ./src --depth deep',
      description: 'Deep scan of src directory',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const targetPath = (ctx.flags.path as string) || '.';
    const depth = (ctx.flags.depth as string) || 'standard';

    if (targetPath !== '.') {
      try {
        const resolvedTgt = realpathSync(resolve(targetPath));
        const cwd = realpathSync(process.cwd());
        if (!resolvedTgt.startsWith(cwd + sep) && resolvedTgt !== cwd) {
          output.printError('--path must be within the current working directory');
          return { success: false };
        }
      } catch {
        output.printError(`--path does not exist or is not accessible: ${targetPath}`);
        return { success: false };
      }
    }

    output.writeln();
    output.writeln(output.bold('Secret Detection'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: `Scanning ${targetPath}...`, spinner: 'dots' });
    spinner.start();

    const findings: SecretFinding[] = [];
    const coverage = createScanCoverage();
    const scanDepth = depth === 'deep' ? 10 : depth === 'standard' ? 5 : 3;
    findSecretsInDir(resolve(targetPath), scanDepth, resolve(targetPath), findings, coverage);

    const gaps = describeScanGaps(coverage);
    if (gaps.length > 0) {
      spinner.stop(output.warning('Scan finished with INCOMPLETE coverage'));
    } else {
      spinner.complete('Scan complete');
    }

    output.writeln();
    if (findings.length === 0 && gaps.length > 0) {
      output.writeln(
        output.warning(
          'No secrets found in the parts that could be scanned — coverage was INCOMPLETE.',
        ),
      );
    } else if (findings.length === 0) {
      output.writeln(output.success('No secrets found.'));
    } else {
      output.printTable({
        columns: [
          { key: 'severity', header: 'Severity', width: 12 },
          { key: 'description', header: 'Description', width: 25 },
          { key: 'location', header: 'Location', width: 40 },
        ],
        data: findings.slice(0, 20),
      });
      if (findings.length > 20) output.writeln(output.dim(`... and ${findings.length - 20} more`));
    }

    if (gaps.length > 0) {
      output.writeln();
      output.writeln(output.warning('Incomplete coverage:'));
      for (const g of gaps) output.writeln(output.warning(`  - ${g}`));
    }

    output.writeln();
    output.writeln(
      output.bold('Summary: ') +
        `${findings.length} secret(s) found in ${targetPath} ` +
        `(${coverage.filesScanned} file(s) in ${coverage.dirsScanned} dir(s) scanned, ` +
        `coverage ${gaps.length === 0 ? 'complete' : 'INCOMPLETE'})`,
    );

    // Read errors mean the tree was not fully examined — "no secrets" is not
    // a result we can stand behind, so do not exit 0 on it.
    return { success: findings.length === 0 && !scanHadErrors(coverage) };
  },
};
