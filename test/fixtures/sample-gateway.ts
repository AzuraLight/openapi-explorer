// Sample gateway: a springdoc-style server with a realistic, large spec — for reproducing UI issues
// without a real company gateway. Run: `npm run sample:gateway` (prints the URLs to register).
//
// Shape follows springdoc defaults (https://springdoc.org/properties.html):
//   /swagger-ui/index.html         Swagger UI page (spec URL not inline, like springdoc)
//   /v3/api-docs/swagger-config    { urls: [...groups] }
//   /v3/api-docs/<group>           OpenAPI 3.0 spec per group
//   /v3/api-docs                   all groups merged
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const LOREM =
  "이 API는 학습 관리 시스템의 핵심 기능을 제공합니다. 요청 시 인증 토큰이 필요하며, " +
  "응답은 공통 래퍼(`success`, `data`, `error`)로 감싸서 반환합니다.";

// Domains → tags (Korean names with spaces, like real Korean backends).
const DOMAINS: { group: string; tags: string[]; entity: string }[] = [
  {
    group: "learning",
    tags: ["학습자 관리", "강좌 관리", "수강 신청", "학습 진도", "평가 관리"],
    entity: "Learner",
  },
  { group: "admin", tags: ["관리자 계정", "권한 관리", "공지사항", "시스템 설정"], entity: "Admin" },
  { group: "billing", tags: ["결제 관리", "환불 처리", "정산 리포트", "쿠폰 관리"], entity: "Payment" },
];

function schemaSet(entity: string, tag: string, i: number) {
  const base = `${entity}${i}`;
  return {
    [`${base}Dto`]: {
      type: "object",
      description: `${tag} 응답 DTO`,
      required: ["id"],
      properties: {
        id: { type: "integer", format: "int64", description: "식별자" },
        name: { type: "string", description: "이름", example: "홍길동" },
        status: { type: "string", enum: ["ACTIVE", "INACTIVE", "DELETED"] },
        createdAt: { type: "string", format: "date-time" },
        detail: { $ref: `#/components/schemas/${base}Detail` },
        items: { type: "array", items: { $ref: `#/components/schemas/${base}Item` } },
      },
    },
    [`${base}Detail`]: {
      type: "object",
      properties: {
        memo: { type: "string", nullable: true },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    [`${base}Item`]: {
      type: "object",
      properties: { seq: { type: "integer" }, title: { type: "string" }, score: { type: "number" } },
    },
    [`${base}CreateRequest`]: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", maxLength: 50 }, memo: { type: "string" } },
    },
  };
}

const envelope = (ref: string) => ({
  type: "object",
  properties: {
    success: { type: "boolean" },
    data: { $ref: ref },
    error: { type: "string", nullable: true },
  },
});

function buildGroupSpec(d: (typeof DOMAINS)[number], baseIndex: number) {
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};
  const seen = new Map<string, number>(); // springdoc appends _1, _2 to duplicate operationIds
  const opId = (name: string) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n === 0 ? name : `${name}_${n}`;
  };
  d.tags.forEach((tag, t) => {
    const i = baseIndex + t;
    const res = `/api/v1/${d.group}/r${i}`;
    Object.assign(schemas, schemaSet(d.entity, tag, i));
    const dto = `#/components/schemas/${d.entity}${i}Dto`;
    const ok = (ref: string, desc = "성공") => ({
      "200": { description: desc, content: { "application/json": { schema: envelope(ref) } } },
      "400": { description: "잘못된 요청" },
      "401": { description: "인증 필요" },
    });
    paths[res] = {
      get: {
        tags: [tag],
        summary: `${tag} 목록 조회`,
        description: `${LOREM}\n\n- 페이지네이션 지원\n- 정렬: \`createdAt,desc\``,
        operationId: opId("getList"),
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 0 } },
          { name: "size", in: "query", schema: { type: "integer", default: 20 } },
          { name: "keyword", in: "query", schema: { type: "string" } },
        ],
        responses: ok(dto),
      },
      post: {
        tags: [tag],
        summary: `${tag} 등록`,
        operationId: opId("create"),
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: `#/components/schemas/${d.entity}${i}CreateRequest` } },
          },
        },
        responses: ok(dto, "등록됨"),
      },
    };
    paths[`${res}/{id}`] = {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", format: "int64" } }],
      get: {
        tags: [tag],
        summary: `${tag} 상세 조회`,
        description: LOREM,
        operationId: opId("getOne"),
        responses: ok(dto),
      },
      put: {
        tags: [tag],
        summary: `${tag} 수정`,
        operationId: opId("update"),
        requestBody: {
          content: {
            "application/json": { schema: { $ref: `#/components/schemas/${d.entity}${i}CreateRequest` } },
          },
        },
        responses: ok(dto),
      },
      delete: {
        tags: [tag],
        summary: `${tag} 삭제`,
        operationId: opId("remove"),
        responses: { "204": { description: "삭제됨" } },
      },
    };
    paths[`${res}/{id}/items`] = {
      get: {
        tags: [tag],
        summary: `${tag} 하위 항목`,
        operationId: opId("getItems"),
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: ok(`#/components/schemas/${d.entity}${i}Item`),
      },
    };
  });
  return {
    openapi: "3.0.1",
    info: {
      title: `Sample ${d.group} API`,
      version: "v1",
      description: `# ${d.group} 서비스\n\n${LOREM}\n\n## 인증\n\nBearer 토큰을 \`Authorization\` 헤더에 넣으세요.\n\n${"| 코드 | 의미 |\n|---|---|\n| E001 | 잘못된 입력 |\n| E002 | 권한 없음 |\n"}`,
    },
    servers: [{ url: "/", description: "Generated server url" }],
    tags: d.tags.map((name) => ({ name, description: `${name} API` })),
    paths,
    components: {
      schemas,
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    },
    security: [{ bearerAuth: [] }],
  };
}

