/**
 * Split out of generate-agent-avatars.mjs (file-size sweep). Pure move: no
 * behaviour change.
 */

// ─── Palettes ────────────────────────────────────────────────────────────────

export const SKIN = [
  '#FDDBB4',
  '#F5C18E',
  '#E8A977',
  '#C68642',
  '#A0693A',
  '#6B3F2A',
  '#FFE0C8',
  '#D4956A',
];
export const HAIR = [
  '#1a1208',
  '#3B2314',
  '#6B3A2A',
  '#8B5E3C',
  '#B8860B',
  '#C0A060',
  '#D4D4D4',
  '#E84040',
  '#5B5BCC',
  '#2C2C2C',
];
export const EYES = ['#2a3a5c', '#3B7DD8', '#2E8B57', '#8B4513', '#5B2D8E', '#1a5c4a'];

// Role category → background + body colors
export const CAT_COLORS = {
  core: { bg: '#EBF4FF', body: '#3B7DD8', accent: '#1a5bb5' },
  security: { bg: '#FFF0F0', body: '#E63946', accent: '#b52835' },
  swarm: { bg: '#F3EEFF', body: '#7B5EA7', accent: '#5B3E87' },
  consensus: { bg: '#EEF9FF', body: '#2196A8', accent: '#16707A' },
  perf: { bg: '#FFF6EE', body: '#F4A261', accent: '#D4824A' },
  github: { bg: '#F0F2F5', body: '#2D3748', accent: '#1a212e' },
  devops: { bg: '#F0FFF4', body: '#38A169', accent: '#2D8656' },
  legal: { bg: '#FFFBEC', body: '#8B6914', accent: '#6B4F10' },
  content: { bg: '#FFF0F9', body: '#D63584', accent: '#A8266A' },
  product: { bg: '#F0F9F0', body: '#2E8B57', accent: '#1E6B42' },
  sales: { bg: '#FFF8F0', body: '#E67E22', accent: '#BF6010' },
  ai: { bg: '#F0F0FF', body: '#5B5BCC', accent: '#3A3AAA' },
  creative: { bg: '#FFF8E8', body: '#D4A017', accent: '#A87B10' },
  blockchain: { bg: '#F0FDF9', body: '#0D9488', accent: '#0A7A70' },
  management: { bg: '#F5F0FF', body: '#6D28D9', accent: '#5014B8' },
  frontend: { bg: '#FFF0FB', body: '#C026D3', accent: '#9A1AAA' },
  data: { bg: '#F0F9FF', body: '#0EA5E9', accent: '#0880C0' },
  infra: { bg: '#F1FFF4', body: '#16A34A', accent: '#0F7F36' },
  testing: { bg: '#FFFBF0', body: '#CA8A04', accent: '#A06800' },
};

// ─── Hair path generators (cx=60, head top ≈ y24, radius≈20) ─────────────────

function hairShort(col) {
  return `<ellipse cx="60" cy="22" rx="20" ry="10" fill="${col}"/>
  <rect x="40" y="22" width="40" height="8" rx="4" fill="${col}"/>`;
}
function hairMedium(col) {
  return `<ellipse cx="60" cy="21" rx="21" ry="12" fill="${col}"/>
  <rect x="39" y="21" width="10" height="22" rx="5" fill="${col}"/>
  <rect x="71" y="21" width="10" height="22" rx="5" fill="${col}"/>`;
}
function hairLong(col) {
  return `<ellipse cx="60" cy="20" rx="22" ry="13" fill="${col}"/>
  <rect x="37" y="20" width="11" height="42" rx="5" fill="${col}"/>
  <rect x="72" y="20" width="11" height="42" rx="5" fill="${col}"/>`;
}
function hairCurly(col) {
  return `<ellipse cx="60" cy="18" rx="24" ry="14" fill="${col}"/>
  <circle cx="38" cy="25" r="9" fill="${col}"/>
  <circle cx="82" cy="25" r="9" fill="${col}"/>
  <circle cx="48" cy="14" r="8" fill="${col}"/>
  <circle cx="72" cy="14" r="8" fill="${col}"/>
  <circle cx="60" cy="11" r="9" fill="${col}"/>`;
}
function hairMohawk(col) {
  return `<ellipse cx="60" cy="22" rx="18" ry="9" fill="${col}"/>
  <rect x="55" y="6" width="10" height="20" rx="5" fill="${col}"/>`;
}
function hairBun(col) {
  return `<ellipse cx="60" cy="24" rx="19" ry="8" fill="${col}"/>
  <circle cx="60" cy="14" r="10" fill="${col}"/>`;
}

export const HAIR_FNS = [hairShort, hairMedium, hairLong, hairCurly, hairMohawk, hairBun];

// ─── Eye shapes ──────────────────────────────────────────────────────────────

