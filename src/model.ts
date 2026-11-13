// Spec → structuring + TS type / cURL generation
import { resolveRef, getSchemas } from "./specLoader";
import { resolveBaseUrl } from "./servers";
import type {
  OpenApiSpec,
  Schema,
  Operation,
  Parameter,
  ResponseObject,
  EndpointSummary,
  EndpointDetail,
  ModelDetail,
} from "./types";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function refName(ref: string | undefined): string | null {
  return typeof ref === "string" ? (ref.split("/").pop() ?? null) : null;
}

// Short type notation (refs show only the model name, inline objects are expanded shallowly)
export function shortType(schema?: Schema): string {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema.$ref) ?? "any";
  if (schema.allOf) return schema.allOf.map(shortType).join(" & ");
  if (schema.oneOf) return schema.oneOf.map(shortType).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(shortType).join(" | ");
  if (schema.type === "array") return `${shortType(schema.items)}[]`;
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join(" | ");
  if ((schema.type === "object" || !schema.type) && schema.properties) {
    const parts = Object.entries(schema.properties).map(([k, v]) => `${k}: ${shortType(v)}`);
    return `{ ${parts.join("; ")} }`;
  }
  return schema.type || "object";
}

export function listEndpoints(spec: OpenApiSpec): EndpointSummary[] {
  const out: EndpointSummary[] = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const o = op as Operation;
      out.push({
        method: method.toUpperCase(),
        path,
        tag: (o.tags || [])[0] || "Other",
        summary: o.summary || "",
        operationId: o.operationId,
      });
    }
  }
  return out;
}

// Computed once per loaded spec object: expanding many tags must not regroup every endpoint each time.
const groupCache = new WeakMap<OpenApiSpec, Map<string, EndpointSummary[]>>();
export function groupByTag(spec: OpenApiSpec): Map<string, EndpointSummary[]> {
  const cached = groupCache.get(spec);
  if (cached) return cached;
  const groups = new Map<string, EndpointSummary[]>();
  for (const e of listEndpoints(spec)) {
    if (!groups.has(e.tag)) groups.set(e.tag, []);
    groups.get(e.tag)!.push(e);
  }
  groupCache.set(spec, groups);
  return groups;
}

// Resolve a Reference Object. Its own summary/description override the target's
// (OAS 3.1 Reference Object: "SHOULD override that of the referenced component").
function deref<T extends object>(spec: OpenApiSpec, obj: T & { $ref?: string }): T {
  if (!obj || !obj.$ref) return obj;
  const target = resolveRef(spec, obj.$ref) as T | null;
  if (!target) return obj;
  const o = obj as { summary?: string; description?: string };
  return {
    ...target,
    ...(o.summary !== undefined ? { summary: o.summary } : {}),
    ...(o.description !== undefined ? { description: o.description } : {}),
  };
}

// Path-level parameters apply to every operation; an operation parameter with the same
// name + in overrides it (Swagger 2.0 / OAS #pathItemParameters).
function effectiveParameters(spec: OpenApiSpec, path: string, op: Operation): Parameter[] {
  const merged = new Map<string, Parameter>();
  const pathLevel = (spec.paths?.[path]?.parameters as Parameter[] | undefined) || [];
  for (const raw of [...pathLevel, ...(op.parameters || [])]) {
    const p = deref(spec, raw);
    merged.set(`${p.in}:${p.name}`, p);
  }
  return [...merged.values()];
}

// Swagger 2 has no requestBody: `in: body` is the body; `in: formData` params form one
// (multipart if consumes says so or a param is a file, else urlencoded).
function swagger2RequestBody(
  spec: OpenApiSpec,
  op: Operation,
  params: Parameter[]
): EndpointDetail["requestBody"] {
  const consumes = op.consumes || spec.consumes || [];
  const body = params.find((p) => p.in === "body");
  if (body) {
    return {
      contentType: consumes[0] || "application/json",
      schema: shortType(body.schema),
      required: !!body.required,
    };
  }
  const form = params.filter((p) => p.in === "formData");
  if (!form.length) return null;
  const multipart = consumes.includes("multipart/form-data") || form.some((p) => p.type === "file");
  const properties: Record<string, Schema> = {};
  for (const p of form)
    properties[p.name || ""] = { type: p.type, format: p.format, items: p.items, enum: p.enum };
  return {
    contentType: multipart ? "multipart/form-data" : "application/x-www-form-urlencoded",
    schema: shortType({ type: "object", properties }),
    required: form.some((p) => p.required),
  };
}

