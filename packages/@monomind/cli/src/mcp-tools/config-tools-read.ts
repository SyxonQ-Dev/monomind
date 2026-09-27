/**
 * Config MCP Tools — get, list, export.
 * Extracted from config-tools.ts.
 */

import { DANGEROUS_KEYS, DEFAULT_CONFIG, loadConfigStore } from './config-tools-store.js';
import type { MCPTool } from './types.js';

export const configReadTools: MCPTool[] = [
  {
    name: 'config_get',
    description: 'Get configuration value',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Configuration key (dot notation supported)' },
        scope: { type: 'string', description: 'Configuration scope (project, user, system)' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      const store = loadConfigStore();
      // Cap key and scope to prevent DoS via O(n) key.split('.') and to block
      // prototype-pollution when key/scope are used as object property names.
      const MAX_CONFIG_KEY_LEN = 512;
      const MAX_CONFIG_SCOPE_LEN = 128;
      const rawKey = input.key as string;
      const key =
        typeof rawKey === 'string' && rawKey.length > MAX_CONFIG_KEY_LEN
          ? rawKey.slice(0, MAX_CONFIG_KEY_LEN)
          : rawKey;
      const rawScope = (input.scope as string) || 'default';
      const scope =
        typeof rawScope === 'string' && rawScope.length > MAX_CONFIG_SCOPE_LEN
          ? rawScope.slice(0, MAX_CONFIG_SCOPE_LEN)
          : rawScope;

      if (DANGEROUS_KEYS.has(scope)) {
        return { key, value: undefined, scope, exists: false, source: 'none' };
      }
      for (const seg of key.split('.')) {
        if (DANGEROUS_KEYS.has(seg)) {
          return { key, value: undefined, scope, exists: false, source: 'none' };
        }
      }

      let value: unknown;

      // Check scope first, then default values
      if (scope !== 'default' && Object.hasOwn(store.scopes, scope)) {
        value = store.scopes[scope][key];
      }
      if (value === undefined) {
        value = store.values[key];
      }
      if (value === undefined) {
        value = DEFAULT_CONFIG[key];
      }

      return {
        key,
        value,
        scope,
        exists: value !== undefined,
        source:
          value !== undefined ? (store.values[key] !== undefined ? 'stored' : 'default') : 'none',
      };
    },
  },
  {
    name: 'config_list',
    description: 'List configuration values',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Configuration scope' },
        prefix: { type: 'string', description: 'Key prefix filter' },
        includeDefaults: { type: 'boolean', description: 'Include default values' },
      },
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const MAX_CONFIG_SCOPE_LEN = 128;
      const MAX_PREFIX_LEN = 256;
      const rawScope = (input.scope as string) || 'default';
      const scope =
        typeof rawScope === 'string' && rawScope.length > MAX_CONFIG_SCOPE_LEN
          ? rawScope.slice(0, MAX_CONFIG_SCOPE_LEN)
          : rawScope;
      const rawPrefix = input.prefix as string;
      const prefix =
        typeof rawPrefix === 'string' && rawPrefix.length > MAX_PREFIX_LEN
          ? rawPrefix.slice(0, MAX_PREFIX_LEN)
          : rawPrefix;
      const includeDefaults = input.includeDefaults !== false;

      if (DANGEROUS_KEYS.has(scope)) {
        return { configs: [], total: 0, scope, updatedAt: store.updatedAt };
      }

      // Merge stored values with defaults
      let configs: Record<string, unknown> = {};

      if (includeDefaults) {
        configs = { ...DEFAULT_CONFIG };
      }

      // Add stored values
      Object.assign(configs, store.values);

      // Add scope-specific values
      if (scope !== 'default' && Object.hasOwn(store.scopes, scope)) {
        Object.assign(configs, store.scopes[scope]);
      }

      // Filter by prefix
      let entries = Object.entries(configs);
      if (prefix) {
        entries = entries.filter(([key]) => key.startsWith(prefix));
      }

      // Sort by key
      entries.sort(([a], [b]) => a.localeCompare(b));

      return {
        configs: entries.map(([key, value]) => ({
          key,
          value,
          source: store.values[key] !== undefined ? 'stored' : 'default',
        })),
        total: entries.length,
        scope,
        updatedAt: store.updatedAt,
      };
    },
  },
  {
    name: 'config_export',
    description: 'Export configuration to JSON',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Configuration scope' },
        includeDefaults: { type: 'boolean', description: 'Include default values' },
      },
    },
    handler: async (input) => {
      const store = loadConfigStore();
      // Cap scope to prevent DoS and prototype pollution.
      const MAX_CONFIG_SCOPE_LEN = 128;
      const rawScope = (input.scope as string) || 'default';
      const scope =
        typeof rawScope === 'string' && rawScope.length > MAX_CONFIG_SCOPE_LEN
          ? rawScope.slice(0, MAX_CONFIG_SCOPE_LEN)
          : rawScope;
      const includeDefaults = input.includeDefaults !== false;

      if (DANGEROUS_KEYS.has(scope)) {
        return {
          config: {},
          scope,
          version: store.version,
          exportedAt: new Date().toISOString(),
          count: 0,
        };
      }

      let exportData: Record<string, unknown> = {};

      if (includeDefaults) {
        exportData = { ...DEFAULT_CONFIG };
      }

      Object.assign(exportData, store.values);

      if (scope !== 'default' && Object.hasOwn(store.scopes, scope)) {
        Object.assign(exportData, store.scopes[scope]);
      }

      return {
        config: exportData,
        scope,
        version: store.version,
        exportedAt: new Date().toISOString(),
        count: Object.keys(exportData).length,
      };
    },
  },
];
