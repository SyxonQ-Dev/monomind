// #583: Chrome's first launch on a cold Windows runner can miss the CDP-port
// deadline. launchWithColdStartRetry gives a timed-out launch one more try in a
// fresh profile dir. These tests drive it with a fake launcher, no Chrome.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { launchWithColdStartRetry } from '../cli/engine/engines/browser/drivers.mjs';

function fakeLauncher(outcomes) {
  const calls = [];
  const launch = async (config) => {
    calls.push({ ...config, dirExisted: fs.existsSync(config.userDataDir) });
    const outcome = outcomes[calls.length - 1];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { launch, calls };
}

const portTimeout = () =>
  new Error('Chrome did not report a CDP port in C:\\Temp\\monodesign-cdp-x\\DevToolsActivePort within 30000ms');

describe('launchWithColdStartRetry', () => {
  it('retries a CDP-port timeout once in a fresh profile dir and drops the first dir', async () => {
    const { launch, calls } = fakeLauncher([portTimeout(), 45123]);
    const config = { port: 0, headless: true, args: [], launchTimeoutMs: 30000 };

    const result = await launchWithColdStartRetry(launch, config);

    assert.equal(calls.length, 2);
    assert.equal(result.port, 45123);
    assert.ok(calls.every((call) => call.dirExisted), 'each attempt gets an existing profile dir');
    assert.notEqual(calls[0].userDataDir, calls[1].userDataDir);
    assert.equal(fs.existsSync(calls[0].userDataDir), false, 'timed-out attempt profile dir removed');
    assert.equal(result.userDataDir, calls[1].userDataDir);
    assert.equal(fs.existsSync(result.userDataDir), true, 'winning profile dir kept for the browser');
    for (const call of calls) {
      assert.equal(call.port, 0);
      assert.equal(call.launchTimeoutMs, 30000);
    }
    fs.rmSync(result.userDataDir, { recursive: true, force: true });
  });

  it('retries a forced-port launch timeout too', async () => {
    const { launch, calls } = fakeLauncher([new Error('Chrome failed to start on port 9555 within 30000ms'), 9555]);
    const result = await launchWithColdStartRetry(launch, { port: 9555 });
    assert.equal(calls.length, 2);
    assert.equal(result.port, 9555);
    fs.rmSync(result.userDataDir, { recursive: true, force: true });
  });

  it('gives up after the second timeout and leaves no profile dir behind', async () => {
    const { launch, calls } = fakeLauncher([portTimeout(), portTimeout(), 1]);
    await assert.rejects(launchWithColdStartRetry(launch, { port: 0 }), /did not report a CDP port/);
    assert.equal(calls.length, 2);
    for (const call of calls) assert.equal(fs.existsSync(call.userDataDir), false);
  });

  it('does not retry other launch failures', async () => {
    const { launch, calls } = fakeLauncher([
      new Error('Chrome exited before the CDP endpoint opened on port 0 (code=1, signal=null)'),
      1,
    ]);
    await assert.rejects(launchWithColdStartRetry(launch, { port: 0 }), /exited before the CDP endpoint/);
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(calls[0].userDataDir), false);
  });
});
