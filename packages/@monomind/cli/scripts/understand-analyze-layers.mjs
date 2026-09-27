// understand-analyze-layers.mjs — Architectural layer detection (heuristic +
// LLM-assisted) and the community write-back for /monomind:understand.
// File-size sweep: split out of understand-analyze.mjs.

import { ANTHROPIC_API_KEY, buildLayerPrompt, callClaude, parseJson } from './understand-analyze-llm.mjs';

// ── Heuristic layer detection (ported from understand-anything layer-detector) ─
const LAYER_PATTERNS = [
  { patterns: ['routes', 'controller', 'handler', 'endpoint', 'api'],     name: 'API Layer',           description: 'HTTP endpoints, route handlers, and API controllers' },
  { patterns: ['service', 'usecase', 'use-case', 'business'],              name: 'Service Layer',       description: 'Business logic and application services' },
  { patterns: ['model', 'entity', 'schema', 'database', 'db', 'migration','repository', 'repo'],
                                                                            name: 'Data Layer',          description: 'Data models, database access, and persistence' },
  { patterns: ['component', 'view', 'page', 'screen', 'layout', 'widget', 'ui'],
                                                                            name: 'UI Layer',            description: 'User interface components and views' },
  { patterns: ['middleware', 'interceptor', 'guard', 'filter', 'pipe'],    name: 'Middleware Layer',    description: 'Request/response middleware and interceptors' },
  { patterns: ['client', 'integration', 'external', 'sdk', 'vendor', 'adapter'],
                                                                            name: 'External Services',   description: 'External service integrations, SDKs, and third-party adapters' },
  { patterns: ['worker', 'job', 'queue', 'cron', 'consumer', 'processor', 'scheduler', 'background'],
                                                                            name: 'Background Tasks',    description: 'Background workers, job processors, and scheduled tasks' },
  { patterns: ['util', 'helper', 'lib', 'common', 'shared'],               name: 'Utility Layer',       description: 'Shared utilities, helpers, and common libraries' },
  { patterns: ['test', 'spec', '__test__', '__spec__', '__tests__'],        name: 'Test Layer',          description: 'Test files and test utilities' },
  { patterns: ['config', 'setting', 'env'],                                 name: 'Configuration Layer', description: 'Application configuration and environment settings' },
];

export function matchFileToLayer(filePath) {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const segments = norm.split('/');
  for (const { patterns, name } of LAYER_PATTERNS) {
    for (const seg of segments) {
      for (const p of patterns) {
        if (seg === p || seg === p + 's') return name;
      }
    }
  }
  return null;
}

export function toLayerId(name) {
  return 'layer:' + name.toLowerCase().replace(/\s+/g, '-');
}

export function detectLayersHeuristic(fileNodes) {
  const map = new Map(); // layerName → nodeIds[]
  for (const node of fileNodes) {
    const layerName = (node.file_path && matchFileToLayer(node.file_path)) || 'Core';
    if (!map.has(layerName)) map.set(layerName, []);
    map.get(layerName).push(node.id);
  }
  const layers = [];
  for (const [name, nodeIds] of map) {
    const pattern = LAYER_PATTERNS.find(p => p.name === name);
    layers.push({ id: toLayerId(name), name, description: pattern?.description ?? 'Core application files', nodeIds });
  }
  return layers;
}

// Apply LLM-suggested layer patterns to file nodes (ported from applyLLMLayers)
export function applyLlmLayers(fileNodes, llmLayers) {
  const map = new Map();
  for (const l of llmLayers) map.set(l.name, []);

  for (const node of fileNodes) {
    if (!node.file_path) {
      const other = map.get('Other') ?? [];
      other.push(node.id);
      map.set('Other', other);
      continue;
    }
    const norm = node.file_path.replace(/\\/g, '/');
    let assigned = false;
    for (const l of llmLayers) {
      for (const pattern of (l.filePatterns || [])) {
        if (norm.startsWith(pattern) || norm.includes('/' + pattern)) {
          map.get(l.name).push(node.id);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
    if (!assigned) {
      const other = map.get('Other') ?? [];
      other.push(node.id);
      map.set('Other', other);
    }
  }

  const layers = [];
  for (const [name, nodeIds] of map) {
    if (nodeIds.length === 0) continue;
    const l = llmLayers.find(x => x.name === name);
    layers.push({ id: toLayerId(name), name, description: l?.description ?? 'Uncategorized', nodeIds });
  }
  return layers;
}

// ── Detect layers and write communities to DB ────────────────────────────────
export async function detectAndWriteLayers(db, fileNodes, forceHeuristic, dryRun, dir) {
  let layers;

  if (!forceHeuristic && ANTHROPIC_API_KEY) {
    console.log('[understand] Detecting architectural layers via LLM...');
    const filePaths = fileNodes.map(n => n.file_path).filter(Boolean);
    try {
      const system = 'You are a software architecture expert. Respond with valid JSON only.';
      const text   = await callClaude(system, buildLayerPrompt(filePaths), 1024);
      const parsed = parseJson(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        layers = applyLlmLayers(fileNodes, parsed);
        console.log(`[understand] LLM detected ${layers.length} layers`);
      }
    } catch (e) {
      console.warn('[understand] LLM layer detection failed, falling back to heuristic:', e.message);
    }
  }

  if (!layers) {
    layers = detectLayersHeuristic(fileNodes);
    console.log(`[understand] Heuristic layer detection: ${layers.length} layers`);
  }

  if (!dryRun) {
    let communityIdx = 1000;
    const upsertCommunity = db.prepare(
      `INSERT INTO communities (id, label, size, cohesion_score)
       VALUES (?, ?, ?, 0.8)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, size=excluded.size`
    );
    const updateNodeCommunity = db.prepare(`UPDATE nodes SET community_id = ? WHERE id = ?`);

    const tx = db.transaction(() => {
      for (const layer of layers) {
        upsertCommunity.run(communityIdx, layer.name, layer.nodeIds.length);
        for (const nodeId of layer.nodeIds) {
          updateNodeCommunity.run(communityIdx, nodeId);
        }
        communityIdx++;
      }
    });
    tx();
    console.log(`[understand] Wrote ${layers.length} communities to DB`);
  }

  return layers;
}