// Response schema: OpenAPI 3 `content[mime].schema` (first media type), Swagger 2 `schema`.
function responseSchema(r: ResponseObject): Schema | undefined {
  if (r.schema) return r.schema;
  const content = r.content || {};
  const mime = Object.keys(content)[0];
  return mime ? content[mime]?.schema : undefined;
}

// Schema of the first 2xx response (used for the generated response type).
function successResponseSchema(spec: OpenApiSpec, op: Operation | undefined): Schema | undefined {
  const ok = Object.entries(op?.responses || {}).find(([code]) => code.startsWith("2"));
  return ok ? responseSchema(deref(spec, ok[1] as ResponseObject)) : undefined;
}

export function endpointDetail(spec: OpenApiSpec, path: string, method: string): EndpointDetail | null {
  const op = spec.paths?.[path]?.[method.toLowerCase()] as Operation | undefined;
  if (!op) return null;
  const all = effectiveParameters(spec, path, op);
  const parameters = all
    .filter((p) => p.in !== "body" && p.in !== "formData")
    .map((p) => ({
      name: p.name || "",
      in: p.in || "",
      required: !!p.required,
      type: shortType(p.schema || (p as Schema)),
      description: p.description || "",
    }));
  let requestBody: EndpointDetail["requestBody"] = null;
  if (op.requestBody) {
    const rb = deref(spec, op.requestBody as typeof op.requestBody & { $ref?: string });
    const content = rb.content || {};
    const mime = Object.keys(content)[0];
    requestBody = {
      contentType: mime,
      schema: shortType(content[mime]?.schema),
      required: !!rb.required,
    };
  } else if (spec.swagger) {
    requestBody = swagger2RequestBody(spec, op, all);
  }
  const responses = Object.entries(op.responses || {}).map(([code, r]) => {
    const resp = deref(spec, r as ResponseObject);
    const schema = responseSchema(resp);
    return {
      status: code,
      description: resp.description || "",
      schema: schema ? shortType(schema) : "",
    };
  });
  return {
    method: method.toUpperCase(),
    path,
    tag: (op.tags || [])[0] || "",
    summary: op.summary || "",
    description: op.description || "",
    parameters,
    requestBody,
    responses,
  };
}

export function modelDetail(spec: OpenApiSpec, name: string): ModelDetail | null {
  const schema = getSchemas(spec)[name];
  if (!schema) return null;
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const fields = Object.entries(props).map(([k, v]) => ({
    name: k,
    type: shortType(v),
    required: required.has(k),
    description: v.description || "",
    example: v.example,
  }));
  return { name, description: schema.description || "", fields };
}

// ---- TS type generation ----
// Reference: openapi-typescript 7.13.0's actual output (docs/ROADMAP.md, code generation).
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propKey = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

// Parenthesize a union/intersection before `[]` or `&` so precedence stays as written.
const paren = (t: string) => (/[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t);

export function tsType(schema?: Schema): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const t = tsTypeCore(schema);
  // OAS 3.0 `nullable: true` → `| null`
  return schema.nullable === true && !/(^|\| )null$/.test(t) ? `${t} | null` : t;
}

const BLOB = "x-oae-blob"; // marks a multipart file field (see blobFields)

function tsTypeCore(schema: Schema): string {
  if (schema[BLOB]) return "Blob";
  if (schema.$ref) return refName(schema.$ref) ?? "unknown";
  if (schema.allOf) return schema.allOf.map((s) => paren(tsType(s))).join(" & ");
  if (schema.oneOf) return schema.oneOf.map(tsType).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(tsType).join(" | ");
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join(" | ");
  const type = schema.type as unknown;
  // OAS 3.1 type arrays: ["string", "null"] → string | null
  if (Array.isArray(type)) {
    return type.map((x) => (x === "null" ? "null" : tsTypeCore({ ...schema, type: x }))).join(" | ");
  }
  switch (type) {
    case "array":
      return `${paren(tsType(schema.items))}[]`;
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "null":
      return "null";
    case "object":
    case undefined:
      return objectType(schema);
    default:
      return "unknown";
  }
}

