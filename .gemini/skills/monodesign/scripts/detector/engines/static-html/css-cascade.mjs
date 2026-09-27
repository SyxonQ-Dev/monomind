import fs from 'node:fs';
import path from 'node:path';

import { profileStep, recordProfileEvent } from '../../profile/profiler.mjs';
import { resolveVarRefs } from '../../rules/checks.mjs';
import { BORDER_SHORTHAND_RE, NAMED_COLORS, normalizeColorForCheck, buildBorderOverrideMap, unwrapCssAtLayer } from './css-cascade-color.mjs';
import { STATIC_INHERITED_PROPS, STATIC_DEFAULT_STYLE, STATIC_PROP_MAP, STATIC_NAMED_COLORS } from './css-cascade-static-data.mjs';
import {
  splitCssList,
  splitCssTokens,
  cssPropToCamel,
  staticColorToCss,
  parseStaticColor,
  extractStaticColor,
  normalizeStaticCssValue,
  expandStaticBoxValues,
  parseStaticBorder,
  parseStaticFont,
  parseStaticTransition,
  parseStaticAnimation,
  expandStaticDeclaration,
  compareStaticPriority,
  staticSpecificity,
  applyStaticDeclaration,
  parseStaticStyleAttribute,
  collectStaticCssRules,
} from './css-cascade-static-parse.mjs';
import { StaticElement, StaticDocument } from './css-cascade-static-dom.mjs';

// ---------------------------------------------------------------------------
// Static HTML/CSS detection (default for local HTML files)
// ---------------------------------------------------------------------------

function makeStaticStyle(values = {}) {
  const style = { ...STATIC_DEFAULT_STYLE, ...values };
  style.getPropertyValue = (prop) => {
    const key = cssPropToCamel(prop);
    return style[key] || style[prop] || '';
  };
  return style;
}

function buildStaticWindow(staticDoc) {
  return {
    document: staticDoc,
    getComputedStyle: (el) => staticDoc.getStyle(el),
  };
}

function collectStaticCssText(root, fileDir, profile, filePath, modules) {
  const styleTexts = [];
  for (const styleEl of modules.selectAll('style', root.children || [])) {
    styleTexts.push(modules.domutils.textContent(styleEl));
  }
  const links = modules.selectAll('link', root.children || []);
  for (const link of links) {
    const rel = link.attribs?.rel || '';
    const href = link.attribs?.href || '';
    if (!/\bstylesheet\b/i.test(rel) || !href || /^(https?:)?\/\//i.test(href)) continue;
    const cssPath = path.resolve(fileDir, href);
    try {
      const css = profileStep(profile, {
        engine: 'static-html',
        phase: 'preprocess',
        ruleId: 'inline-linked-stylesheet',
        target: filePath,
        detail: href,
      }, () => fs.readFileSync(cssPath, 'utf-8'));
      styleTexts.push(css);
    } catch { /* skip unreadable */ }
  }
  return styleTexts.join('\n');
}

function buildStaticStyleMap(root, staticDoc, cssText, modules, profile, filePath) {
  const specified = new Map();
  const allNodes = modules.selectAll('*', root.children || []);
  const rules = profileStep(profile, {
    engine: 'static-html',
    phase: 'parse-css',
    ruleId: 'css-rules',
    target: filePath,
  }, () => collectStaticCssRules(cssText, modules.csstree));

  profileStep(profile, {
    engine: 'static-html',
    phase: 'selector-match',
    ruleId: 'css-selectors',
    target: filePath,
  }, () => {
    for (const rule of rules) {
      let matched;
      try {
        matched = modules.selectAll(rule.selector, root.children || []);
      } catch {
        recordProfileEvent(profile, {
          engine: 'static-html',
          phase: 'selector-match',
          ruleId: 'unsupported-selector',
          target: filePath,
          ms: 0,
          findings: 0,
          detail: rule.selector,
        });
        continue;
      }
      for (const node of matched) {
        for (const decl of rule.declarations) {
          applyStaticDeclaration(specified, node, decl.prop, decl.value, {
            important: decl.important,
            specificity: rule.specificity,
            order: rule.order,
            inline: false,
          });
        }
      }
    }

    let inlineOrder = rules.length + 1;
    for (const node of allNodes) {
      const styleText = node.attribs?.style;
      if (!styleText) continue;
      for (const decl of parseStaticStyleAttribute(styleText, inlineOrder)) {
        applyStaticDeclaration(specified, node, decl.prop, decl.value, {
          important: decl.important,
          specificity: [1, 0, 0],
          order: decl.order,
          inline: true,
        });
      }
      inlineOrder += 1000;
    }
  });

  const computeNode = (node, parentStyle = null, parentCustom = new Map()) => {
    const specifiedMap = specified.get(node) || new Map();
    const customProps = new Map(parentCustom);
    for (const [prop, decl] of specifiedMap) {
      if (prop.startsWith('--')) customProps.set(prop, resolveVarRefs(decl.value, customProps));
    }
    const values = {};
    for (const prop of Object.keys(STATIC_DEFAULT_STYLE)) {
      if (STATIC_INHERITED_PROPS.has(prop) && parentStyle?.[prop] != null) values[prop] = parentStyle[prop];
      else values[prop] = STATIC_DEFAULT_STYLE[prop];
    }
    for (const [prop, decl] of specifiedMap) {
      if (prop.startsWith('--')) continue;
      values[prop] = normalizeStaticCssValue(prop, decl.value, customProps, parentStyle, values);
    }
    const style = makeStaticStyle(values);
    staticDoc.setStyle(node, style);
    for (const child of node.children || []) {
      if (child.type === 'tag') computeNode(child, style, customProps);
    }
  };

  profileStep(profile, {
    engine: 'static-html',
    phase: 'cascade',
    ruleId: 'compute-styles',
    target: filePath,
  }, () => {
    for (const child of root.children || []) {
      if (child.type === 'tag') computeNode(child);
    }
  });
}

export {
  BORDER_SHORTHAND_RE,
  NAMED_COLORS,
  normalizeColorForCheck,
  buildBorderOverrideMap,
  unwrapCssAtLayer,
  STATIC_INHERITED_PROPS,
  STATIC_DEFAULT_STYLE,
  STATIC_PROP_MAP,
  STATIC_NAMED_COLORS,
  splitCssList,
  splitCssTokens,
  cssPropToCamel,
  staticColorToCss,
  parseStaticColor,
  extractStaticColor,
  normalizeStaticCssValue,
  expandStaticBoxValues,
  parseStaticBorder,
  parseStaticFont,
  parseStaticTransition,
  parseStaticAnimation,
  expandStaticDeclaration,
  compareStaticPriority,
  staticSpecificity,
  applyStaticDeclaration,
  parseStaticStyleAttribute,
  collectStaticCssRules,
  StaticElement,
  StaticDocument,
  makeStaticStyle,
  buildStaticWindow,
  collectStaticCssText,
  buildStaticStyleMap,
};
