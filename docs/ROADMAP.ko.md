<!-- 언어: [English](ROADMAP.md) · **한국어** -->

# OpenAPI Explorer 로드맵

기준일: 2026-11-10 · 기준 판: 1.1.0 (`2bed03b`)

## 원칙

1. 지금 있는 기능이 틀리게 도는 것(특히 보안)을 먼저 고친다. 그다음이 기능 추가다.
2. 기능 추가는 다른 모든 기능이 의존하는 "스펙 읽기"부터 한다.
3. 판마다 재현 시험을 먼저 저장소에 넣어 실패를 확인한 뒤 고친다.
4. 동작 기준은 명세와 업계 도구에서 가져오고, 출처를 남긴다.

## 위치 — 하는 것과 하지 않는 것

- 차별점: 원격 URL 트리 탐색과 UI 페이지 주소에서 스펙 자동 탐지.
- 하지 않음: 스펙 lint·편집 — 42Crunch, Redocly가 이미 강하다.
  - https://marketplace.visualstudio.com/items?itemName=42Crunch.vscode-openapi
  - https://marketplace.visualstudio.com/items?itemName=Redocly.openapi-vs-code

## 확인된 결함 (1.1.0)

재현 방법: 실제 `src/*.ts`를 가짜 `vscode` 모듈과 로컬 HTTP 서버 위에서 실행하고, 웹뷰 HTML은 Chromium에 띄워 확인했다(진짜 VS Code에서 확인한 것은 아님).

| #       | 결함                                                                        | 위치                                      | 재현 결과                                                                                                 |
| ------- | --------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R1      | 같은 origin의 다른 스펙을 열어도 화면이 다시 그려지지 않음                  | `src/swaggerUi.ts` `base !== currentBase` | 탭 제목은 B, 내용은 A                                                                                     |
| R2      | multipart 업로드 body가 문자열로 바뀜                                       | `src/swaggerUi.ts` `String(init.body)`    | 서버가 `[object FormData]`를 받고 Content-Type 없음                                                       |
| R3      | 바이너리 응답이 깨짐                                                        | `src/http.ts` utf8 디코딩                 | PNG `89` → `efbfbd`                                                                                       |
| R4      | Bearer 토큰이 전역이라 모든 호스트로 전송되고, 호스트별 Basic 인증을 가림   | `src/extension.ts` `buildHeaders`         | A용 토큰이 B로 전송됨 (보안)                                                                              |
| R5      | 웹뷰 배경 `#fff` 고정 — 다크 테마 미대응                                    | `src/swaggerUi.ts`                        | 코드상 확인                                                                                               |
| R6      | 트리에서 operation으로 이동해도 펼쳐지지 않음                               | `src/swaggerUi.ts` `doFocus`              | DOM id의 공백이 `_`로 바뀌어 찾지 못함. Swagger UI 5.32.6은 `.opblock-summary-control` 버튼을 눌러야 열림 |
| E1      | YAML 스펙 미지원                                                            | `src/specLoader.ts` `tryParse`            | spec not found                                                                                            |
| E2      | BOM 붙은 JSON 실패                                                          | `src/specLoader.ts` `tryParse`            | spec not found                                                                                            |
| E3      | springdoc 그룹(`swagger-config`의 `urls`) 미탐지                            | `src/specLoader.ts`                       | spec not found                                                                                            |
| E4      | path 단위 `parameters` 무시                                                 | `src/model.ts` `endpointDetail`           | 파라미터 0개                                                                                              |
| E5      | `{user-id}` 미치환, 함수명 `123GetUser`, `servers` 상대 경로 누락           | `src/model.ts`                            | 생성 코드가 문법 오류                                                                                     |
| E6      | 비식별자 키, 3.1 type 배열, `nullable`, `additionalProperties`, 외부 `$ref` | `src/model.ts` `tsType`                   | `display-name?:`, `any`                                                                                   |
| E7·E8   | 최상위 enum·allOf 모델이 빈 interface                                       | `src/model.ts` `genTsForModel`            | `interface Status {}`                                                                                     |
| E9      | header 파라미터 누락, 선택 query가 `"undefined"` 문자열                     | `src/model.ts` `clientParts`              |                                                                                                           |
| E12~E14 | Swagger 2의 `in: body`, `responses.schema` 미인식                           | `src/model.ts`                            | body 없음, 응답 `void`                                                                                    |