function objectType(schema: Schema): string {
  const ap = schema.additionalProperties as Schema | boolean | undefined;
  const parts: string[] = [];
  if (schema.properties) parts.push(inlineObject(schema));
  if (ap === true || (ap && typeof ap === "object")) {
    const v = ap === true || Object.keys(ap).length === 0 ? "unknown" : tsType(ap);
    parts.push(`{\n  [key: string]: ${v};\n}`);
  }
  if (parts.length) return parts.join(" & ");
  return schema.type === "object" ? "Record<string, never>" : "unknown";
}

function inlineObject(schema: Schema): string {
  const req = new Set(schema.required || []);
  const lines = Object.entries(schema.properties || {}).map(
    ([k, v]) => `  ${propKey(k)}${req.has(k) ? "" : "?"}: ${tsType(v)};`
  );
  return `{\n${lines.join("\n")}\n}`;
}

function collectRefs(schema: unknown, set: Set<string>): void {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    schema.forEach((s) => collectRefs(s, set));
    return;
  }
  const s = schema as Schema;
  if (typeof s.$ref === "string") {
    const n = refName(s.$ref);
    if (n) set.add(n);
  }
  collectRefs(s.items, set);
  for (const key of ["allOf", "oneOf", "anyOf"] as const) collectRefs(s[key], set);
  if (s.properties) Object.values(s.properties).forEach((v) => collectRefs(v, set));
  if (s.additionalProperties && typeof s.additionalProperties === "object")
    collectRefs(s.additionalProperties, set);
}

// One model: an interface for a plain object with properties, otherwise a type alias
// (top-level enum, allOf, array, primitives — like openapi-typescript).
function modelBlock(name: string, schema: Schema): string {
  const head = schema.description ? `/** ${schema.description} */\n` : "";
  const plainObject =
    !schema.$ref &&
    !schema.allOf &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.enum &&
    !schema.additionalProperties &&
    !schema.nullable &&
    (schema.type === "object" || schema.type === undefined) &&
    !!schema.properties;
  if (!plainObject) return `${head}export type ${name} = ${tsType(schema)};`;
  const req = new Set(schema.required || []);
  const lines = Object.entries(schema.properties || {}).map(([k, v]) => {
    const doc = v.description ? `  /** ${v.description} */\n` : "";
    return `${doc}  ${propKey(k)}${req.has(k) ? "" : "?"}: ${tsType(v)};`;
  });
  return `${head}export interface ${name} {\n${lines.join("\n")}\n}`;
}

// The model and every model it depends on, each once. Iterative (no recursion): deeply chained
// specs with thousands of models do not overflow the stack.
export function genTsForModel(spec: OpenApiSpec, name: string, seen = new Set<string>()): string {
  const schemas = getSchemas(spec);
  if (!schemas[name]) return seen.has(name) ? "" : `// ${name} (no definition)`;
  const blocks: string[] = [];
  const queue = [name];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (seen.has(n) || !schemas[n]) continue;
    seen.add(n);
    blocks.push(modelBlock(n, schemas[n]));
    const deps = new Set<string>();
    collectRefs(schemas[n], deps);
    for (const d of deps) if (!seen.has(d) && schemas[d]) queue.push(d);
  }
  return blocks.join("\n\n");
}

function modelsFor(spec: OpenApiSpec, schema: Schema | undefined, seen = new Set<string>()): string {
  const deps = new Set<string>();
  collectRefs(schema, deps);
  const blocks: string[] = [];
  for (const d of deps) {
    if (getSchemas(spec)[d]) {
      const b = genTsForModel(spec, d, seen);
      if (b) blocks.push(b);
    }
  }
  return blocks.join("\n\n");
}

export function genTsForEndpoint(spec: OpenApiSpec, detail: EndpointDetail): string {
  const out = `// ${detail.method} ${detail.path}${detail.summary ? `  —  ${detail.summary}` : ""}\n`;
  const schema = successResponseSchema(spec, operationOf(spec, detail));
  if (!schema) return out + `type Response = void;`;
  const models = modelsFor(spec, schema);
  return out + (models ? models + "\n\n" : "") + `type Response = ${tsType(schema)};`;
}

