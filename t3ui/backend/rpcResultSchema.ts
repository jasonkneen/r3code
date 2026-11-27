// The reference's RpcClient decodes every request's Exit with its contract success schema (effect rpc RpcClient
// decodeExit, then Effect.orDie): a reply of the wrong shape fails the call with the schema issue. rpcResultSchemas.json
// is that success schema as JSON Schema, generated from packages/contracts by the RPC schema generator (do not
// edit it by hand). This checks a reply against it; unknown keywords are ignored.
import { host, platform } from "nsh";
import generated from "./rpcResultSchemas.json";

type Json = Record<string, unknown>;
type RawCatalog = { methods?: Record<string, Json>; definitions?: Record<string, Json>; external?: boolean };
type ExternalSchemaResponse = { found: boolean; schema?: Json; definitions?: Record<string, Json> };
type ExternalSchemaLoader = (method: string) => Promise<unknown>;

const initialCatalog = generated as unknown as RawCatalog;
let externalCatalog = Boolean(initialCatalog.external);
let catalogEpoch = 0;
const methodSchemas = new Map<string, Json | null>();
const definitions = new Map<string, Json>();
const pendingSchemaLoads = new Map<string, Promise<void>>();
let externalLoaderForTest: ExternalSchemaLoader | null = null;

function isPlainObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function seedCatalogFromBundled(): void {
  methodSchemas.clear();
  definitions.clear();
  pendingSchemaLoads.clear();
  if (isPlainObject(initialCatalog.methods)) {
    for (const [key, value] of Object.entries(initialCatalog.methods)) {
      if (isPlainObject(value)) methodSchemas.set(key, value);
    }
  }
  if (isPlainObject(initialCatalog.definitions)) {
    for (const [key, value] of Object.entries(initialCatalog.definitions)) {
      if (isPlainObject(value)) definitions.set(key, value);
    }
  }
}

seedCatalogFromBundled();

export const isExternalRpcSchemaCatalog = (): boolean => externalCatalog;

/** Tests only: exercises external per-method schema loading without modifying bundled JSON. */
export function setExternalRpcSchemaLoaderForTest(
  loader: ExternalSchemaLoader | null,
  options?: { external?: boolean },
): void {
  catalogEpoch += 1;
  externalLoaderForTest = loader;
  externalCatalog = options?.external ?? (loader !== null ? true : Boolean(initialCatalog.external));
  if (loader !== null) {
    methodSchemas.clear();
    definitions.clear();
    pendingSchemaLoads.clear();
  } else {
    seedCatalogFromBundled();
  }
}

async function fetchExternalMethodSchema(method: string): Promise<unknown> {
  if (externalLoaderForTest) return externalLoaderForTest(method);
  if (platform.os === "windows" && host.available()) {
    return host.call("r3.readRpcMethodSchema", { method }, { timeout: 5000 });
  }
  throw new Error("External RPC result schema host is unavailable.");
}

function assertExternalRefsResolvable(root: unknown, candidateDefs: Map<string, Json>): void {
  const stack: unknown[] = [root];
  const visitedDefs = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isPlainObject(node)) continue;
    if (typeof node.$ref === "string") {
      let rawRef: string = node.$ref;
      let hops = 0;
      while (true) {
        hops += 1;
        if (hops > 32) {
          throw new Error("External RPC result schema $ref nesting depth exceeded.");
        }
        const name = rawRef.replace(/^#\/(\$defs|definitions)\//, "");
        const target = candidateDefs.get(name);
        if (!target) {
          throw new Error(`External RPC result schema references missing definition: ${name}`);
        }
        if (!visitedDefs.has(name)) {
          visitedDefs.add(name);
          stack.push(target);
        }
        if (typeof target.$ref === "string") {
          rawRef = target.$ref;
        } else {
          break;
        }
      }
    }
    for (const child of Object.values(node)) {
      stack.push(child);
    }
  }
}

export async function ensureRpcResultSchema(method: string): Promise<void> {
  if (!externalCatalog || methodSchemas.has(method)) return;
  const existing = pendingSchemaLoads.get(method);
  if (existing) return existing;
  const epoch = catalogEpoch;
  const run = (async () => {
    const raw = await fetchExternalMethodSchema(method);
    if (epoch !== catalogEpoch) return;
    if (!isPlainObject(raw) || typeof raw.found !== "boolean") {
      throw new Error("Invalid external RPC result schema response.");
    }
    const response = raw as unknown as ExternalSchemaResponse;
    if (!response.found) {
      methodSchemas.set(method, null);
      return;
    }
    if (!isPlainObject(response.schema)) {
      throw new Error(`Invalid external RPC result schema for ${method}.`);
    }
    const candidateDefs = new Map<string, Json>();
    if (response.definitions !== undefined) {
      if (!isPlainObject(response.definitions)) {
        throw new Error(`Invalid external RPC result schema definitions for ${method}.`);
      }
      for (const [key, value] of Object.entries(response.definitions)) {
        if (!isPlainObject(value)) {
          throw new Error(`Invalid external RPC result schema definition: ${key}`);
        }
        candidateDefs.set(key, value);
      }
    }
    assertExternalRefsResolvable(response.schema, candidateDefs);
    for (const [key, value] of candidateDefs.entries()) {
      definitions.set(key, value);
    }
    methodSchemas.set(method, response.schema);
  })();
  pendingSchemaLoads.set(method, run);
  try {
    await run;
  } finally {
    if (pendingSchemaLoads.get(method) === run) pendingSchemaLoads.delete(method);
  }
}

