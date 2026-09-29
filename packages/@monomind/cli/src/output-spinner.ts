/**
 * CLI Output Formatter — spinner
 *
 * Split out of output.ts (file-size sweep). Pure move: no behaviour change.
 */

import type { OutputFormatter } from './output.js';
import type { SpinnerOptions } from './types.js';

export class Spinner {
  private formatter: OutputFormatter;
  private text: string;
  private frames: string[];
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex: number = 0;

  private static readonly SPINNERS: Record<string, string[]> = {
    dots: ['...', '..:', '.::', ':::', '::.', ':..'],
    line: ['-', '\\', '|', '/'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
    circle: ['◐', '◓', '◑', '◒'],
    arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
  };

  constructor(formatter: OutputFormatter, options: SpinnerOptions) {
    this.formatter = formatter;
    this.text = options.text;
    this.frames = Spinner.SPINNERS[options.spinner ?? 'dots'];
  }

  start(): void {
    if (this.interval) return;
    // Progress is a human line: --quiet drops it.
    if (this.formatter.isQuiet()) return;

    // `\r`-based in-place redraw only works on a real TTY. Without one
    // (piped output, CI logs, non-interactive terminals) each animation
    // frame prints as its own line instead of overwriting the last —
    // so print the text once and skip the animation entirely.
    // Spinner lines are status, not results: they go to stderr (as ora
    // does) so they never land in front of a --format json / -o sarif
    // document on stdout (#495).
    if (!process.stderr.isTTY) {
      this.formatter.writeErrorln(this.text);
      return;
    }

    this.interval = setInterval(() => {
      this.render();
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, 100);
    this.interval.unref();

    this.render();
  }

  stop(message?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;

      // Clear the line (only meaningful when the animation actually ran on a TTY)
      this.formatter.writeError(`\r${' '.repeat(this.text.length + 10)}\r`);
    }

    if (message) {
      this.formatter.writeErrorln(message);
    }
  }

  succeed(message?: string): void {
    this.stop(this.formatter.success(message ?? this.text));
  }

  /** Like succeed(), for a pure progress line ("Scan complete"): --quiet drops it. */
  complete(message?: string): void {
    this.stop(this.formatter.isQuiet() ? undefined : this.formatter.success(message ?? this.text));
  }

  /**
   * Stop and print the command's direct result on regular output (stdout),
   * where it survives --quiet — for commands whose only result is this line.
   */
  result(message: string): void {
    this.stop();
    this.formatter.writeln(this.formatter.success(message));
  }

  fail(message?: string): void {
    this.stop(this.formatter.error(message ?? this.text));
  }

  private render(): void {
    const frame = this.formatter.info(this.frames[this.frameIndex]);
    this.formatter.writeError(`\r${frame} ${this.text}`);
  }

  setText(text: string): void {
    this.text = text;
  }
}
