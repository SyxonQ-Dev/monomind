import { AI_SLOP_ANTIPATTERNS } from './antipatterns-slop.mjs';
import { QUALITY_ANTIPATTERNS } from './antipatterns-quality.mjs';
import { PROVIDER_TELL_ANTIPATTERNS } from './antipatterns-provider.mjs';

const ANTIPATTERNS = [
  ...AI_SLOP_ANTIPATTERNS,
  ...QUALITY_ANTIPATTERNS,
  ...PROVIDER_TELL_ANTIPATTERNS,
];

const RULE_ENGINE_SUPPORT = {
  regex: new Set(['source', 'page-analyzer']),
  'static-html': new Set(['element', 'page']),
  browser: new Set(['element', 'page', 'layout']),
  visual: new Set(['visual-contrast']),
};

function getAntipattern(id) {
  return ANTIPATTERNS.find(rule => rule.id === id);
}

function getRulesForCategory(category) {
  return ANTIPATTERNS.filter(rule => rule.category === category);
}

function getRuleEngineSupport(engine) {
  return RULE_ENGINE_SUPPORT[engine] || new Set();
}

// Set of provider tags that gate rules off by default (e.g. 'gpt', 'gemini').
const GATED_PROVIDERS = new Set(
  ANTIPATTERNS.map(rule => rule.gated).filter(Boolean),
);

// Drop findings for rules gated behind a provider tag unless that provider
// was explicitly enabled (CLI --gpt / --gemini). Non-gated findings always
// pass through. `findings` carry the rule id on `.antipattern`.
function filterByProviders(findings, providers = []) {
  const enabled = new Set(providers || []);
  if (!GATED_PROVIDERS.size) return findings;
  return findings.filter(f => {
    const rule = getAntipattern(f.antipattern);
    if (!rule?.gated) return true;
    return enabled.has(rule.gated);
  });
}


// Set of scope tags rules can declare (e.g. 'type', 'layout'). Used by the
// CLI --scope flag to narrow output to one design domain.
const RULE_SCOPES = new Set(
  ANTIPATTERNS.flatMap(rule => rule.scopes || []),
);

// Keep only findings whose rule declares at least one of the requested
// scopes. An empty scope list means no filtering (default CLI behavior).
function filterByScopes(findings, scopes = []) {
  if (!scopes || scopes.length === 0) return findings;
  const enabled = new Set(scopes);
  return findings.filter(f => {
    const rule = getAntipattern(f.antipattern);
    return (rule?.scopes || []).some(scope => enabled.has(scope));
  });
}

export {
  ANTIPATTERNS,
  RULE_SCOPES,
  RULE_ENGINE_SUPPORT,
  GATED_PROVIDERS,
  getAntipattern,
  getRulesForCategory,
  getRuleEngineSupport,
  filterByProviders,
  filterByScopes,
};