export const hasRpcResultSchema = (method: string): boolean => {
  const entry = methodSchemas.get(method);
  return entry !== undefined && entry !== null;
};

const typeOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const show = (value: unknown): string => {
  if (value === undefined) return "undefined";
  try { const text = JSON.stringify(value); return text.length > 60 ? `${text.slice(0, 57)}...` : text; } catch { return String(value); }
};
const at = (path: (string | number)[]) => path.map((key) => `[${JSON.stringify(key)}]`).join("");

const patterns = new Map<string, RegExp | null>();
function pattern(source: string): RegExp | null {
  if (!patterns.has(source)) {
    let compiled: RegExp | null = null;
    try { compiled = new RegExp(source, "u"); } catch { try { compiled = new RegExp(source); } catch { compiled = null; } }
    patterns.set(source, compiled);
  }
  return patterns.get(source)!;
}

function resolve(schema: Json): Json {
  let current = schema;
  for (let depth = 0; typeof current.$ref === "string" && depth < 32; depth++) {
    const name = current.$ref.replace(/^#\/(\$defs|definitions)\//, "");
    const target = definitions.get(name);
    if (!target) return {};
    current = target;
  }
  return current;
}

/** The first issue as "<message>\n  at <path>", or null when the value matches. */
export function rpcResultIssue(schema: Json, value: unknown, path: (string | number)[] = []): string | null {
  const node = resolve(schema);
  const here = path.length ? `\n  at ${at(path)}` : "";
  if (Array.isArray(node.anyOf) && !node.anyOf.some((option) => rpcResultIssue(option as Json, value, path) === null)) {
    // Report the branch whose type matches, if one does; else the plain mismatch.
    const typed = (node.anyOf as Json[]).find((option) => { const o = resolve(option); return o.type === undefined || o.type === typeOf(value) || (o.type === "integer" && typeof value === "number"); });
    return typed ? rpcResultIssue(typed, value, path) : `Expected ${(node.anyOf as Json[]).map((option) => resolve(option).type ?? "value").join(" | ")}, got ${show(value)}${here}`;
  }
  if (Array.isArray(node.allOf)) for (const part of node.allOf) { const issue = rpcResultIssue(part as Json, value, path); if (issue) return issue; }
  if (node.not && typeof node.not === "object" && rpcResultIssue(node.not as Json, value, path) === null) return `Unexpected value ${show(value)}${here}`;
  if (Array.isArray(node.enum) && !node.enum.some((option) => option === value)) return `Expected ${node.enum.map((option) => JSON.stringify(option)).join(" | ")}, got ${show(value)}${here}`;
  const type = node.type;
  if (typeof type === "string") {
    const actual = typeOf(value);
    const ok = type === "integer" ? typeof value === "number" && Number.isInteger(value) : type === actual;
    if (!ok) return `Expected ${type}, got ${show(value)}${here}`;
  }
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) return `Expected a value with a length of at least ${node.minLength}, got ${show(value)}${here}`;
    if (typeof node.maxLength === "number" && value.length > node.maxLength) return `Expected a value with a length of at most ${node.maxLength}, got ${show(value)}${here}`;
    if (typeof node.pattern === "string") { const re = pattern(node.pattern); if (re && !re.test(value)) return `Expected a string matching the RegExp ${node.pattern}, got ${show(value)}${here}`; }
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) return `Expected a value greater than or equal to ${node.minimum}, got ${value}${here}`;
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) return `Expected a value greater than ${node.exclusiveMinimum}, got ${value}${here}`;
    if (typeof node.maximum === "number" && value > node.maximum) return `Expected a value less than or equal to ${node.maximum}, got ${value}${here}`;
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) return `Expected an array of at least ${node.minItems} items, got ${value.length}${here}`;
    if (typeof node.maxItems === "number" && value.length > node.maxItems) return `Expected an array of at most ${node.maxItems} items, got ${value.length}${here}`;
    const prefix = Array.isArray(node.prefixItems) ? (node.prefixItems as Json[]) : [];
    for (let index = 0; index < value.length; index++) {
      const item = index < prefix.length ? prefix[index] : node.items && typeof node.items === "object" ? (node.items as Json) : null;
      if (!item) continue;
      const issue = rpcResultIssue(item, value[index], [...path, index]);
      if (issue) return issue;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Json;
    if (Array.isArray(node.required)) for (const key of node.required as string[]) if (object[key] === undefined) return `Missing key\n  at ${at([...path, key])}`;
    const properties = node.properties && typeof node.properties === "object" ? (node.properties as Record<string, Json>) : {};
    for (const [key, child] of Object.entries(properties)) {
      if (object[key] === undefined) continue;
      const issue = rpcResultIssue(child, object[key], [...path, key]);
      if (issue) return issue;
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      for (const [key, child] of Object.entries(object)) {
        if (key in properties || child === undefined) continue;
        const issue = rpcResultIssue(node.additionalProperties as Json, child, [...path, key]);
        if (issue) return issue;
      }
    }
  }
  return null;
}

/** The method's success schema issue for this reply, or null (also null for a method with no generated schema). */
export function rpcResultSchemaIssue(method: string, value: unknown): string | null {
  if (externalCatalog && !methodSchemas.has(method)) {
    return "RPC result schema was not loaded before decoding.";
  }
  const schema = methodSchemas.get(method);
  // A void success has no `value` on the wire (JSON drops undefined): it reads as null, the encoded Void.
  return schema ? rpcResultIssue(schema, value === undefined ? null : value) : null;
}
