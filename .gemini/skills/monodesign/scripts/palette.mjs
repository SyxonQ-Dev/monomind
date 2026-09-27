#!/usr/bin/env node
/**
 * Brand-seed picker. Returns one OKLCH seed color + the mood it most
 * naturally evokes, and teaches the model how to compose a full palette
 * around it.
 *
 * The seed is the brand's anchor color. The 5-role palette (bg, surface,
 * ink, accent, muted) is composed by the caller at runtime using their
 * judgment + the brief (PRODUCT.md / DESIGN.md / user prompt), NOT picked
 * from a frozen 4-color preset.
 *
 * Why: 4-color frozen palettes drift toward safe defaults (warm-cream bg,
 * complementary accent on near-white) regardless of brief. A single seed +
 * the model's own composition lets the same seed produce a dark-mode jazz
 * club or a light-mode hospitality brand depending on what the brief calls
 * for. Tested empirically against curated 4-color palettes; seed approach
 * wins on mood-fit in 3 of 5 cases and ties on the rest.
 *
 * Usage:
 *   node scripts/palette.mjs                  # pick at random
 *   node scripts/palette.mjs --id seed-021    # pick a specific seed
 *   node scripts/palette.mjs --from <key>     # hash <key> to a seed (deterministic)
 *
 * Env vars:
 *   MONODESIGN_PALETTE_SEED — same as --from; useful for the eval harness
 *     to make runs reproducible.
 */

import crypto from 'node:crypto';

import { SEEDS } from './palette-seeds.mjs';

function parseArgs(argv) {
  const args = { id: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' && argv[i + 1]) { args.id = argv[++i]; }
    else if (a === '--from' && argv[i + 1]) { args.from = argv[++i]; }
  }
  return args;
}