// ---- Client function generation (fetch / axios) ----
function operationOf(spec: OpenApiSpec, detail: EndpointDetail): Operation | undefined {
  return spec.paths?.[detail.path]?.[detail.method.toLowerCase()] as Operation | undefined;
}

function camelize(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts
    .map((p, i) =>
      i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)
    )
    .join("");
}

// A valid identifier: camelCase, with "_" in front when it would start with a digit (or be empty).
function ident(s: string): string {
  const c = camelize(s);
  return /^[A-Za-z_$]/.test(c) ? c : `_${c}`;
}

function fnName(spec: OpenApiSpec, detail: EndpointDetail): string {
  const op = operationOf(spec, detail);
  if (op?.operationId) return ident(op.operationId);
  const segs = detail.path.replace(/[{}]/g, "").split("/").filter(Boolean);
  return ident(`${detail.method.toLowerCase()} ${segs.join(" ")}`);
}

function responseModelsAndType(spec: OpenApiSpec, detail: EndpointDetail): { models: string; type: string } {
  const schema = successResponseSchema(spec, operationOf(spec, detail));
  if (!schema) return { models: "", type: "void" };
  return { models: modelsFor(spec, schema), type: tsType(schema) };
}

// Parameter schema (OAS 3 `schema`, Swagger 2 inline type/items/enum).
function paramSchema(p: Parameter): Schema {
  return p.schema || { type: p.type, format: p.format, items: p.items, enum: p.enum };
}

// Request body: OAS 3 requestBody (first media type), Swagger 2 `in: body` / `in: formData`.
function requestBodyOf(
  spec: OpenApiSpec,
  detail: EndpointDetail
): { schema: Schema | undefined; contentType: string } | null {
  const op = operationOf(spec, detail);
  if (!op) return null;
  if (op.requestBody) {
    const rb = deref(spec, op.requestBody as typeof op.requestBody & { $ref?: string });
    const content = rb.content || {};
    const mime = Object.keys(content)[0];
    return mime ? { schema: content[mime]?.schema, contentType: mime } : null;
  }
  if (!spec.swagger) return null;
  const params = effectiveParameters(spec, detail.path, op);
  const consumes = op.consumes || spec.consumes || [];
  const body = params.find((p) => p.in === "body");
  if (body) return { schema: body.schema, contentType: consumes[0] || "application/json" };
  const form = params.filter((p) => p.in === "formData");
  if (!form.length) return null;
  const properties: Record<string, Schema> = {};
  for (const p of form) {
    properties[p.name || ""] = p.type === "file" ? { type: "string", format: "binary" } : paramSchema(p);
  }
  const required = form.filter((p) => p.required).map((p) => p.name || "");
  const multipart = consumes.includes("multipart/form-data") || form.some((p) => p.type === "file");
  return {
    schema: { type: "object", properties, required },
    contentType: multipart ? "multipart/form-data" : "application/x-www-form-urlencoded",
  };
}

// Properties of a body schema (following one $ref) — for form fields.
function bodyProperties(spec: OpenApiSpec, schema: Schema | undefined): [string, Schema][] {
  const s = schema?.$ref ? getSchemas(spec)[refName(schema.$ref) || ""] : schema;
  return Object.entries(s?.properties || {});
}

// A multipart body's binary fields take a Blob (a file) in the generated function's argument.
function blobFields(spec: OpenApiSpec, schema: Schema | undefined): Schema | undefined {
  const props = bodyProperties(spec, schema);
  if (!props.length) return schema;
  const base = schema?.$ref ? getSchemas(spec)[refName(schema.$ref) || ""] : schema;
  const isBin = (v: Schema) => v.format === "binary" || v.format === "byte";
  const properties = Object.fromEntries(
    props.map(([k, v]) => [
      k,
      isBin(v)
        ? { [BLOB]: true }
        : v.type === "array" && v.items && isBin(v.items)
          ? { type: "array", items: { [BLOB]: true } }
          : v,
    ])
  );
  return { ...base, properties };
}

type BodyKind = "json" | "multipart" | "form";
const bodyKind = (contentType: string): BodyKind =>
  /multipart\/form-data/i.test(contentType)
    ? "multipart"
    : /x-www-form-urlencoded/i.test(contentType)
      ? "form"
      : "json";

