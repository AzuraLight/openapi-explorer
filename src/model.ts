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

export function groupByTag(spec: OpenApiSpec): Map<string, EndpointSummary[]> {
  const groups = new Map<string, EndpointSummary[]>();
  for (const e of listEndpoints(spec)) {
    if (!groups.has(e.tag)) groups.set(e.tag, []);
    groups.get(e.tag)!.push(e);
  }
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
function swagger2RequestBody(spec: OpenApiSpec, op: Operation, params: Parameter[]): EndpointDetail["requestBody"] {
  const consumes = op.consumes || spec.consumes || [];
  const body = params.find((p) => p.in === "body");
  if (body) {
    return { contentType: consumes[0] || "application/json", schema: shortType(body.schema), required: !!body.required };
  }
  const form = params.filter((p) => p.in === "formData");
  if (!form.length) return null;
  const multipart = consumes.includes("multipart/form-data") || form.some((p) => p.type === "file");
  const properties: Record<string, Schema> = {};
  for (const p of form) properties[p.name || ""] = { type: p.type, format: p.format, items: p.items, enum: p.enum };
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
export function tsType(schema?: Schema): string {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema.$ref) ?? "any";
  if (schema.allOf) return schema.allOf.map(tsType).join(" & ");
  if (schema.oneOf) return schema.oneOf.map(tsType).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(tsType).join(" | ");
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (schema.type === "array") return `${tsType(schema.items)}[]`;
  switch (schema.type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "object":
      if (schema.properties) return inlineObject(schema);
      return "Record<string, any>";
    default:
      if (schema.properties) return inlineObject(schema);
      return "any";
  }
}

function inlineObject(schema: Schema): string {
  const req = new Set(schema.required || []);
  const lines = Object.entries(schema.properties || {}).map(
    ([k, v]) => `  ${k}${req.has(k) ? "" : "?"}: ${tsType(v)};`
  );
  return `{\n${lines.join("\n")}\n}`;
}

function collectRefs(schema: Schema | undefined, set: Set<string>): void {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    const n = refName(schema.$ref);
    if (n) set.add(n);
  }
  if (schema.items) collectRefs(schema.items, set);
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const arr = schema[key];
    if (Array.isArray(arr)) arr.forEach((s) => collectRefs(s, set));
  }
  if (schema.properties) Object.values(schema.properties).forEach((s) => collectRefs(s, set));
}

export function genTsForModel(spec: OpenApiSpec, name: string, seen = new Set<string>()): string {
  if (seen.has(name)) return "";
  seen.add(name);
  const schemas = getSchemas(spec);
  const schema = schemas[name];
  if (!schema) return `// ${name} (no definition)`;
  const req = new Set(schema.required || []);
  const deps = new Set<string>();
  const lines = Object.entries(schema.properties || {}).map(([k, v]) => {
    collectRefs(v, deps);
    const doc = v.description ? `  /** ${v.description} */\n` : "";
    return `${doc}  ${k}${req.has(k) ? "" : "?"}: ${tsType(v)};`;
  });
  const head = schema.description ? `/** ${schema.description} */\n` : "";
  let out = `${head}export interface ${name} {\n${lines.join("\n")}\n}`;
  for (const d of deps) {
    if (d !== name && schemas[d]) {
      const sub = genTsForModel(spec, d, seen);
      if (sub) out += `\n\n${sub}`;
    }
  }
  return out;
}

export function genTsForEndpoint(spec: OpenApiSpec, detail: EndpointDetail): string {
  const seen = new Set<string>();
  let out = `// ${detail.method} ${detail.path}${detail.summary ? `  —  ${detail.summary}` : ""}\n`;

  const op = spec.paths?.[detail.path]?.[detail.method.toLowerCase()] as Operation | undefined;
  const schema = successResponseSchema(spec, op);

  if (!schema) {
    out += `type Response = void;`;
    return out;
  }
  const deps = new Set<string>();
  collectRefs(schema, deps);
  const blocks: string[] = [];
  for (const d of deps) {
    if (getSchemas(spec)[d]) {
      const b = genTsForModel(spec, d, seen);
      if (b) blocks.push(b);
    }
  }
  if (blocks.length) out += blocks.join("\n\n") + "\n\n";
  out += `type Response = ${tsType(schema)};`;
  return out;
}

// ---- Client function generation (fetch / axios) ----
function camelize(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9]+/g, " ").trim();
  const parts = cleaned.split(/\s+/);
  return parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

