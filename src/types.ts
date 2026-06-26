// 최소한의 OpenAPI 타입 (느슨하게 — 실무 스펙 편차 흡수)
export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  basePath?: string;
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema>; securitySchemes?: Record<string, unknown> };
  definitions?: Record<string, Schema>;
  securityDefinitions?: Record<string, unknown>;
}

export interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, ResponseObject>;
  [k: string]: unknown;
}

export interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
}

export interface MediaType {
  schema?: Schema;
}

export interface ResponseObject {
  $ref?: string;
  description?: string;
  content?: Record<string, MediaType>;
}

export interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  example?: unknown;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  [k: string]: unknown;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
}

export type Fetcher = (url: string) => Promise<HttpResponse>;

// 구조화 결과
export interface EndpointSummary {
  method: string;
  path: string;
  tag: string;
  summary: string;
  operationId?: string;
}

export interface ParamDetail {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description: string;
}

export interface EndpointDetail {
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  parameters: ParamDetail[];
  requestBody: { contentType?: string; schema: string; required: boolean } | null;
  responses: { status: string; description: string; schema: string }[];
}

export interface FieldDetail {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example?: unknown;
}

export interface ModelDetail {
  name: string;
  description: string;
  fields: FieldDetail[];
}
