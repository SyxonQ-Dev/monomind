/**
 * CLI Output Formatter
 * Advanced output formatting with tables, progress bars, and colors
 */

import { Writable } from 'node:stream';
import { Progress } from './output-progress.js';
import { Spinner } from './output-spinner.js';
import { renderTable, stripAnsi } from './output-table.js';
import type { ProgressOptions, SpinnerOptions, TableOptions } from './types.js';

export { Progress } from './output-progress.js';
export { Spinner } from './output-spinner.js';

// ============================================
// Color Support
// ============================================

const COLORS = {
  // Standard colors
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright foreground colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
} as const;

type ColorName = keyof typeof COLORS;

export type VerbosityLevel = 'quiet' | 'normal' | 'verbose' | 'debug';

export class OutputFormatter {
  private colorEnabled: boolean;
  private outputStream: NodeJS.WriteStream;
  private errorStream: NodeJS.WriteStream;
  private verbosity: VerbosityLevel;

  constructor(options: { color?: boolean; verbosity?: VerbosityLevel } = {}) {
    this.colorEnabled = options.color ?? this.supportsColor();
    this.outputStream = process.stdout;
    this.errorStream = process.stderr;
    this.verbosity = options.verbosity ?? 'normal';
  }

  /**
   * Set verbosity level
   * - quiet: Only errors and direct results
   * - normal: Errors, warnings, info, and results
   * - verbose: All of normal + debug messages
   * - debug: All output including trace
   */
  setVerbosity(level: VerbosityLevel): void {
    this.verbosity = level;
  }

  getVerbosity(): VerbosityLevel {
    return this.verbosity;
  }

  isQuiet(): boolean {
    return this.verbosity === 'quiet';
  }

  isVerbose(): boolean {
    return this.verbosity === 'verbose' || this.verbosity === 'debug';
  }

  isDebug(): boolean {
    return this.verbosity === 'debug';
  }

  private supportsColor(): boolean {
    // Check for NO_COLOR environment variable
    if (process.env.NO_COLOR !== undefined) return false;

    // Check for FORCE_COLOR environment variable.
    // Per the supports-color convention, FORCE_COLOR=0 (or "false") forces
    // color OFF; any other defined, non-empty value forces color ON.
    if (process.env.FORCE_COLOR !== undefined) {
      return process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
    }

    // Check if stdout is a TTY
    return process.stdout.isTTY ?? false;
  }

  // ============================================
  // Color Methods
  // ============================================

  color(text: string, ...colors: ColorName[]): string {
    if (!this.colorEnabled) return text;

    const codes = colors.map((c) => COLORS[c]).join('');
    return `${codes}${text}${COLORS.reset}`;
  }

  bold(text: string): string {
    return this.color(text, 'bold');
  }

  dim(text: string): string {
    return this.color(text, 'dim');
  }

  success(text: string): string {
    return this.color(text, 'green');
  }

  error(text: string): string {
    return this.color(text, 'red');
  }

  warning(text: string): string {
    return this.color(text, 'yellow');
  }

  info(text: string): string {
    return this.color(text, 'blue');
  }

  highlight(text: string): string {
    return this.color(text, 'cyan', 'bold');
  }

  // ============================================
  // Output Methods
  // ============================================

  /**
   * Point regular output at another stream (e.g. stderr while a command
   * reserves stdout for its JSON payload). Returns the previous stream so
   * the caller can restore it.
   */
  setOutputStream(stream: NodeJS.WriteStream): NodeJS.WriteStream {
    const previous = this.outputStream;
    this.outputStream = stream;
    return previous;
  }

  /**
   * Run `fn` with stdout reserved for a machine-readable document
   * (`-o json|sarif`, `--json`): regular output goes to stderr meanwhile, or
   * nowhere under --quiet. Print the document itself with printDocument().
   */
  async reserveStdout<T>(reserve: boolean, fn: () => Promise<T>): Promise<T> {
    if (!reserve) return fn();
    const sink = this.isQuiet()
      ? (new Writable({ write: (_c, _e, done) => done() }) as unknown as NodeJS.WriteStream)
      : process.stderr;
    const previous = this.setOutputStream(sink);
    try {
      return await fn();
    } finally {
      this.setOutputStream(previous);
    }
  }

  /** Print a machine-readable document on stdout, even inside reserveStdout(). */
  printDocument(data: unknown): void {
    process.stdout.write(`${this.json(data)}\n`);
  }

  write(text: string): void {
    this.outputStream.write(text);
  }

  writeln(text: string = ''): void {
    this.outputStream.write(`${text}\n`);
  }

  writeError(text: string): void {
    this.errorStream.write(text);
  }

  writeErrorln(text: string = ''): void {
    this.errorStream.write(`${text}\n`);
  }

  // ============================================
  // Formatted Output Methods
  // ============================================

  printSuccess(message: string): void {
    // Success always shows (result output)
    const icon = this.color('[OK]', 'green', 'bold');
    this.writeln(`${icon} ${message}`);
  }

