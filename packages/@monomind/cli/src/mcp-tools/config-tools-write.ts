/**
 * Config MCP Tools — set, reset, import.
 * Extracted from config-tools.ts.
 */

import {
  DANGEROUS_KEYS,
  DEFAULT_CONFIG,
  filterDangerousKeys,
  getConfigPath,
  loadConfigStore,
  saveConfigStore,
} from './config-tools-store.js';
import type { MCPTool } from './types.js';

export const configWriteTools: MCPTool[] = [
  {
    name: 'config_set',
    description: 'Set configuration value',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Configuration key (dot notation supported)' },
        value: { description: 'Configuration value' },
        scope: { type: 'string', description: 'Configuration scope (project, user, system)' },
      },
      required: ['key', 'value'],
    },
    handler: async (input) => {
      const store = loadConfigStore();
      // Cap key and scope: both become JSON object keys in the on-disk config
      // store (store.values[key] and store.scopes[scope][key]).  key is also
      // split on '.' — O(n) — before the dangerous-key check.
      const MAX_CONFIG_KEY_LEN = 512;
      const MAX_CONFIG_SCOPE_LEN = 128;
      const rawKey = input.key as string;
      const key =
        typeof rawKey === 'string' && rawKey.length > MAX_CONFIG_KEY_LEN
          ? rawKey.slice(0, MAX_CONFIG_KEY_LEN)
          : rawKey;
      const value = input.value;
      const rawScope = (input.scope as string) || 'default';
      const scope =
        typeof rawScope === 'string' && rawScope.length > MAX_CONFIG_SCOPE_LEN
          ? rawScope.slice(0, MAX_CONFIG_SCOPE_LEN)
          : rawScope;

      for (const seg of key.split('.')) {
        if (DANGEROUS_KEYS.has(seg)) {
          return { success: false, error: `Forbidden key segment: "${seg}"` };
        }
      }
      if (DANGEROUS_KEYS.has(scope)) {
        return { success: false, error: `Forbidden scope: "${scope}"` };
      }

      const previousValue = store.values[key];

      if (scope === 'default') {
        store.values[key] = value;
      } else {
        if (!store.scopes[scope]) {
          store.scopes[scope] = {};
        }
        store.scopes[scope][key] = value;
      }

      saveConfigStore(store);

      return {
        success: true,
        key,
        value,
        previousValue,
        scope,
        path: getConfigPath(),
      };
    },
  },
  {
    name: 'config_reset',
    description: 'Reset configuration to defaults',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Configuration scope' },
        key: { type: 'string', description: 'Specific key to reset (omit to reset all)' },
      },
    },
    handler: async (input) => {
      const store = loadConfigStore();
      // Cap scope and key to prevent DoS and prototype pollution.
      const MAX_CONFIG_KEY_LEN = 512;
      const MAX_CONFIG_SCOPE_LEN = 128;
      const rawScope = (input.scope as string) || 'default';
      const scope =
        typeof rawScope === 'string' && rawScope.length > MAX_CONFIG_SCOPE_LEN
          ? rawScope.slice(0, MAX_CONFIG_SCOPE_LEN)
          : rawScope;
      const rawKey = input.key as string;
      const key =
        typeof rawKey === 'string' && rawKey.length > MAX_CONFIG_KEY_LEN
          ? rawKey.slice(0, MAX_CONFIG_KEY_LEN)
          : rawKey;

      if (DANGEROUS_KEYS.has(scope)) {
        return { success: false, error: `Forbidden scope: "${scope}"` };
      }
      if (key) {
        for (const seg of key.split('.')) {
          if (DANGEROUS_KEYS.has(seg)) {
            return { success: false, error: `Forbidden key segment: "${seg}"` };
          }
        }
      }

      let resetKeys: string[] = [];

      if (key) {
        // Reset specific key
        if (scope === 'default') {
          if (Object.hasOwn(store.values, key)) {
            delete store.values[key];
            resetKeys.push(key);
          }
        } else if (Object.hasOwn(store.scopes, scope) && Object.hasOwn(store.scopes[scope], key)) {
          delete store.scopes[scope][key];
          resetKeys.push(key);
        }
      } else {
        // Reset all keys in scope
        if (scope === 'default') {
          resetKeys = Object.keys(store.values);
          store.values = { ...DEFAULT_CONFIG };
        } else if (Object.hasOwn(store.scopes, scope)) {
          resetKeys = Object.keys(store.scopes[scope]);
          delete store.scopes[scope];
        }
      }

      saveConfigStore(store);

      return {
        success: true,
        scope,
        reset: key || 'all',
        resetKeys,
        count: resetKeys.length,
      };
    },
  },
  {
    name: 'config_import',
    description: 'Import configuration from JSON',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'Configuration object to import' },
        scope: { type: 'string', description: 'Configuration scope' },
        merge: { type: 'boolean', description: 'Merge with existing (true) or replace (false)' },
      },
      required: ['config'],
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const config = filterDangerousKeys(input.config as Record<string, unknown>);
      // Cap scope to prevent DoS and prototype pollution.
      const MAX_CONFIG_SCOPE_LEN = 128;
      const rawScope = (input.scope as string) || 'default';
      const scope =
        typeof rawScope === 'string' && rawScope.length > MAX_CONFIG_SCOPE_LEN
          ? rawScope.slice(0, MAX_CONFIG_SCOPE_LEN)
          : rawScope;
      const merge = input.merge !== false;

      if (DANGEROUS_KEYS.has(scope)) {
        return { success: false, error: `Forbidden scope: "${scope}"` };
      }

      const importedKeys: string[] = Object.keys(config);

      if (scope === 'default') {
        if (merge) {
          Object.assign(store.values, config);
        } else {
          store.values = { ...DEFAULT_CONFIG, ...config };
        }
      } else {
        if (!Object.hasOwn(store.scopes, scope) || !merge) {
          store.scopes[scope] = {};
        }
        Object.assign(store.scopes[scope], config);
      }

      saveConfigStore(store);

      return {
        success: true,
        scope,
        imported: importedKeys.length,
        keys: importedKeys,
        merge,
      };
    },
  },
];
