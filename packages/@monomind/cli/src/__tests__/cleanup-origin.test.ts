// packages/@monomind/cli/src/__tests__/cleanup-origin.test.ts
//
// The deleted-vs-unmounted rule behind `cleanup --data` (#347), exercised
// against a fake filesystem so mount points can be modelled by st_dev.

import { describe, expect, it } from 'vitest';
import { isProvablyDeleted, type OriginFs } from '../commands/cleanup-origin.js';

/** Fake fs: existing paths mapped to their st_dev; `null` = exists but stat fails. */
function fakeFs(devs: Record<string, number | null>): OriginFs {
  return {
    exists: (p) => p in devs,
    dev: (p) => {
      const d = devs[p];
      if (d === undefined || d === null) throw new Error(`ENOENT/EACCES: ${p}`);
      return d;
    },
  };
}

const ROOTS = ['/home/u', '/tmp', '/var/tmp'];

describe('isProvablyDeleted (#347)', () => {
  it('an origin that still exists is not deleted', () => {
    const fs = fakeFs({ '/': 1, '/data': 1, '/data/proj': 1 });
    expect(isProvablyDeleted('/data/proj', fs, ROOTS)).toBe(false);
  });

  it('origin gone but its parent exists → deleted (the old rule)', () => {
    const fs = fakeFs({ '/': 1, '/data': 1 });
    expect(isProvablyDeleted('/data/proj', fs, ROOTS)).toBe(true);
  });

  it('parent deleted too, grandparent on the same device as its parent → deleted', () => {
    const fs = fakeFs({ '/': 1, '/data': 1, '/data/work': 1 });
    expect(isProvablyDeleted('/data/work/fx-init/agent-ops-test-x', fs, ROOTS)).toBe(true);
  });

  it('nearest existing ancestor is a mount point → kept (volume may be unmounted)', () => {
    // /srv/nas is its own filesystem; /srv/nas/team is missing
    const fs = fakeFs({ '/': 1, '/srv': 1, '/srv/nas': 7 });
    expect(isProvablyDeleted('/srv/nas/team/proj', fs, ROOTS)).toBe(false);
  });

  it('nearest existing ancestor is / → kept', () => {
    const fs = fakeFs({ '/': 1 });
    expect(isProvablyDeleted('/no-such-root/a/proj', fs, ROOTS)).toBe(false);
  });

  it('origin under a tmpfs /tmp whose nearest existing ancestor is /tmp → deleted', () => {
    const fs = fakeFs({ '/': 1, '/tmp': 9 }); // /tmp is its own mount
    expect(isProvablyDeleted('/tmp/fx-init/x/proj', fs, ROOTS)).toBe(true);
  });

  it('home or /var/tmp as the nearest existing ancestor → deleted even when a mount', () => {
    const fs = fakeFs({ '/': 1, '/home': 1, '/home/u': 4, '/var': 1, '/var/tmp': 5 });
    expect(isProvablyDeleted('/home/u/scratch/vitest-tmp/p', fs, ROOTS)).toBe(true);
    expect(isProvablyDeleted('/var/tmp/fx-init/x/proj', fs, ROOTS)).toBe(true);
  });

  it('a mount point below a local root still keeps its missing children', () => {
    // /home/u/nas is a mounted share: the root exception is only for the root itself
    const fs = fakeFs({ '/': 1, '/home': 1, '/home/u': 1, '/home/u/nas': 8 });
    expect(isProvablyDeleted('/home/u/nas/team/proj', fs, ROOTS)).toBe(false);
  });

  it('removable-media directories are kept even when not mount points', () => {
    const fs = fakeFs({ '/': 1, '/media': 1, '/run': 1, '/run/media': 1, '/run/media/u': 1 });
    expect(isProvablyDeleted('/media/usb/proj/x', fs, ROOTS)).toBe(false);
    expect(isProvablyDeleted('/run/media/u/DISK/proj/x', fs, ROOTS)).toBe(false);
  });

  it('an ancestor that cannot be stat-ed is treated as a mount point → kept', () => {
    const fs = fakeFs({ '/': 1, '/data': null });
    expect(isProvablyDeleted('/data/work/fx/proj', fs, ROOTS)).toBe(false);
  });
});