// Parameter fragments for the function signature + URL/query/header/body construction
function clientParts(spec: OpenApiSpec, detail: EndpointDetail) {
  const op = operationOf(spec, detail);
  const params = op ? effectiveParameters(spec, detail.path, op) : [];
  const of = (where: string) => params.filter((p) => p.in === where);
  const pathParams = of("path");
  const queryParams = of("query");
  const headerParams = of("header");
  const sig: string[] = [];
  for (const p of pathParams) sig.push(`${ident(p.name || "")}: ${tsType(paramSchema(p))}`);
  const objectArg = (name: string, list: Parameter[]) => {
    const fields = list.map(
      (p) => `${propKey(p.name || "")}${p.required ? "" : "?"}: ${tsType(paramSchema(p))}`
    );
    sig.push(`${name}: { ${fields.join("; ")} }`);
  };
  if (queryParams.length) objectArg("query", queryParams);
  if (headerParams.length) objectArg("headers", headerParams);
  const body = requestBodyOf(spec, detail);
  if (body) {
    const bodySchema =
      bodyKind(body.contentType) === "multipart" ? blobFields(spec, body.schema) : body.schema;
    sig.push(`body: ${tsType(bodySchema)}`);
  }
  let pathExpr = detail.path;
  for (const p of pathParams) pathExpr = pathExpr.split(`{${p.name}}`).join(`\${${ident(p.name || "")}}`);
  const headerEntries = headerParams.map(
    (p) => `${JSON.stringify(p.name)}: headers[${JSON.stringify(p.name)}]`
  );
  return { sig: sig.join(", "), pathExpr, hasQuery: queryParams.length > 0, headerEntries, body };
}

// Query string from the query object: unset values are left out, arrays repeat the key (form, explode).
const QS_LINES = `  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x));
  }`;

// Form body from the body object: FormData (multipart, files as Blob) or URLSearchParams (urlencoded).
function formLines(kind: BodyKind): string {
  const value = kind === "multipart" ? "x instanceof Blob ? x : String(x)" : "String(x)";
  return `  const form = new ${kind === "multipart" ? "FormData" : "URLSearchParams"}();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) form.append(k, ${value});
  }`;
}

export function genFetchClient(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = resolveBaseUrl(spec, baseUrl);
  const name = fnName(spec, detail);
  const { models, type } = responseModelsAndType(spec, detail);
  const { sig, pathExpr, hasQuery, headerEntries, body } = clientParts(spec, detail);
  const pre: string[] = [];
  if (hasQuery) pre.push(QS_LINES);
  const reqHeaders = [...headerEntries];
  let bodyExpr = "";
  if (body) {
    const kind = bodyKind(body.contentType);
    if (kind === "json") {
      reqHeaders.unshift(`"Content-Type": ${JSON.stringify(body.contentType || "application/json")}`);
      bodyExpr = "JSON.stringify(body)";
    } else {
      // multipart: no Content-Type — fetch sets multipart/form-data with its boundary.
      pre.push(formLines(kind));
      if (kind === "form") reqHeaders.unshift(`"Content-Type": "application/x-www-form-urlencoded"`);
      bodyExpr = "form";
    }
  }
  const urlExpr = hasQuery ? `\`${origin}${pathExpr}?\${qs}\`` : `\`${origin}${pathExpr}\``;
  const init = [`    method: "${detail.method}"`];
  if (reqHeaders.length) init.push(`    headers: { ${reqHeaders.join(", ")} }`);
  if (bodyExpr) init.push(`    body: ${bodyExpr}`);
  // void (e.g. 204): no body to parse.
  const ret = type === "void" ? "" : `\n  return res.json() as Promise<${type}>;`;
  const head = models ? `${models}\n\n` : "";
  return `${head}// ${detail.method} ${detail.path}${detail.summary ? `  —  ${detail.summary}` : ""}
export async function ${name}(${sig}): Promise<${type}> {
${pre.length ? pre.join("\n") + "\n" : ""}  const res = await fetch(${urlExpr}, {
${init.join(",\n")},
  });
  if (!res.ok) throw new Error(\`${name} failed: \${res.status}\`);${ret}
}`;
}

