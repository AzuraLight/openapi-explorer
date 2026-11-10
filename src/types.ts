// Minimal OpenAPI types (loose — absorbs variance across real-world specs)
export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  basePath?: string; // Swagger 2
  host?: string; // Swagger 2
  schemes?: string[]; // Swagger 2
  consumes?: string[]; // Swagger 2 (global)
  produces?: string[]; // Swagger 2 (global)
  servers?: { url?: string; variables?: Record<string, { default?: string }> }[]; // OpenAPI 3
  // Path Item: operations by method, plus path-level `parameters` (and summary/description/servers).
  paths?: Record<string, Record<string, any>>;
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
  consumes?: string[]; // Swagger 2
  produces?: string[]; // Swagger 2
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
  schema?: Schema; // OpenAPI 3, and Swagger 2 `in: body`
  type?: string; // Swagger 2 non-body parameters (incl. "file" for formData)
  format?: string;
  items?: Schema;
  enum?: unknown[];
}

export interface MediaType {
  schema?: Schema;
}

export interface ResponseObject {
  $ref?: string;
  description?: string;
  content?: Record<string, MediaType>; // OpenAPI 3
  schema?: Schema; // Swagger 2
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

// Structured results
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