  printError(message: string, details?: string): void {
    // Errors always show
    const icon = this.color('[ERROR]', 'red', 'bold');
    this.writeErrorln(`${icon} ${message}`);
    if (details) {
      this.writeErrorln(this.dim(`  ${details}`));
    }
  }

  printWarning(message: string): void {
    // Warnings suppressed in quiet mode
    if (this.verbosity === 'quiet') return;
    const icon = this.color('[WARN]', 'yellow', 'bold');
    // Write to stderr (not stdout) so it never interleaves with structured
    // stdout output (e.g. --format json | jq .)
    this.writeErrorln(`${icon} ${message}`);
  }

  printInfo(message: string): void {
    // Info suppressed in quiet mode
    if (this.verbosity === 'quiet') return;
    const icon = this.color('[INFO]', 'blue', 'bold');
    // Write to stderr (not stdout) so it never interleaves with structured
    // stdout output (e.g. --format json | jq .)
    this.writeErrorln(`${icon} ${message}`);
  }

  printDebug(message: string): void {
    // Debug only shows in verbose/debug mode
    if (this.verbosity !== 'verbose' && this.verbosity !== 'debug') return;
    const icon = this.color('[DEBUG]', 'gray');
    // stderr, like printInfo: `-v` must not corrupt a --json command's stdout
    this.writeErrorln(`${icon} ${this.dim(message)}`);
  }

  printTrace(message: string): void {
    // Trace only shows in debug mode
    if (this.verbosity !== 'debug') return;
    const icon = this.color('[TRACE]', 'gray', 'dim');
    this.writeErrorln(`${icon} ${this.dim(message)}`);
  }

  // ============================================
  // Table Formatting
  // ============================================

  table(options: TableOptions): string {
    return renderTable(this, options);
  }

  printTable(options: TableOptions): void {
    this.writeln(this.table(options));
  }

  // ============================================
  // Progress Bar
  // ============================================

  createProgress(options: ProgressOptions): Progress {
    return new Progress(this, options);
  }

  progressBar(current: number, total: number, width: number = 40): string {
    const percent = Math.min(100, Math.max(0, (current / total) * 100));
    const filled = Math.round((width * percent) / 100);
    const empty = width - filled;

    const bar = this.color('#'.repeat(filled), 'green') + this.dim('-'.repeat(empty));

    return `[${bar}] ${percent.toFixed(1)}%`;
  }

  // ============================================
  // Spinner
  // ============================================

  createSpinner(options: SpinnerOptions): Spinner {
    return new Spinner(this, options);
  }

  // ============================================
  // JSON Output
  // ============================================

  json(data: unknown, pretty: boolean = true): string {
    return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  }

  printJson(data: unknown, pretty: boolean = true): void {
    this.writeln(this.json(data, pretty));
  }

  // ============================================
  // List Output
  // ============================================

  list(items: string[], bullet: string = '-'): string {
    return items.map((item) => `  ${bullet} ${item}`).join('\n');
  }

  printList(items: string[], bullet: string = '-'): void {
    this.writeln(this.list(items, bullet));
  }

  numberedList(items: string[]): string {
    return items.map((item, i) => `  ${i + 1}. ${item}`).join('\n');
  }

  printNumberedList(items: string[]): void {
    this.writeln(this.numberedList(items));
  }

  // ============================================
  // Box Output
  // ============================================

  box(content: string, title?: string): string {
    const lines = content.split('\n');
    const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length), title?.length ?? 0);
    const width = maxLen + 4;

    const border = {
      topLeft: '+',
      topRight: '+',
      bottomLeft: '+',
      bottomRight: '+',
      horizontal: '-',
      vertical: '|',
    };

    const result: string[] = [];

    // Top border with optional title
    if (title) {
      const titleText = ` ${title} `;
      const leftPad = Math.floor((width - titleText.length - 2) / 2);
      const rightPad = width - titleText.length - leftPad - 2;
      result.push(
        border.topLeft +
          border.horizontal.repeat(leftPad) +
          this.bold(titleText) +
          border.horizontal.repeat(rightPad) +
          border.topRight,
      );
    } else {
      result.push(border.topLeft + border.horizontal.repeat(width - 2) + border.topRight);
    }

    // Content lines
    for (const line of lines) {
      const stripped = stripAnsi(line);
      const padding = maxLen - stripped.length;
      result.push(`${border.vertical} ${line}${' '.repeat(padding)} ${border.vertical}`);
    }

    // Bottom border
    result.push(border.bottomLeft + border.horizontal.repeat(width - 2) + border.bottomRight);

    return result.join('\n');
  }

  printBox(content: string, title?: string): void {
    this.writeln(this.box(content, title));
  }

  setColorEnabled(enabled: boolean): void {
    this.colorEnabled = enabled;
  }

  isColorEnabled(): boolean {
    return this.colorEnabled;
  }
}

// Export singleton instance
export const output = new OutputFormatter();
