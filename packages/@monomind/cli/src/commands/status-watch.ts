import { output } from '../output.js';
import type { CommandResult } from '../types.js';
import { displayStatus } from './status-display.js';
import { getSystemStatus } from './status-system.js';

// Watch mode - continuous status updates
export async function watchStatus(intervalSeconds: number, cwd: string): Promise<CommandResult> {
  output.writeln();
  output.writeln(output.bold('Watch Mode'));
  output.writeln(output.dim(`Refreshing every ${intervalSeconds}s. Press Ctrl+C to exit.`));
  output.writeln();

  const refresh = async () => {
    // Clear screen
    process.stdout.write('\x1b[2J\x1b[H');

    output.writeln(output.dim(`Last updated: ${new Date().toLocaleTimeString()}`));
    output.writeln();

    const status = await getSystemStatus(cwd);
    await displayStatus(status);
  };

  // Initial display
  await refresh();

  // Set up interval
  const intervalId = setInterval(refresh, intervalSeconds * 1000);

  // Handle exit — use once so repeated calls to watchStatus don't accumulate
  // SIGINT handlers (which would trigger a MaxListenersExceededWarning).
  return new Promise((resolve) => {
    const onSigint = () => {
      clearInterval(intervalId);
      output.writeln();
      output.printInfo('Watch mode stopped');
      resolve({ success: true });
    };
    process.once('SIGINT', onSigint);
  });
}