function fnName(spec: OpenApiSpec, detail: EndpointDetail): string {
  const op = spec.paths?.[detail.path]?.[detail.method.toLowerCase()] as Operation | undefined;
  if (op?.operationId) return camelize(op.operationId);
  const segs = detail.path.replace(/[{}]/g, "").split("/").filter(Boolean);
  return camelize(`${detail.method.toLowerCase()} ${segs.join(" ")}`);
}

function responseModelsAndType(spec: OpenApiSpec, detail: EndpointDetail): { models: string; type: string } {
  const op = spec.paths?.[detail.path]?.[detail.method.toLowerCase()] as Operation | undefined;
  const schema = successResponseSchema(spec, op);
  if (!schema) return { models: "", type: "void" };
  const seen = new Set<string>();
  const deps = new Set<string>();
  collectRefs(schema, deps);
  const blocks: string[] = [];
  for (const d of deps) {
    if (getSchemas(spec)[d]) {
      const b = genTsForModel(spec, d, seen);
      if (b) blocks.push(b);
    }
  }
  return { models: blocks.join("\n\n"), type: tsType(schema) };
}

// Parameter fragments for the function signature + URL/query/body construction
function clientParts(detail: EndpointDetail) {
  const pathParams = detail.parameters.filter((p) => p.in === "path");
  const queryParams = detail.parameters.filter((p) => p.in === "query");
  const sig: string[] = [];
  for (const p of pathParams) sig.push(`${p.name}: ${tsParamType(p.type)}`);
  if (queryParams.length) {
    const q = queryParams.map((p) => `${p.name}${p.required ? "" : "?"}: ${tsParamType(p.type)}`).join("; ");
    sig.push(`query: { ${q} }`);
  }
  if (detail.requestBody) sig.push(`body: ${detail.requestBody.schema || "unknown"}`);
  const pathExpr = detail.path.replace(/\{(\w+)\}/g, "${$1}");
  return { sig: sig.join(", "), pathExpr, hasQuery: queryParams.length > 0, hasBody: !!detail.requestBody };
}

// shortType (integer, etc.) → TS parameter type
function tsParamType(t: string): string {
  if (t === "integer") return "number";
  return t || "string";
}

export function genFetchClient(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = resolveBaseUrl(spec, baseUrl);
  const name = fnName(spec, detail);
  const { models, type } = responseModelsAndType(spec, detail);
  const { sig, pathExpr, hasQuery, hasBody } = clientParts(detail);
  const qInit = hasQuery
    ? `\n  const qs = new URLSearchParams(query as Record<string, string>).toString();`
    : "";
  const urlExpr = hasQuery ? `\`${origin}${pathExpr}?\${qs}\`` : `\`${origin}${pathExpr}\``;
  const init = [`    method: "${detail.method}"`, `    headers: { "Content-Type": "application/json" }`];
  if (hasBody) init.push(`    body: JSON.stringify(body)`);
  const head = models ? `${models}\n\n` : "";
  return `${head}// ${detail.method} ${detail.path}${detail.summary ? `  —  ${detail.summary}` : ""}
export async function ${name}(${sig}): Promise<${type}> {${qInit}
  const res = await fetch(${urlExpr}, {
${init.join(",\n")},
  });
  if (!res.ok) throw new Error(\`${name} failed: \${res.status}\`);
  return res.json() as Promise<${type}>;
}`;
}

export function genAxiosClient(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = resolveBaseUrl(spec, baseUrl);
  const name = fnName(spec, detail);
  const { models, type } = responseModelsAndType(spec, detail);
  const { sig, pathExpr, hasQuery, hasBody } = clientParts(detail);
  const cfg: string[] = [];
  if (hasQuery) cfg.push(`    params: query`);
  const args = [`\`${origin}${pathExpr}\``];
  const method = detail.method.toLowerCase();
  if (hasBody) args.push(`body`);
  if (cfg.length) args.push(`{\n${cfg.join(",\n")},\n  }`);
  const head = models ? `${models}\n\n` : "";
  return `${head}import axios from "axios";

// ${detail.method} ${detail.path}${detail.summary ? `  —  ${detail.summary}` : ""}
export async function ${name}(${sig}): Promise<${type}> {
  const res = await axios.${method}<${type}>(${args.join(", ")});
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
  if (detail.requestBody) {
    body = ` \\\n  -H 'Content-Type: ${detail.requestBody.contentType || "application/json"}' \\\n  -d '{ /* ${detail.requestBody.schema} */ }'`;
  }
  return `curl -X ${detail.method} '${origin}${path}${qs}'${headerLines}${auth}${body}`;
}
