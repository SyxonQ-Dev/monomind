#!/usr/bin/env node
/**
 * Generates 120 unique SVG agent avatar files + a sprite-sheet HTML.
 * Output: packages/@monomind/cli/src/ui/data/avatars/
 * Run: node scripts/generate-agent-avatars.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCESSORIES,
  CAT_COLORS,
  EYE_FNS,
  EYES,
  HAIR,
  HAIR_FNS,
  roleIcon,
  SKIN,
} from './generate-agent-avatars-palette.mjs';
import { AGENTS120 } from './generate-agent-avatars-roster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../packages/@monomind/cli/src/ui/data/avatars');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Deterministic pseudo-random seeded by index ──────────────────────────────

function seeded(i, n) {
  return ((i * 2654435761) >>> 0) % n;
}

// ─── SVG generation ──────────────────────────────────────────────────────────

function buildSVG(agent, i) {
  const cat = CAT_COLORS[agent.cat] || CAT_COLORS.core;
  const skinI = seeded(i * 7 + 1, SKIN.length);
  const hairColorI = seeded(i * 13 + 3, HAIR.length);
  const hairStyleI = seeded(i * 11 + 5, HAIR_FNS.length);
  const eyeStyleI = seeded(i * 17 + 7, EYE_FNS.length);
  const eyeColorI = seeded(i * 19 + 9, EYES.length);

  const skinCol = SKIN[skinI];
  const hairCol = HAIR[hairColorI];
  const eyeCol = EYES[eyeColorI];
  const hairSVG = HAIR_FNS[hairStyleI](hairCol);
  const eyesSVG = EYE_FNS[eyeStyleI](eyeCol);
  const accSVG = ACCESSORIES[agent.acc] || ACCESSORIES.none;

  // Nose (tiny bump between eyes and mouth)
  const noseSVG = `<ellipse cx="60" cy="52" rx="2.5" ry="1.8" fill="${skinCol}" opacity="0.7" stroke="${skinCol}" stroke-width="0.5"/>`;

  // Mouth variant based on index
  const mouthType = seeded(i * 23, 3);
  const mouthSVG =
    mouthType === 0
      ? `<path d="M52,60 Q60,66 68,60" stroke="#C4726A" stroke-width="2" fill="none" stroke-linecap="round"/>`
      : mouthType === 1
        ? `<path d="M53,61 Q60,65 67,61" stroke="#C4726A" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
        : `<path d="M54,60 L66,60" stroke="#C4726A" stroke-width="2" stroke-linecap="round"/>`;

  // Cheek blush (optional)
  const blush =
    seeded(i * 29, 3) === 0
      ? `<ellipse cx="46" cy="52" rx="5" ry="3" fill="#ff9999" opacity="0.3"/>
       <ellipse cx="74" cy="52" rx="5" ry="3" fill="#ff9999" opacity="0.3"/>`
      : '';

  // Body/torso
  const bodyH = 36;
  const bodySVG = `
  <!-- body -->
  <ellipse cx="60" cy="${94 + bodyH / 2}" rx="26" ry="${bodyH}" fill="${cat.body}"/>
  <ellipse cx="60" cy="${94 + bodyH / 2 - 2}" rx="22" ry="${bodyH - 4}" fill="${cat.accent}"/>
  <!-- collar -->
  <path d="M44,96 Q60,108 76,96" fill="${cat.bg}"/>
  <!-- neck -->
  <rect x="54" y="70" width="12" height="10" rx="4" fill="${skinCol}"/>
  `;

  // Ear highlights (simple circles on sides of head)
  const earsSVG = `
  <circle cx="38" cy="46" r="5" fill="${skinCol}"/>
  <circle cx="38" cy="46" r="3" fill="${skinCol}" opacity="0.5"/>
  <circle cx="82" cy="46" r="5" fill="${skinCol}"/>
  <circle cx="82" cy="46" r="3" fill="${skinCol}" opacity="0.5"/>
  `;

  // Badge icon (bottom right)
  const iconSVG = roleIcon(agent.icon, cat.body);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <defs>
    <clipPath id="circ">
      <circle cx="60" cy="60" r="58"/>
    </clipPath>
    <clipPath id="headClip">
      <ellipse cx="60" cy="42" rx="24" ry="28"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <circle cx="60" cy="60" r="58" fill="${cat.bg}"/>
  <circle cx="60" cy="60" r="58" fill="none" stroke="${cat.body}" stroke-width="3"/>

  <g clip-path="url(#circ)">
    ${bodySVG}
    <!-- head base -->
    <ellipse cx="60" cy="44" rx="22" ry="26" fill="${skinCol}"/>
    ${earsSVG}
    <!-- hair -->
    ${hairSVG}
    <!-- face features -->
    ${eyesSVG}
    ${noseSVG}
    ${mouthSVG}
    ${blush}
    <!-- accessory -->
    ${accSVG}
  </g>

  <!-- role badge -->
  ${iconSVG}
</svg>`;
}

// ─── Write individual SVGs ────────────────────────────────────────────────────

let written = 0;
AGENTS120.forEach((agent, i) => {
  const svg = buildSVG(agent, i);
  const filePath = path.join(OUT_DIR, `${agent.id}.svg`);
  fs.writeFileSync(filePath, svg, 'utf8');
  written++;
});

console.log(`✅ Written ${written} SVG avatars to: ${OUT_DIR}`);

// ─── Write manifest JSON ──────────────────────────────────────────────────────

const manifest = AGENTS120.map((a, i) => ({
  id: a.id,
  label: a.label,
  category: a.cat,
  icon: a.icon,
  file: `avatars/${a.id}.svg`,
  index: i,
}));

fs.writeFileSync(
  path.join(OUT_DIR, '../agent-avatars.json'),
  JSON.stringify({ version: 1, count: manifest.length, agents: manifest }, null, 2),
  'utf8',
);
console.log(`✅ Manifest written: data/agent-avatars.json`);

// ─── Write sprite-sheet HTML viewer ──────────────────────────────────────────

const spriteHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Agent Avatars — 120 Characters</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e2e8f0; font-family: system-ui, sans-serif; padding: 32px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 16px; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; }
  .card img { width: 80px; height: 80px; border-radius: 50%; transition: transform 0.2s; }
  .card:hover img { transform: scale(1.15); }
  .card span { font-size: 0.62rem; color: #94a3b8; text-align: center; line-height: 1.3; max-width: 90px; }
  .cat-badge { font-size: 0.5rem; background: #1e293b; border-radius: 4px; padding: 1px 4px; color: #64748b; }
  input[type=search] { background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0;
    padding: 8px 14px; width: 280px; font-size: 0.875rem; margin-bottom: 24px; outline: none; }
  input[type=search]:focus { border-color: #3B7DD8; }
</style>
</head>
<body>
<h1>Agent Avatars</h1>
<p class="subtitle">120 unique character SVGs — transparent background, scale-free</p>
<input type="search" placeholder="Search agents…" oninput="filter(this.value)" id="q"/>
<div class="grid" id="grid">
${AGENTS120.map(
  (a) => `  <div class="card" data-label="${a.label.toLowerCase()}" data-cat="${a.cat}"
    onclick="copy('${a.id}')">
    <img src="avatars/${a.id}.svg" alt="${a.label}" loading="lazy"/>
    <span>${a.label}</span>
    <span class="cat-badge">${a.cat}</span>
  </div>`,
).join('\n')}
</div>
<script>
function filter(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.card').forEach(c => {
    c.style.display = (c.dataset.label.includes(q) || c.dataset.cat.includes(q)) ? '' : 'none';
  });
}
function copy(id) {
  navigator.clipboard?.writeText('avatars/' + id + '.svg').catch(()=>{});
  const el = event.currentTarget.querySelector('img');
  el.style.outline = '3px solid #3B7DD8';
  setTimeout(() => el.style.outline = '', 1200);
}
</script>
</body>
</html>`;

const spritePath = path.join(OUT_DIR, '../agent-avatars.html');
fs.writeFileSync(spritePath, spriteHtml, 'utf8');
console.log(`✅ Sprite-sheet viewer: data/agent-avatars.html`);
console.log(`\n🎉 Done! ${AGENTS120.length} avatars ready.`);
console.log(`   Open: packages/@monomind/cli/src/ui/data/agent-avatars.html`);
