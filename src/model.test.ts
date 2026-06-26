import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupByTag,
  endpointDetail,
  modelDetail,
  genTsForModel,
  genTsForEndpoint,
  genCurl,
  genFetchClient,
  genAxiosClient,
} from "./model";
import type { OpenApiSpec } from "./types";

// 래퍼 응답({ success, data: Dto })을 가진 미니 스펙
const spec: OpenApiSpec = {
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0" },
  paths: {
    "/learners/{id}": {
      get: {
        tags: ["learners"],
        summary: "학습자 상세",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: "#/components/schemas/LearnerDto" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/learners": {
      get: { tags: ["learners"], summary: "리스트", responses: { "200": { description: "ok" } } },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http" } },
    schemas: {
      LearnerDto: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string", description: "ID" },
          name: { type: "string" },
          tags: { type: "array", items: { $ref: "#/components/schemas/TagDto" } },
          count: { type: "integer" },
        },
      },
      TagDto: { type: "object", properties: { label: { type: "string" } } },
    },
  },
};

test("groupByTag groups endpoints", () => {
  const g = groupByTag(spec);
  assert.equal(g.get("learners")?.length, 2);
});

test("endpointDetail extracts params and response schema (envelope)", () => {
  const d = endpointDetail(spec, "/learners/{id}", "GET")!;
  assert.equal(d.parameters[0].name, "id");
  assert.equal(d.parameters[0].in, "path");
  const ok = d.responses.find((r) => r.status === "200")!;
  assert.match(ok.schema, /LearnerDto/);
});

test("modelDetail lists fields with required flag", () => {
  const m = modelDetail(spec, "LearnerDto")!;
  assert.equal(m.fields.find((f) => f.name === "id")?.required, true);
  // shortType은 스펙 원형(integer)을 보여준다 (TS 생성기만 number로 정규화)
  assert.equal(m.fields.find((f) => f.name === "count")?.type, "integer");
});

test("genTsForModel emits interface + dependent model", () => {
  const ts = genTsForModel(spec, "LearnerDto");
  assert.match(ts, /export interface LearnerDto/);
  assert.match(ts, /export interface TagDto/);
  assert.match(ts, /tags\?: TagDto\[\]/);
  assert.match(ts, /id: string/);
});

test("genTsForEndpoint unwraps envelope and includes models", () => {
  const d = endpointDetail(spec, "/learners/{id}", "GET")!;
  const ts = genTsForEndpoint(spec, d);
  assert.match(ts, /export interface LearnerDto/);
  assert.match(ts, /type Response =/);
  assert.match(ts, /data\?: LearnerDto/);
});

test("genCurl builds command with path placeholder and auth", () => {
  const d = endpointDetail(spec, "/learners/{id}", "GET")!;
  const curl = genCurl(spec, d, "https://api.example.com/api-docs");
  assert.match(curl, /curl -X GET 'https:\/\/api\.example\.com\/learners\/<id>'/);
  assert.match(curl, /Authorization: Bearer <token>/);
});

test("genFetchClient builds typed fetch function with path template", () => {
  const d = endpointDetail(spec, "/learners/{id}", "GET")!;
  const code = genFetchClient(spec, d, "https://api.example.com/api-docs");
  assert.match(code, /export async function/);
  assert.match(code, /id: string/);
  assert.match(code, /https:\/\/api\.example\.com\/learners\/\$\{id\}/);
  assert.match(code, /await fetch\(/);
  assert.match(code, /export interface LearnerDto/);
});

test("genAxiosClient builds axios function", () => {
  const d = endpointDetail(spec, "/learners/{id}", "GET")!;
  const code = genAxiosClient(spec, d, "https://api.example.com/api-docs");
  assert.match(code, /import axios from "axios"/);
  assert.match(code, /await axios\.get</);
  assert.match(code, /https:\/\/api\.example\.com\/learners\/\$\{id\}/);
});
