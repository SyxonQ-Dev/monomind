/**
 * @monoes/mcp - Resource Helpers
 *
 * Factories for common static and file-backed resources. Re-exported from
 * resource-registry.ts.
 */

import type { ResourceHandler } from './resource-registry.js';
import type { ContentAnnotations, MCPResource } from './types.js';

/**
 * Helper to create a static text resource
 */
export function createTextResource(
  uri: string,
  name: string,
  text: string,
  options?: {
    description?: string;
    mimeType?: string;
    annotations?: ContentAnnotations;
  },
): { resource: MCPResource; handler: ResourceHandler } {
  const resource: MCPResource = {
    uri,
    name,
    description: options?.description,
    mimeType: options?.mimeType || 'text/plain',
    annotations: options?.annotations,
  };

  const handler: ResourceHandler = async () => [
    {
      uri,
      mimeType: options?.mimeType || 'text/plain',
      text,
    },
  ];

  return { resource, handler };
}

/**
 * Helper to create a file resource
 * SECURITY: Validates path to prevent path traversal attacks
 */
export function createFileResource(
  uri: string,
  name: string,
  filePath: string,
  options?: {
    description?: string;
    mimeType?: string;
    allowedBasePaths?: string[]; // Security: restrict to these base paths
  },
): { resource: MCPResource; handler: ResourceHandler } {
  const resource: MCPResource = {
    uri,
    name,
    description: options?.description,
    mimeType: options?.mimeType || 'application/octet-stream',
  };

  const handler: ResourceHandler = async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    // SECURITY: Normalize and validate the path
    const normalizedPath = path.normalize(filePath);

    // Prevent path traversal
    if (normalizedPath.includes('..') || normalizedPath.includes('\0')) {
      throw new Error('Invalid file path: path traversal detected');
    }

    // Prevent access to sensitive system paths
    const blockedPaths = ['/etc/', '/proc/', '/sys/', '/dev/', '/root/', '/var/log/'];
    const lowerPath = normalizedPath.toLowerCase();
    for (const blocked of blockedPaths) {
      if (lowerPath.startsWith(blocked) || lowerPath.includes('/.')) {
        throw new Error('Access to system paths is not allowed');
      }
    }

    // If allowedBasePaths specified, validate against them
    if (options?.allowedBasePaths && options.allowedBasePaths.length > 0) {
      const resolvedPath = path.resolve(normalizedPath);
      const isAllowed = options.allowedBasePaths.some((basePath) => {
        const resolvedBase = path.resolve(basePath);
        return resolvedPath.startsWith(resolvedBase);
      });

      if (!isAllowed) {
        throw new Error('File path is outside allowed directories');
      }
    }

    const content = await fs.readFile(normalizedPath);
    return [
      {
        uri,
        mimeType: options?.mimeType || 'application/octet-stream',
        blob: content.toString('base64'),
      },
    ];
  };

  return { resource, handler };
}