export function genAxiosClient(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = resolveBaseUrl(spec, baseUrl);
  const name = fnName(spec, detail);
  const { models, type } = responseModelsAndType(spec, detail);
  const { sig, pathExpr, hasQuery, headerEntries, body } = clientParts(spec, detail);
  const pre: string[] = [];
  const cfg: string[] = [];
  if (hasQuery) cfg.push(`    params: query`); // axios leaves out undefined params
  if (headerEntries.length) cfg.push(`    headers: { ${headerEntries.join(", ")} }`);
  const method = detail.method.toLowerCase();
  const withData = /^(post|put|patch)$/.test(method);
  const args = [`\`${origin}${pathExpr}\``];
  if (body) {
    const kind = bodyKind(body.contentType);
    if (kind === "json") args.push("body");
    else {
      pre.push(formLines(kind));
      args.push("form");
    }
  } else if (cfg.length && withData) {
    args.push("undefined");
  }
  if (cfg.length) args.push(`{\n${cfg.join(",\n")},\n  }`);
  const head = models ? `${models}\n\n` : "";
  return `${head}import axios from "axios";

// ${detail.method} ${detail.path}${detail.summary ? `  —  ${detail.summary}` : ""}
export async function ${name}(${sig}): Promise<${type}> {
${pre.length ? pre.join("\n") + "\n" : ""}  const res = await axios.${method}<${type}>(${args.join(", ")});
  return res.data;
}`;
}

// ---- Request body example (JSON) generation ----
function exampleForSchema(spec: OpenApiSpec, schema: Schema | undefined, seen = new Set<string>()): unknown {
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (name && !seen.has(name)) {
      seen.add(name);
      const resolved = getSchemas(spec)[name];
      return exampleForSchema(spec, resolved, seen);
    }
    return {};
  }
  if (schema.allOf) {
    return Object.assign({}, ...schema.allOf.map((s) => exampleForSchema(spec, s, seen)));
  }
  if (schema.enum && schema.enum.length) return schema.enum[0];
  if (schema.type === "array") return [exampleForSchema(spec, schema.items, seen)];
  if ((schema.type === "object" || !schema.type) && schema.properties) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) obj[k] = exampleForSchema(spec, v, seen);
    return obj;
  }
  switch (schema.type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string":
      return schema.format === "date-time" ? new Date(0).toISOString() : "";
    default:
      return null;
  }
}

export function exampleRequestBody(spec: OpenApiSpec, detail: EndpointDetail): string {
  const op = spec.paths?.[detail.path]?.[detail.method.toLowerCase()] as Operation | undefined;
  const content = op?.requestBody?.content || {};
  const mime = Object.keys(content)[0];
  const schema = mime ? content[mime].schema : null;
  if (!schema) return "";
  try {
    return JSON.stringify(exampleForSchema(spec, schema), null, 2);
  } catch {
    return "";
  }
}

// ---- cURL generation ----
export function genCurl(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = resolveBaseUrl(spec, baseUrl);
  let path = detail.path;
  const query: string[] = [];
  for (const p of detail.parameters) {
    if (p.in === "path") path = path.replace(`{${p.name}}`, `<${p.name}>`);
    if (p.in === "query") query.push(`${p.name}=<${p.name}>`);
  }
  const qs = query.length ? `?${query.join("&")}` : "";
  const headerLines = detail.parameters
    .filter((p) => p.in === "header")
    .map((p) => ` \\\n  -H '${p.name}: <${p.name}>'`)
    .join("");
  const hasAuth = !!(spec.components?.securitySchemes || spec.securityDefinitions);
  const auth = hasAuth ? ` \\\n  -H 'Authorization: Bearer <token>'` : "";
  let body = "";
  const rb = requestBodyOf(spec, detail);
  if (rb) {
    const kind = bodyKind(rb.contentType);
    const props = bodyProperties(spec, rb.schema);
    if (kind === "multipart") {
      // curl -F builds the multipart body and its boundary itself; "@" uploads a file.
      body = props.map(([k, v]) => ` \\\n  -F '${k}=${v.format === "binary" ? "@" : ""}<${k}>'`).join("");
    } else if (kind === "form") {
      body = props.map(([k]) => ` \\\n  --data-urlencode '${k}=<${k}>'`).join("");
    } else {
      body = ` \\\n  -H 'Content-Type: ${rb.contentType || "application/json"}' \\\n  -d '{ /* ${detail.requestBody?.schema ?? ""} */ }'`;
    }
  }
  return `curl -X ${detail.method} '${origin}${path}${qs}'${headerLines}${auth}${body}`;
}
