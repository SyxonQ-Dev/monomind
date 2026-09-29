import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';

// Regression (issue #91): the graph report used to be generated inside the
// open build transaction via the string overload of generateGraphReport,
// which opens a SECOND DB connection. In WAL mode that connection only sees
// the last committed snapshot, so GRAPH_REPORT.md was always one build stale —
// on the very first build it rendered a completely empty graph. The report is
// now generated after COMMIT.
const tmpRepo = join(tmpdir(), `monograph-report-freshness-${Date.now()}`);

beforeAll(() => {
  mkdirSync(join(tmpRepo, 'src'), { recursive: true });
  writeFileSync(join(tmpRepo, 'src', 'greeter.ts'), `
export interface Greeter {
  greet(name: string): string;
}
export class GreeterImpl implements Greeter {
  greet(name: string): string {
    return 'hello ' + name;
  }
}
  `);
});

afterAll(() => rmSync(tmpRepo, { recursive: true, force: true }));

describe('graph report freshness — report reflects the build that produced it', () => {
  it('first build writes a report with the actual node count, not an empty snapshot', async () => {
    const { buildAsync } = await import('../../src/pipeline/orchestrator.js');
    await buildAsync(tmpRepo);

    // #414: the report goes under .monomind/, not into the user's repo root.
    const reportPath = join(tmpRepo, '.monomind', 'GRAPH_REPORT.md');
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(join(tmpRepo, 'GRAPH_REPORT.md'))).toBe(false);

    const { openDb, closeDb } = await import('../../src/storage/db.js');
    const { countNodes } = await import('../../src/storage/node-store.js');
    const db = openDb(join(tmpRepo, '.monomind', 'monograph.db'));
    let nodeCount: number;
    try {
      nodeCount = countNodes(db);
    } finally {
      closeDb(db);
    }
    expect(nodeCount).toBeGreaterThan(0);

    const report = readFileSync(reportPath, 'utf8');
    // The report's overview table must reflect the just-committed build,
    // not the previous (here: nonexistent) snapshot.
    expect(report).toContain(`| Total nodes | ${nodeCount} |`);
  }, 60000);
});

describe('graph report location (#414)', () => {
  const reset = () => {
    rmSync(join(tmpRepo, '.monomind'), { recursive: true, force: true });
    rmSync(join(tmpRepo, 'GRAPH_REPORT.md'), { force: true });
  };

  it('reportPath writes the report where asked, relative to the repo', async () => {
    reset();
    const { buildAsync } = await import('../../src/pipeline/orchestrator.js');
    await buildAsync(tmpRepo, { reportPath: 'GRAPH_REPORT.md' });
    expect(existsSync(join(tmpRepo, 'GRAPH_REPORT.md'))).toBe(true);
    expect(existsSync(join(tmpRepo, '.monomind', 'GRAPH_REPORT.md'))).toBe(false);
  }, 60000);

  it('MONOGRAPH_REPORT_PATH sets the location when no option is passed', async () => {
    reset();
    const { buildAsync } = await import('../../src/pipeline/orchestrator.js');
    process.env.MONOGRAPH_REPORT_PATH = 'docs-out/report.md';
    try {
      await buildAsync(tmpRepo);
    } finally {
      delete process.env.MONOGRAPH_REPORT_PATH;
    }
    expect(existsSync(join(tmpRepo, 'docs-out', 'report.md'))).toBe(true);
    expect(existsSync(join(tmpRepo, '.monomind', 'GRAPH_REPORT.md'))).toBe(false);
  }, 60000);
});