export function buildSampleSpecs() {
  const groups: Record<string, any> = {};
  let idx = 0;
  for (const d of DOMAINS) {
    groups[d.group] = buildGroupSpec(d, idx);
    idx += d.tags.length;
  }
  const all = {
    ...groups[DOMAINS[0].group],
    info: { ...groups[DOMAINS[0].group].info, title: "Sample Gateway (all)" },
    tags: DOMAINS.flatMap((d) => groups[d.group].tags),
    paths: Object.assign({}, ...DOMAINS.map((d) => groups[d.group].paths)),
    components: {
      ...groups[DOMAINS[0].group].components,
      schemas: Object.assign({}, ...DOMAINS.map((d) => groups[d.group].components.schemas)),
    },
  };
  return { groups, all };
}

const UI_HTML = `<!DOCTYPE html><html><head><title>Swagger UI</title></head>
<body><div id="swagger-ui"></div><script src="./swagger-initializer.js"></script></body></html>`;

export function startSampleGateway(
  port = 0,
  host = "127.0.0.1"
): Promise<{ origin: string; close(): Promise<void> }> {
  const { groups, all } = buildSampleSpecs();
  const routes: Record<string, () => { type: string; body: string }> = {
    "/swagger-ui/index.html": () => ({ type: "text/html; charset=utf-8", body: UI_HTML }),
    "/v3/api-docs": () => ({ type: "application/json", body: JSON.stringify(all) }),
    "/v3/api-docs/swagger-config": () => ({
      type: "application/json",
      body: JSON.stringify({
        configUrl: "/v3/api-docs/swagger-config",
        urls: Object.keys(groups).map((g) => ({ name: g, url: `/v3/api-docs/${g}` })),
        validatorUrl: "",
      }),
    }),
  };
  for (const g of Object.keys(groups))
    routes[`/v3/api-docs/${g}`] = () => ({ type: "application/json", body: JSON.stringify(groups[g]) });
  const server = http.createServer((req, res) => {
    const pathOnly = (req.url || "").split("?")[0];
    const r = routes[pathOnly];
    // Try it out: answer the sample API paths with believable data (envelope like the spec says).
    if (!r && pathOnly.startsWith("/api/v1/")) {
      res.setHeader("content-type", "application/json");
      if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
        return;
      }
      const one = (id: number) => ({
        id,
        name: ["홍길동", "김민지", "이서준"][id % 3],
        status: "ACTIVE",
        createdAt: new Date(Date.UTC(2026, 10, 1 + id, 9)).toISOString(),
        detail: { memo: null, tags: ["beginner"], meta: { cohort: "2026-11" } },
        items: [{ seq: 1, title: "OT", score: 92.5 }],
      });
      const idMatch = /\/(\d+)(?:\/|$)/.exec(pathOnly);
      const data = idMatch ? one(Number(idMatch[1])) : [one(1), one(2), one(3)];
      res.end(JSON.stringify({ success: true, data, error: null }, null, 2));
      return;
    }
    if (!r) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const { type, body } = r();
    res.setHeader("content-type", type);
    res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(port, host, () => {
      const origin = `http://${host}:${(server.address() as AddressInfo).port}`;
      resolve({ origin, close: () => new Promise((r) => server.close(() => r())) });
    })
  );
}

if (require.main === module) {
  startSampleGateway(Number(process.env.PORT) || 8089).then(({ origin }) => {
    console.log(`Sample gateway: ${origin}/swagger-ui/index.html`);
    console.log(
      `Register in settings: "swaggerViewer.specs": [{ "name": "sample", "url": "${origin}/swagger-ui/index.html" }]`
    );
  });
}