function eyesRound(col) {
  return `<circle cx="51" cy="44" r="4.5" fill="white"/>
  <circle cx="69" cy="44" r="4.5" fill="white"/>
  <circle cx="51" cy="44" r="3" fill="${col}"/>
  <circle cx="69" cy="44" r="3" fill="${col}"/>
  <circle cx="52" cy="43" r="1.2" fill="white"/>
  <circle cx="70" cy="43" r="1.2" fill="white"/>`;
}
function eyesAlmond(col) {
  return `<path d="M45,44 Q51,39 57,44 Q51,49 45,44Z" fill="white"/>
  <path d="M63,44 Q69,39 75,44 Q69,49 63,44Z" fill="white"/>
  <circle cx="51" cy="44" r="2.8" fill="${col}"/>
  <circle cx="69" cy="44" r="2.8" fill="${col}"/>
  <circle cx="52" cy="43" r="1.1" fill="white"/>
  <circle cx="70" cy="43" r="1.1" fill="white"/>`;
}
function eyesWide(col) {
  return `<ellipse cx="51" cy="44" rx="5.5" ry="4" fill="white"/>
  <ellipse cx="69" cy="44" rx="5.5" ry="4" fill="white"/>
  <circle cx="51" cy="44" r="3" fill="${col}"/>
  <circle cx="69" cy="44" r="3" fill="${col}"/>
  <circle cx="52.5" cy="43" r="1.2" fill="white"/>
  <circle cx="70.5" cy="43" r="1.2" fill="white"/>`;
}
function eyesNarrow(col) {
  return `<ellipse cx="51" cy="44" rx="5" ry="2.5" fill="white"/>
  <ellipse cx="69" cy="44" rx="5" ry="2.5" fill="white"/>
  <circle cx="51" cy="44" r="2.2" fill="${col}"/>
  <circle cx="69" cy="44" r="2.2" fill="${col}"/>
  <circle cx="52" cy="43.2" r="1" fill="white"/>
  <circle cx="70" cy="43.2" r="1" fill="white"/>`;
}

export const EYE_FNS = [eyesRound, eyesAlmond, eyesWide, eyesNarrow];

// ─── Accessories (role-specific icons drawn in SVG) ───────────────────────────

export const ACCESSORIES = {
  glasses: `<path d="M43,44 Q51,50 59,44" stroke="#555" stroke-width="2" fill="none"/>
  <path d="M61,44 Q69,50 77,44" stroke="#555" stroke-width="2" fill="none"/>
  <line x1="59" y1="44" x2="61" y2="44" stroke="#555" stroke-width="1.5"/>
  <line x1="43" y1="44" x2="41" y2="46" stroke="#555" stroke-width="1.5"/>
  <line x1="77" y1="44" x2="79" y2="46" stroke="#555" stroke-width="1.5"/>`,

  headset: `<path d="M38,36 Q38,22 60,22 Q82,22 82,36" stroke="#444" stroke-width="3" fill="none"/>
  <rect x="33" y="34" width="9" height="12" rx="4" fill="#444"/>
  <rect x="78" y="34" width="9" height="12" rx="4" fill="#444"/>`,

  crown: `<polygon points="48,24 60,14 72,24 76,22 72,30 48,30 44,22" fill="#D4A017"/>
  <circle cx="60" cy="14" r="3" fill="#E84040"/>`,

  visor: `<ellipse cx="60" cy="22" rx="22" ry="6" fill="#3B7DD8" opacity="0.8"/>`,

  badge: `<rect x="50" y="72" width="20" height="14" rx="3" fill="#D4A017"/>
  <text x="60" y="82" text-anchor="middle" font-size="7" font-family="monospace" fill="#1a1a1a" font-weight="bold">ID</text>`,

  earpiece: `<circle cx="38" cy="44" r="4" fill="#555"/>
  <line x1="38" y1="48" x2="36" y2="60" stroke="#555" stroke-width="1.5"/>`,

  beanie: `<ellipse cx="60" cy="24" rx="22" ry="6" fill="#5B5BCC"/>
  <rect x="38" y="22" width="44" height="10" rx="3" fill="#5B5BCC"/>
  <circle cx="60" cy="16" r="5" fill="#CC5B5B"/>`,

  goggles: `<ellipse cx="50" cy="44" rx="8" ry="6" fill="none" stroke="#2a3a5c" stroke-width="2"/>
  <ellipse cx="70" cy="44" rx="8" ry="6" fill="none" stroke="#2a3a5c" stroke-width="2"/>
  <line x1="58" y1="44" x2="62" y2="44" stroke="#2a3a5c" stroke-width="2"/>
  <ellipse cx="50" cy="44" rx="6" ry="4" fill="#3B7DD820"/>
  <ellipse cx="70" cy="44" rx="6" ry="4" fill="#3B7DD820"/>`,

  headband: `<rect x="38" y="28" width="44" height="7" rx="3" fill="#E63946"/>`,

  none: ``,
};

// ─── Role icon badge (bottom-right corner of circle) ─────────────────────────

export function roleIcon(symbol, color) {
  return `<circle cx="88" cy="88" r="16" fill="${color}" opacity="0.95"/>
  <text x="88" y="93" text-anchor="middle" font-size="14" fill="white" font-family="sans-serif">${symbol}</text>`;
}