## 판별 계획

### 1.1.1 — 버그 수정

**상태:** 2026-11-10 배포 — GitHub 릴리스 `v1.1.1`, Open VSX.

- R4 토큰을 호스트 범위로 제한 — 처리 방식은 업계 조사로 정함 (아래 "결정 기록")
- R1 패널 갱신 기준을 origin에서 스펙 URL로
- R2 FormData와 R3 바이너리를 base64로 전달
- R6 Swagger UI의 id 규칙과 열기 버튼에 맞춤
- E2 BOM 제거

완료 기준: 위 재현 시험이 모두 통과.

### 1.2.0 — 스펙 읽기

**상태:** 2026-11-10 `develop`에 구현, 아직 배포 전. 번들 46KB → 169KB, VSIX 557KB → 594KB(`yaml` 파서 때문).

1.2.0에 함께 들어감: API를 탐색기 폴더처럼 관리 — ＋ / 우클릭 **API 추가…**, **이름 변경**(`F2`), **주소 수정…**, **주소 복사**, **API 제거**(`Delete`/`⌘⌫`). 실제 VS Code에서 확인(`test/e2e/vscode-ui.ts`).

- E1 YAML 파싱 — springdoc `/v3/api-docs.yaml`, NestJS `-yaml` 경로 포함
- E4 path 단위 파라미터 병합 — name과 in이 같으면 operation 쪽으로 덮어씀 (Swagger 2.0 `#pathItemParameters`)
- E12~E14 Swagger 2의 body·formData·`responses.schema`·consumes·produces
- servers 상대 URL과 변수 (OAS 3.1 `#relative-references-in-urls`, `#server-variable-object`)
- E3 springdoc `configUrl`(기본 `/v3/api-docs/swagger-config`)의 `urls[]` 그룹 → 그룹별 노드
- paths 없는 3.1 문서와 webhooks 허용, `$ref`의 summary·description 덮어쓰기

완료 기준: E1~E4, E12~E14 시험 통과.

### 다음 — 로컬 스펙 파일 ("보류"에서 앞당김)

