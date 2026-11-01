// The slice of JSON Schema the tool definitions use, and a check of tool input
// against it. The model is given the same schema, so a problem here means the call
// was malformed; the handlers still check meaning (ids exist, repos are in scope).

export interface Schema {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function fits(type: NonNullable<Schema["type"]>, v: unknown): boolean {
  if (type === "integer") return typeof v === "number" && Number.isInteger(v);
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === type;
}

/**
 * Problems with `value` against `schema`, one line each, e.g. "risk must be one of
 * low, medium, high". Optional fields may be missing or null: models send null for
 * "not given". Extra fields are allowed.
 */
export function schemaProblems(schema: Schema, value: unknown, at = "input"): string[] {
  if (schema.type && !fits(schema.type, value)) return [`${at} must be ${schema.type === "integer" ? "a whole number" : `a${schema.type === "object" || schema.type === "array" ? "n" : ""} ${schema.type}`}, not ${typeOf(value)}`];
  const problems: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => problems.push(...schemaProblems(schema.items!, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    const field = (k: string) => (at === "input" ? k : `${at}.${k}`);
    for (const k of schema.required ?? []) {
      if (obj[k] === undefined || obj[k] === null) problems.push(`${field(k)} is required`);
    }
    for (const [k, s] of Object.entries(schema.properties)) {
      if (obj[k] !== undefined && obj[k] !== null) problems.push(...schemaProblems(s, obj[k], field(k)));
    }
  }
  return problems;
}
