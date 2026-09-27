/**
 * CLI Design Palette Command
 * OKLCH brand-seed picker — returns one anchor seed color + mood + composition strategy.
 *
 * github.com/monoes/monomind
 */

import { createHash } from 'node:crypto';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { SEEDS_PART_1 } from './design-palette-seeds-1.js';
import { SEEDS_PART_2 } from './design-palette-seeds-2.js';

// ─── Result Types ────────────────────────────────────────────────────────────

export interface PaletteSeed {
  id: string;
  oklch: [number, number, number];
  mood: string;
  strategy: string;
}

export interface DesignPaletteResult {
  seed: PaletteSeed;
  oklchCss: string; // e.g. "oklch(36% 0.137 0)"
  hex?: string; // omitted — compose from oklchCss at runtime if needed
}

// ─── Seed Library (129 hand-curated OKLCH seeds) ─────────────────────────────

// Exported for the monodesign_palette MCP tool (mcp-tools/monodesign-tools.ts).
export const SEEDS: PaletteSeed[] = [...SEEDS_PART_1, ...SEEDS_PART_2];

// ─── Utilities ────────────────────────────────────────────────────────────────

// Hash a key into a stable float in [0, 1) for deterministic weighted picks.
// Hash a key into a stable float in [0, 1) for deterministic weighted picks.
export function hashUnit(key: string): number {
  const h = createHash('sha256').update(key).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

// Inverse-frequency weighting so each hue zone (30° bucket) is roughly equally
// likely to be picked, regardless of how many seeds it holds.
function buildWeights(seeds: PaletteSeed[]): { weights: number[]; total: number } {
  const bucketCount: Record<number, number> = {};
  const bucketOf = (s: PaletteSeed) => Math.floor((((s.oklch[2] % 360) + 360) % 360) / 30);
  for (const s of seeds) {
    const b = bucketOf(s);
    bucketCount[b] = (bucketCount[b] || 0) + 1;
  }
  const weights = seeds.map((s) => 1 / bucketCount[bucketOf(s)]);
  const total = weights.reduce((a, b) => a + b, 0);
  return { weights, total };
}

export function weightedPick(seeds: PaletteSeed[], unit: number): PaletteSeed {
  const { weights, total } = buildWeights(seeds);
  let target = unit * total;
  for (let i = 0; i < seeds.length; i++) {
    target -= weights[i];
    if (target < 0) return seeds[i];
  }
  return seeds[seeds.length - 1];
}

// Format OKLCH as "oklch(36% 0.137 0)" — percentage L, trimmed trailing zeros.
// Format OKLCH as "oklch(36% 0.137 0)" — percentage L, trimmed trailing zeros.
export function toOklchCss([L, C, H]: [number, number, number]): string {
  const lPct = `${Math.round(L * 1000) / 10}%`;
  const cStr = String(Math.round(C * 1000) / 1000);
  const hStr = String(Math.round(H * 10) / 10);
  return `oklch(${lPct} ${cStr} ${hStr})`;
}

export function hueWord(H: number): string {
  if (H < 15 || H >= 345) return 'pure red';
  if (H < 35) return 'warm red / crimson';
  if (H < 55) return 'warm coral / burnt orange';
  if (H < 80) return 'orange / honey';
  if (H < 105) return 'warm amber / honey-gold';
  if (H < 135) return 'yellow-green / olive';
  if (H < 170) return 'green';
  if (H < 200) return 'teal';
  if (H < 230) return 'sky blue';
  if (H < 265) return 'cobalt / indigo';
  if (H < 295) return 'violet / purple';
  if (H < 330) return 'magenta / pink';
  return 'deep pink / rose';
}

// ─── palette subcommand ───────────────────────────────────────────────────────

export const paletteSubcommand: Command = {
  name: 'palette',
  description: 'Pick an OKLCH brand seed — returns anchor color + mood + composition strategy',
  options: [
    {
      name: 'id',
      type: 'string',
      description: 'Pick a specific seed by ID (e.g. seed-021)',
    },
    {
      name: 'from',
      type: 'string',
      description: 'Deterministic seed derived from a key (e.g. product name)',
    },
    {
      name: 'random',
      type: 'boolean',
      description: 'Pick a random seed (default behavior)',
    },
    {
      name: 'json',
      type: 'boolean',
      description: 'Output result as JSON',
    },
  ],
  examples: [
    { command: 'monomind design palette', description: 'Pick a random OKLCH brand seed' },
    {
      command: 'monomind design palette --from "my-product-name"',
      description: 'Deterministic seed from product name',
    },
    { command: 'monomind design palette --id seed-021', description: 'Pick a specific seed by ID' },
    { command: 'monomind design palette --json', description: 'Machine-readable JSON output' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const idFlag = ctx.flags.id as string | undefined;
    const fromFlag = ctx.flags.from as string | undefined;
    const jsonFlag = ctx.flags.json as boolean | undefined;

    // Respect MONODESIGN_PALETTE_SEED env var as a fallback for --from
    const fromKey = fromFlag || process.env.MONODESIGN_PALETTE_SEED;

    let seed: PaletteSeed;

    if (idFlag) {
      const found = SEEDS.find((s) => s.id === idFlag);
      if (!found) {
        output.printError(`No seed with id "${idFlag}"`);
        return { success: false, message: `No seed with id "${idFlag}"` };
      }
      seed = found;
    } else {
      const unit = fromKey ? hashUnit(fromKey) : Math.random();
      seed = weightedPick(SEEDS, unit);
    }

    const oklchCss = toOklchCss(seed.oklch);
    const result: DesignPaletteResult = { seed, oklchCss };

    if (jsonFlag) {
      output.writeln(JSON.stringify(result, null, 2));
      return { success: true, data: result };
    }

    const [, , H] = seed.oklch;

    output.writeln();
    output.writeln(output.bold(`BRAND SEED · ${seed.id}`));
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();
    output.writeln(`${output.bold('Color:')}  ${oklchCss}  (${hueWord(H)})`);
    output.writeln(`${output.bold('Mood:')}   ${seed.mood}`);
    output.writeln();
    output.writeln(output.bold('Strategy:'));
    output.writeln(output.dim(`  ${seed.strategy}`));

    if (fromKey) {
      output.writeln();
      output.writeln(output.dim(`(deterministic from: ${fromKey})`));
    }

    output.writeln();
    return { success: true, data: result };
  },
};

export default paletteSubcommand;
