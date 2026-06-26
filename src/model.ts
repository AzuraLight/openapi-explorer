// 스펙 → 구조화 + TS 타입 / cURL 생성
import { resolveRef, getSchemas } from "./specLoader";
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

// 짧은 타입 표기 (ref는 모델 이름만, 인라인 객체는 얕게 전개)
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
        tag: (o.tags || [])[0] || "기타",
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

export function endpointDetail(spec: OpenApiSpec, path: string, method: string): EndpointDetail | null {
  const op = spec.paths?.[path]?.[method.toLowerCase()] as Operation | undefined;
  if (!op) return null;
  const parameters = (op.parameters || []).map((p: Parameter) => {
    const ref = (p.$ref ? (resolveRef(spec, p.$ref) as Parameter) : p) || p;
    return {
      name: ref.name || "",
      in: ref.in || "",
      required: !!ref.required,
      type: shortType(ref.schema || (ref as Schema)),
      description: ref.description || "",
    };
  });
  let requestBody: EndpointDetail["requestBody"] = null;
  if (op.requestBody) {
    const content = op.requestBody.content || {};
    const mime = Object.keys(content)[0];
    requestBody = {
      contentType: mime,
      schema: shortType(content[mime]?.schema),
      required: !!op.requestBody.required,
    };
  }
  const responses = Object.entries(op.responses || {}).map(([code, r]) => {
    const ref = ((r as ResponseObject).$ref
      ? (resolveRef(spec, (r as ResponseObject).$ref!) as ResponseObject)
      : r) as ResponseObject;
    const content = ref.content || {};
    const mime = Object.keys(content)[0];
    return {
      status: code,
      description: ref.description || "",
      schema: mime ? shortType(content[mime]?.schema) : "",
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

// ---- TS 타입 생성 ----
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
  if (!schema) return `// ${name} (정의 없음)`;
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
  const okEntry = Object.entries(op?.responses || {}).find(([code]) => code.startsWith("2"));
  const okRef = okEntry
    ? (okEntry[1] as ResponseObject).$ref
      ? (resolveRef(spec, (okEntry[1] as ResponseObject).$ref!) as ResponseObject)
      : (okEntry[1] as ResponseObject)
    : null;
  const content = okRef?.content || {};
  const mime = Object.keys(content)[0];
  const schema = mime ? content[mime].schema : null;

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

// ---- 클라이언트 함수 생성 (fetch / axios) ----
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
  const okEntry = Object.entries(op?.responses || {}).find(([code]) => code.startsWith("2"));
  const okRef = okEntry
    ? (okEntry[1] as ResponseObject).$ref
      ? (resolveRef(spec, (okEntry[1] as ResponseObject).$ref!) as ResponseObject)
      : (okEntry[1] as ResponseObject)
    : null;
  const content = okRef?.content || {};
  const mime = Object.keys(content)[0];
  const schema = mime ? content[mime].schema : null;
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

// 함수 시그니처용 파라미터 조각 + URL/쿼리/바디 구성
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

// shortType(integer 등) → TS 파라미터 타입
function tsParamType(t: string): string {
  if (t === "integer") return "number";
  return t || "string";
}

export function genFetchClient(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = safeOrigin(spec, baseUrl);
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
  if (!res.ok) throw new Error(\`${name} 실패: \${res.status}\`);
  return res.json() as Promise<${type}>;
}`;
}

export function genAxiosClient(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = safeOrigin(spec, baseUrl);
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

function safeOrigin(spec: OpenApiSpec, baseUrl: string): string {
  try {
    return new URL(baseUrl).origin + (spec.basePath || "");
  } catch {
    return baseUrl;
  }
}

// ---- 요청 바디 예시(JSON) 생성 ----
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

// ---- cURL 생성 ----
export function genCurl(spec: OpenApiSpec, detail: EndpointDetail, baseUrl: string): string {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin + (spec.basePath || "");
    } catch {
      return baseUrl;
    }
  })();
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
