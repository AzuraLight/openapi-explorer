<!-- 언어: [English](README.md) · **한국어** -->

# OpenAPI Explorer

> 에디터를 벗어나지 않고 Swagger/OpenAPI 게이트웨이를 탐색·검색·호출합니다.

라이브 Swagger/OpenAPI 스펙을 사이드바 트리 + 내장 Swagger UI로 보여주는 VS Code / Cursor
익스텐션. 더 이상 크롬으로 Swagger UI 페이지를 열 필요가 없습니다.

![OpenAPI Explorer](media/icon.png)

## 기능

- **사이드바 트리** — 태그 → 엔드포인트, `Models` 노드로 DTO 목록. 메서드별 색상 아이콘.
- **Swagger UI 점프** — 엔드포인트/모델 클릭 시 내장 Swagger UI가 코드 **옆(Beside)** 에 열려
  해당 위치로 딥링크/스크롤되며, 포커스를 뺏지 않습니다(`preserveFocus`).
- **Try it out (확장 경유)** — 요청을 확장 호스트(Node)에서 직접 보내므로 **CORS 없이** 동작하고
  토큰·프록시·사설 CA가 그대로 적용됩니다.
- **Swagger UI 임베드** — 익숙한 UI를 번들 에셋으로 렌더 → **오프라인/방화벽 환경 OK**.
- **엔드포인트 검색 팔레트** — 메서드/경로/요약 퍼지 검색 후 바로 점프(`Cmd/Ctrl+Alt+/`).
- **코드 생성** — 트리 항목 우클릭으로 응답 타입(TS, 의존 모델·JSDoc·래퍼 응답 전개) /
  `fetch`·`axios` 호출 함수 / cURL 복사.
- **다중 게이트웨이** — `swaggerViewer.specs`에 여러 스펙을 등록하고 서비스별 전환.
- **UI URL 자동 변환** — `.../api-docs`(Swagger UI 페이지) 주소를 넣어도 실제 스펙
  (`/api-docs-json`, `/v3/api-docs` 등)을 자동 탐색.
- **사내 환경 지원** — 프록시, 사설 CA 인증서, `strictSSL` 토글, 인증 토큰(SecretStorage)·커스텀 헤더.

## 사용법

1. **OpenAPI: URL 설정** 으로 스펙 또는 문서 페이지 URL(`.../api-docs` 가능)을 입력합니다.
2. 트리를 탐색하거나 **OpenAPI: 엔드포인트 검색**(`Cmd/Ctrl+Alt+/`)을 사용합니다.
3. 엔드포인트를 클릭해 Swagger UI에서 열고, 우클릭으로 코드를 생성합니다.

인증이 필요한 API는 **OpenAPI: 인증 토큰 설정** 을 실행하세요. 토큰은 OS 키체인(SecretStorage)에
저장되어 `Authorization: Bearer …` 로 전송됩니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `swaggerViewer.url` | `""` | 기본 스펙 URL. UI 페이지(`api-docs`) 주소도 자동 탐색됩니다. |
| `swaggerViewer.specs` | `[]` | 다중 게이트웨이 등록: `[{ "name": "Gateway", "url": "https://api.example.com/api-docs" }]`. |
| `swaggerViewer.headers` | `{}` | 스펙 요청 시 추가할 HTTP 헤더. |
| `swaggerViewer.strictSSL` | `true` | TLS 인증서 검증. 사설 인증서 환경에서만 `false`. |
| `swaggerViewer.caCertPath` | `""` | 사내 사설 CA 인증서(PEM) 경로. |
| `swaggerViewer.proxy` | `""` | 프록시 URL. 비우면 VS Code `http.proxy` 또는 `HTTPS_PROXY`/`HTTP_PROXY` 사용. |

> 설정 키는 기존 호환을 위해 `swaggerViewer.*` 접두사를 유지합니다.

## 보안 메모

- 인증 토큰은 설정 파일이 아니라 OS 키체인(VS Code SecretStorage)에 저장됩니다.
- 자격증명(`Authorization`/`Cookie`)은 **크로스-오리진 리다이렉트 시 제거**되고, 스펙 origin과
  동일 호스트로만 전송됩니다 → 악의적 `servers` 항목으로 토큰이 유출되지 않습니다.
- `strictSSL: false`는 사설 인증서 환경의 임시 우회용입니다. 가능하면 `caCertPath`로 CA를 지정하세요.

## 개발

```bash
npm install
npm run build        # dist/extension.js 번들 (esbuild)
npm run watch        # 변경 시 자동 빌드
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm test             # 단위 테스트 (node:test)
```

> 마켓플레이스 아이콘(`media/icon.png`)은 `media/icon.svg`에서 렌더해 커밋한 정적 에셋입니다.

`F5`(Run Extension)로 Extension Development Host를 띄워 디버깅합니다.

## 패키징 (.vsix)

```bash
npm run package      # openapi-explorer-<version>.vsix 생성
```

`.vsix`는 확장 패널 `···` → **Install from VSIX…** 또는
`cursor --install-extension openapi-explorer-<version>.vsix` 로 설치합니다.

## 한계

- **JSON 스펙 전용** — YAML 스펙은 아직 파싱하지 않습니다(`js-yaml` 추가로 확장 가능).
- **AI 연동(MCP)** — 클로드/Cursor가 스펙을 직접 조회하길 원하면 형제 프로젝트 `swagger-mcp` 참고.

## 라이선스

[MIT](LICENSE) © AzuraLight