- `file://` 스펙을 읽고, 파일이 바뀌면 다시 불러온다.
- 탐색기에서 스펙 파일 우클릭 → **OpenAPI Explorer에 추가** (`explorer/context`, `resourceFilename =~ /(openapi|swagger|api-docs)/`로 거름 — https://code.visualstudio.com/api/references/when-clause-contexts).

### 1.3.0 — 코드 생성

기준 도구는 openapi-typescript 7.13.0의 실제 출력이다.

- 비식별자 키는 따옴표로 감싼다 (`"display-name"?:`)
- 3.0 `nullable`과 3.1 type 배열은 `| null`
- `any` 대신 `unknown`, `additionalProperties`는 `Record<string, T>`
- 최상위 enum·allOf·array 모델은 `type` 별칭
- 경로 변수 치환, 올바른 식별자 이름, header 인자, 선택 query에서 `undefined` 제외

완료 기준: E5~E11 시험 통과, 생성된 코드가 `tsc --noEmit` 통과.

### 1.4.0 — UX

- R5 다크 테마 — `vscode-dark` 클래스 기준 (https://code.visualstudio.com/api/extension-guides/webview)
- `withProgress({ viewId })`로 로딩 표시
- 불러오기 실패 노드에 다시 시도

### 보류

외부 `$ref`, 로컬 파일, apiKey·OAuth2·mutualTLS 인증 UI.

## 시험 체계

- 단위 시험: `node --test` (기존 방식 유지)
- 통합 시험: 가짜 `vscode` 모듈 + 로컬 HTTP 서버로 `extension.ts`를 실행
- 웹뷰 시험: Playwright Chromium으로 렌더된 웹뷰 HTML을 확인
- 위 시험은 모두 저장소에 넣고 GitHub Actions(`.github/workflows/ci.yml`)에서 돈다.

## 결정 기록

| 날짜       | 결정                                                                                                              | 근거                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-10 | TS 생성 기준은 openapi-typescript                                                                                 | 실제 실행 출력. 문서: https://openapi-ts.dev/advanced                                                                                                                                                                                                    |
| 2026-11-10 | 시험 하네스를 저장소에 넣고 CI에서 돈다                                                                           | 사용자 결정                                                                                                                                                                                                                                              |
| 2026-11-10 | 로드맵은 영문 `ROADMAP.md`와 한글 `ROADMAP.ko.md`로 나눈다                                                        | 사용자 결정. README와 같은 방식                                                                                                                                                                                                                          |
| 2026-11-10 | R4 토큰은 호스트별 저장. 기존 전역 토큰은 호스트 1개면 그 호스트로 옮기고, 2개 이상이면 보내지 않고 사용자가 고름 | npm·git·gh·curl 모두 호스트 단위 (https://docs.npmjs.com/cli/v10/configuring-npm/npmrc, https://git-scm.com/docs/gitcredentials)                                                                                                                         |
| 2026-11-10 | YAML 파서 `yaml` 2.9.1 추가 (1.2.0)                                                                               | 재현된 결함 E1, springdoc·NestJS의 YAML 경로, 의존성 0개·ISC                                                                                                                                                                                             |
| 2026-11-10 | CI 러너를 `ubuntu-24.04`로 고정                                                                                   | `ubuntu-latest`가 26.04로 바뀌어 Playwright 1.60이 Chromium을 설치하지 못함 (v1.1.1 CI 실패)                                                                                                                                                             |
| 2026-11-10 | Open VSX 배포는 GitHub Actions(`publish-ovsx.yml`)에서 GitHub 릴리스에 첨부된 VSIX를 올린다                       | 토큰은 Actions 시크릿 `OVSX_PAT`. 릴리스와 같은 파일이 올라감                                                                                                                                                                                            |
| 2026-11-10 | springdoc 그룹은 트리 노드로 보이고, swagger-config를 일반 후보 경로보다 먼저 확인                                | 기본 `/v3/api-docs`도 있으면 그룹을 놓치기 때문 (https://springdoc.org/properties.html)                                                                                                                                                                  |
| 2026-11-11 | API를 탐색기 루트 폴더처럼 관리: 제목줄 ＋, 노드 우클릭 추가·이름 변경·주소 수정·주소 복사·제거, F2/Delete        | 탐색기는 루트 폴더 우클릭으로 폴더를 추가·제거한다 (https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces). 확장은 트리 빈 공간에 메뉴를 붙일 수 없다: `view/title`, `view/item/context`만 있음 (VS Code `menusExtensionPoint.ts`) |
| 2026-11-11 | `swaggerViewer.url`은 옮기지 않고 그대로 `specs`와 함께 표시                                                      | 옮기면 각 프로젝트의 `.vscode/settings.json`(팀과 공유될 수 있음)을 확장이 고치게 됨                                                                                                                                                                     |
| 2026-11-11 | "메서드를 열면 최하단으로 감"은 재현 불가로 종료                                                                  | 실제 VS Code에서 Petstore 3·샘플 게이트웨이로 재현 안 됨 (`test/e2e/vscode-scroll.ts`), 사용자 확인                                                                                                                                                      |

## 출처

- Swagger 2.0: https://swagger.io/specification/v2/
- OAS 3.1.0: https://spec.openapis.org/oas/v3.1.0.html
- 3.0 → 3.1 이전 안내: https://www.openapis.org/blog/2021/02/16/migrating-from-openapi-3-0-to-3-1-0
- springdoc: https://springdoc.org/properties.html, https://springdoc.org/
- NestJS: https://docs.nestjs.com/openapi/introduction
- FastAPI: https://fastapi.tiangolo.com/tutorial/metadata/
- openapi-typescript: https://openapi-ts.dev/advanced