// Hash a key into a stable float in [0, 1) for deterministic weighted picks.
function hashUnit(key) {
  const h = crypto.createHash('sha256').update(key).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

// The curated library is hue-skewed (more reds/oranges than teals/magentas)
// because that's where the source material + taste landed. Left uniform, a
// random pick would land on red ~1/3 of the time. Inverse-frequency weighting
// gives each seed a weight of 1/(count in its 30° hue bucket), so each hue
// ZONE is roughly equally likely to be chosen regardless of how many seeds it
// holds — fair rainbow exposure across runs without pruning the library.
function buildWeights(seeds) {
  const bucketCount = {};
  const bucketOf = (s) => Math.floor(((s.oklch[2] % 360) + 360) % 360 / 30);
  for (const s of seeds) { const b = bucketOf(s); bucketCount[b] = (bucketCount[b] || 0) + 1; }
  const weights = seeds.map((s) => 1 / bucketCount[bucketOf(s)]);
  const total = weights.reduce((a, b) => a + b, 0);
  return { weights, total };
}

function weightedPick(seeds, unit) {
  const { weights, total } = buildWeights(seeds);
  let target = unit * total;
  for (let i = 0; i < seeds.length; i++) {
    target -= weights[i];
    if (target < 0) return seeds[i];
  }
  return seeds[seeds.length - 1];
}

function pickSeed(seeds, { id, from }) {
  if (id) {
    const found = seeds.find(s => s.id === id);
    if (!found) { console.error(`no seed with id "${id}"`); process.exit(2); }
    return found;
  }
  const envFrom = process.env.MONODESIGN_PALETTE_SEED;
  const key = from || envFrom;
  const unit = key ? hashUnit(key) : Math.random();
  return weightedPick(seeds, unit);
}

function fmtOklch([L, C, H]) {
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

function hueWord(H) {
  if (H < 15 || H >= 345) return 'pure red';
  if (H < 35)  return 'warm red / crimson';
  if (H < 55)  return 'warm coral / burnt orange';
  if (H < 80)  return 'orange / honey';
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

// ---------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const seed = pickSeed(SEEDS, args);
const [, , H] = seed.oklch;

// The mood + strategy on each seed were derived by the model that
// originally judged it. We surface them as *hints*, not commands —
// the brief should still drive what the seed becomes.
const moodHint = seed.mood ? ` (one read: "${seed.mood}")` : '';
const strategyHint = seed.strategy ? `\n  - one example strategy: ${seed.strategy}` : '';

// ---------------------------------------------------------------
// Fat tool-exit response — what the model sees on stdout.
// ---------------------------------------------------------------

process.stdout.write(`BRAND SEED · ${seed.id}

Seed color (anchor for your primary brand color):
  ${fmtOklch(seed.oklch)} — ${hueWord(H)}${moodHint}

This is the brand's anchor — a single beautiful color. Compose the rest of
the palette around it using YOUR judgment, the brief (PRODUCT.md /
DESIGN.md / the user's prompt), and the color-strategy guidance already in
SKILL.md.

How to use:

1. Read the brief. Write one specific phrase describing the mood this
   product calls for. Be granular. Good: "1970s travel poster — sun-baked
   warmth, considered", "midnight jazz club — smoky brass, saxophone
   light", "Scandinavian winter morning — quiet light through frost". Bad:
   "modern and clean", "warm and inviting". The first lets you compose; the
   second is generic and will produce generic palettes.

2. The seed's hue (${H.toFixed(0)}°) anchors your primary brand color. You
   choose L and C to match the mood. The same hue can be deep-and-velvet,
   bright-and-confident, or pale-and-faded — pick the one the mood demands.
   Primary's hue should stay within ±10° of the seed.${strategyHint}

3. Now compose the full palette in OKLCH (5 more roles):
     • bg       — the most important architectural choice.
                  CORE PRINCIPLE: the mood lives in the BRAND COLORS
                  (primary + accent) and typography, NOT in the surface.
                  Stripe is warm — its purple does that, bg is pure
                  white. Linear is cool — its blue does that, bg is
                  pure. Notion is warm — its accents do that, bg is
                  near-pure-white. Putting warmth in BOTH primary AND
                  bg is the AI cliché.

                  DEFAULT A — PURE white: exactly oklch(1.000 0.000 0).
                    Not 0.99, not chroma 0.002. Stripe / Notion / Apple
                    use literal #ffffff. Don't add hidden warmth.
                    Refs: Stripe, Notion, Linear (light), Apple.com,
                    Vercel docs, Figma marketing, Loom, Substack.

                  DEFAULT B — PURE black/near-black: L 0.04-0.12,
                    chroma exactly 0.000. No hue tint. Vercel is
                    roughly oklch(0.08 0 0). Pick L for mood; C is 0.
                    Refs: Vercel, A24, Acne, Apple dark, MUBI.

                  ALT 2 — TINTED: chroma 0.015-0.05.
                    Use ONLY when:
                    (a) the mood is EXPLICITLY environmental — the surface
                        IS part of the brand (1920s lacquered interior,
                        leather library, ceramic studio, hotel lobby), or
                    (b) the seed itself is desaturated (chroma < 0.10) and
                        needs a tinted surface to read as a brand.
                    NOT for "feels warm" / "modern + warm" / "moody". If
                    your mood says "warm" but doesn't name a specific
                    environment, use PURE white and let primary carry
                    the warmth.

                  HEURISTIC: if seed chroma > 0.10 AND mood is product-
                  focused (not environment-focused), it's almost always
                  PURE white. Target distribution across many palettes:
                  ~50% pure white, ~25% pure black, ~25% tinted.
     • surface  — bg pulled slightly toward ink (10-15% mix). Same hue
                  family as bg. Used for cards, panels, sections.
     • ink      — body text color. Must reach ≥7:1 contrast vs bg.
                  Can carry the brand hue at low chroma in light mode
                  (slight warmth or coolness toward the brand).
     • accent   — a SECOND brand color, distinct from primary in BOTH
                  hue AND lightness. Picked to complement the mood (not
                  default-complementary across the wheel). Used for
                  badges, status pills, links, accent rules.
     • muted    — secondary text. Ink pulled 40% toward bg, keeping ink's
                  hue. Must reach ≥3.5:1 contrast vs bg.

4. Pick a color STRATEGY (the four steps from SKILL.md):
     • Restrained: tinted neutrals + accent ≤10% — product default
     • Committed: one saturated color carries 30-60% — identity-driven
     • Full palette: 3-4 named roles each used deliberately — brand work
     • Drenched: the surface IS the color — campaign, hero, statement
   The brief picks the strategy. A startup dashboard ≠ a perfume brand.

Hard rules (already in SKILL.md, recapped because the seed step is where
they actually bite):

  - OKLCH only — never hex. Never #RRGGBB.
  - ink-vs-bg WCAG contrast ≥ 7 (body text must be readable)
  - primary chroma ≤ 0.23 (above this, primary glows perceptually and
    no text on it is readable — acid-bright is a UI failure)
  - if primary L > 0.78, primary chroma ≤ 0.18 (the fluorescent zone)
  - primary-vs-accent contrast ≥ 1.7 (they must be visually distinct,
    not two variants of the same hue at similar lightness)
  - accent must carry readable text on a filled badge/pill: EITHER
    saturated (chroma ≥ 0.10) OR clearly light (L ≥ 0.85) OR clearly
    dark (L ≤ 0.30). Never a muddy mid-tone (L 0.45-0.72 + chroma < 0.10)
    — taupe/mushroom/dusty-grey accents read as weak and can't hold text
    either way. Saturate it or push its lightness to a clear light/dark.
  - avoid the saturated AI attractor zones: claude-beige (warm-cream bg
    + dusty brown primary), forest-green-on-cream, AI-purple-on-white,
    navy-cream-with-orange-accent

TEXT-ON-COLOR FILLS — pick by perceptual contrast, not just WCAG. The
rule applies to ANY element where text sits on a saturated color fill:
primary buttons, accent buttons, badges, status pills, tag highlights,
filled callouts. Don't only think "primary button" — apply consistently.

For any saturated mid-luminance color (L between 0.42 and 0.78, chroma ≥
0.08), use WHITE text (or near-white from your bg), not dark text — even
if WCAG says dark technically passes. The Helmholtz-Kohlrausch effect
makes saturated colors appear brighter than their luminance suggests,
and dark text on a warm-or-cool-saturated fill reads as muddy.

Convention: Stripe orange CTAs, McDonald's red, every fintech orange
button, Vercel's filled badges, Linear's status pills — all use white
text on saturated bg fills.

Dark text is correct only on PALE fills (L > 0.85) or PURE-NEUTRAL fills
(chroma near 0). Everything else: white text.

Return your composed palette in CSS custom properties using OKLCH, then
build with it. The seed is the start, not the recipe.
`);
