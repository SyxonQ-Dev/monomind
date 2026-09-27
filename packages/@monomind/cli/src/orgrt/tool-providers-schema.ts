// packages/@monomind/cli/src/orgrt/tool-providers-schema.ts
import { z } from 'zod';

// ── JSON Schema → zod ────────────────────────────────────────────────────

/** Convert one JSON Schema node to zod. Supports string, number, integer,
 *  boolean, array, object, null and enum; anything else becomes z.any(). */
export function jsonSchemaToZod(schema: unknown): z.ZodType<any> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return z.any();
  const s = schema as Record<string, unknown>;
  const describe = (t: z.ZodType<any>): z.ZodType<any> =>
    typeof s.description === 'string' && s.description ? t.describe(s.description) : t;

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const values = s.enum as unknown[];
    if (values.every((v) => typeof v === 'string'))
      return describe(z.enum(values as [string, ...string[]]));
    const literals = values
      .filter((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
      .map((v) => z.literal(v as string | number | boolean | null));
    if (literals.length === 0) return describe(z.any());
    if (literals.length === 1) return describe(literals[0]);
    return describe(z.union(literals as unknown as [z.ZodType<any>, z.ZodType<any>]));
  }

  let type = s.type;
  let nullable = false;
  if (Array.isArray(type)) {
    const types = type.filter((t) => t !== 'null');
    nullable = types.length !== type.length;
    type = types.length === 1 ? types[0] : undefined;
  }

  let out: z.ZodType<any>;
  switch (type) {
    case 'string':
      out = z.string();
      break;
    case 'number':
      out = z.number();
      break;
    case 'integer':
      out = z.number().int();
      break;
    case 'boolean':
      out = z.boolean();
      break;
    case 'null':
      out = z.null();
      break;
    case 'array':
      out = z.array(jsonSchemaToZod(s.items));
      break;
    case 'object':
      out =
        s.properties && typeof s.properties === 'object'
          ? z.object(jsonSchemaToZodShape(s)).passthrough()
          : z.record(z.string(), z.any());
      break;
    default:
      out = z.any();
  }
  if (nullable) out = out.nullable();
  return describe(out);
}

/** Convert an object JSON Schema (an MCP tool `inputSchema`) into the zod
 *  SHAPE `OrgToolDef.schema` expects; `required` is honoured. */
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodType<any>> {
  const shape: Record<string, z.ZodType<any>> = {};
  if (!schema || typeof schema !== 'object') return shape;
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const t = jsonSchemaToZod(prop);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

/** Zod schema for the argument keys an object JSON Schema does not list under
 *  `properties`, or undefined when `additionalProperties: false` forbids them.
 *  JSON Schema allows extra keys by default, so an absent keyword keeps them. */
export function jsonSchemaCatchall(schema: unknown): z.ZodType<any> | undefined {
  const extra = (schema as { additionalProperties?: unknown } | null)?.additionalProperties;
  if (extra === false) return undefined;
  return extra && typeof extra === 'object' ? jsonSchemaToZod(extra) : z.unknown();
}
