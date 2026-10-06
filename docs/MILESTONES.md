# ViewTrace AI 구현 Milestones

작성 기준일: 2026-10-06. 이 문서는 Agent Pigeon을 ViewTrace AI v0.1로 전환하는 구현 계약과 완료 판정 기준이다. 문서 작성 자체는 어느 Milestone의 완료도 의미하지 않는다. 초기 상태는 M0–M5 모두 **NOT STARTED / 미검증**이다.

제품 원본: [ViewTrace AI 확정 기획](https://app.notion.com/p/3f127edac20581fe8a92f5d50a74dca5). 해당 페이지의 본문 §1–11을 확인했다. 페이지에 첨부된 SVG의 세부 시각 디자인은 구현 계약에 포함하지 않는다. 아래의 구체적인 API, 디렉터리 제안, 상태 규칙, 테스트 수치와 배포 게이트는 기획을 실행 가능하게 만든 **이 문서의 구현 기준**이며, 이미 존재하는 기능이나 Notion의 원문 요구사항으로 오해하지 않는다.

## 1. 제품 계약과 구현 순서

**ViewTrace AI — Trace the evidence behind AI answers.**

v0.1은 Research / Comparison / Recommendation에 집중한다. AI가 검색하고 읽고 비교하고 검증한 관찰 가능한 근거를 사용자에게 연결한다. 숨겨진 chain-of-thought를 추출하거나 재구성하지 않는다.

최종 흐름은 `AI Client → Adapter → Local Collector → SQLite → Trace Analyzer → CLI / Web`이다. 외부 Agent 없이 실행 가능한 명시적 ViewTrace JSONL reference adapter로 M0–M4를 검증하고, 실제 Agent의 리서치 이벤트 연결은 M5에서 검증한다.

| 단계 | 핵심 결과 | 선행 조건 | TEAMHARNESS |
| --- | --- | --- | --- |
| M0 — ViewTrace Foundation | 제품 경계, 버전 있는 이벤트·provenance·저장 계약, reference adapter | 현재 저장소와 회귀 기준 확보 | 사용 안 함 |
| M1 — Live CLI Trace | live 수집, 영속화, CLI lifecycle, 터미널 활동 표시 | M0 완료 | 사용 안 함 |
| M2 — Local Report Server | localhost 전용 조회 API와 최소 보고서 페이지 | M1 완료 | 사용 안 함 |
| M3 — Evidence Engine | Claim ↔ Evidence ↔ Decision, 충돌·검증·근거 상태 분석 | M2 완료 | 사용: 깊고 넓은 분석 계약 |
| M4 — Full Web Report | Answer / Why / Evidence / Story / Graph / Inspector / Raw | M3 완료 | 사용: 넓은 UX·보안·분석 통합 |
| M5 — Real Agent Adapters | 실제 형식·실행 검증, capability matrix, 배포 후보 | M4 완료 | 사용: 복수 Agent·OS·수집 경로 통합 |

모든 단계에서 제외: 코드 변경/Git diff 추적 기능 확대, 테스트·빌드·Docker 실행 분석 기능 확대, IDE 전체 observability, Agent 행동 개입/governor, private reasoning 수집, 클라우드 업로드·계정·로그인·원격 서버·자동 telemetry. 저장소 자체의 빌드·테스트는 당연히 수행한다. 로컬 보고서 서버는 제품 범위다.

## 2. 현재 저장소와 리팩토링 경계

현재는 TypeScript ESM, NodeNext, strict / noUncheckedIndexedAccess 기반 단일 npm 패키지 `agent-pigeon@0.3.0`이다. 선언된 Node 최소 버전은 `>=20.11`; `npm run typecheck`, `npm run build`, `npm test`가 있고, `npm test`는 빌드 후 Node test runner를 실행한다. 런타임 의존성은 현재 선언되어 있지 않다. SQLite 구현 선택은 새로 필요하다.

| 현재 경로 | 현재 역할 | 전환 시 기준 |
| --- | --- | --- |
| `src/cli.ts`, `src/session.ts`, `src/flight.ts`, `src/compare.ts`, `src/share.ts` | 기존 CLI, 코딩 세션 보고·비교·SVG | 기존 CLI 회귀 보존; 새 `viewtrace` 진입점과 리서치 출력 분리 |
| `src/pigeon/{types,validate,process,attention,select}.ts` | 코딩 이벤트 계약, 타임라인·실패 회복·radar | 검증·결정론 패턴만 재사용; Research 의미를 기존 이벤트에 억지로 삽입하지 않음 |
| `src/adapters/{index,generic-jsonl,codex,claude,zcode}.ts` | 형식 탐지, history 발견, Pigeon 정규화 | reference adapter와 Research capability를 새 계약으로 분리 |
| `src/replay/` | corpus/replay, segment, fingerprint/secret | replay 개념과 입출력 격리 패턴 재사용; 코딩 heuristic·secret 생성의 자동 편입 금지 |
| `src/ui/server.ts`, `ui/{index.html,app.js,app.css,format.js}` | `127.0.0.1:7676` 코딩 UI, session 파일 경로 API | 새 서버 기본 포트 7331; 조회는 run ID 기반; 기존 서버 안전성 재검증 없이 복사 금지 |
| `src/core/`, `src/report.ts` | runtime/progress 평가와 기존 보고 | 기존 회귀 영역; Evidence Engine의 근거 충분성 평가로 재명명만 하지 않음 |
| `src/jev/`, `src/agent-device/`, `src/poc*.ts` | provider 실험, 기기 수집, 연구 실행 | 새 기본 CLI의 import graph와 npm 배포 경로에서 격리 |
| `experimental/` | hooks·live governor 연구 | 보존하되 v0.1 기능과 출시 증거에서 제외 |
| `test/`, `fixtures/` | core/CLI/adapters/UI/성능·연구 회귀 | 기존 전체 회귀 유지; 별도 ViewTrace fixture·negative test 추가 |
| `scripts/` | corpus audit, demo, Linux fixture/pack 검증 | 연구 scripts는 출시 증거가 아님; 기존 Linux 검증 script는 강화 필요 |
| `docs/research/`, `docs/{flight,compare}.md`, `docs/ui/`, `docs/branding/`, `docs/share/`, `docs/dev-launch/` | 연구 이력과 기존 제품 문서·미디어 | 역사적 결과를 ViewTrace 검증 결과로 인용 금지; 새 README·보안 정책은 실제 동작과 일치 |
| `package.json`, `package-lock.json`, `tsconfig.json`, `LICENSE`, `README.md`, `CHANGELOG.md`, `SECURITY.md` | 패키징·지원 환경·문서 | bin/files/engines/의존성/개인정보 설명을 단계별 갱신; MIT 유지 |
| `.team-harness/` | 이미 초기화된 coordinator/worker 설정 | 재초기화하지 않음; M3–M5의 구현 때만 사용 |

작성 당시 `.team-harness/`는 untracked이며 사용자 소유 상태로 보존한다. `AGENTS.md`는 저장소 검색에서 발견되지 않았고, tracked `.github` CI 정의도 확인되지 않았다. 이후 작업 시작 시 다시 확인한다.

### 지금 확인된 진단 대상

- 기존 generic JSONL은 손상된 줄을 warning으로 건너뛴다. 새 계약에서는 손실 개수·위치·보고서 완전성까지 전달해야 한다. 마지막 미완성 줄과 확정 malformed 줄을 구별한다.
- 기존 validator의 날짜 검증은 `Date.parse` 중심이다. 새 schema의 시간·필수 필드·참조·버전·provenance 검증을 대체하지 못한다.
- 기존 UI에는 `?path=`로 로컬 JSONL을 지정하는 API가 있다. 새 HTTP API는 임의 파일 경로를 받지 않고 store에 등록된 run ID만 조회한다.
- 기존 asset 경계는 문자열 `startsWith(root)` 검사다. sibling prefix, symlink, separator, encoding까지 포함하는 경계 검증이 필요하다. 아래의 공격 테스트 전에는 취약 여부를 확정하지 않는다.
- 기존 서버의 loopback bind는 있으나 그것만으로 Host/Origin, DNS rebinding, CSRF, HTML injection 방어가 입증되지 않는다.
- 기존 README/SECURITY의 “저장 없음/read-only”는 새 SQLite·trace 저장 제품에 맞지 않는다. 원본 history는 read-only, ViewTrace 자체 저장은 local write라는 설명으로 전환해야 한다.
- 기존 Linux shell 검증은 고정된 옛 tarball 이름, pipeline exit 은폐, 공백 경로 checksum 처리 등 때문에 출시 게이트로 충분하지 않다. README의 과거 Windows 검증 언급도 새 구현의 Windows 통과 증거가 아니다.
- 기존 성능 테스트에는 단일 측정 비율 비교가 있다. 새 성능 검증은 반복 샘플·warmup·기준 환경으로 판단한다. 기존 테스트를 flaky하다는 이유만으로 skip하거나 임계값을 무작정 완화하지 않는다.

새 모듈의 기본 위치는 `src/viewtrace/{types,validate,adapters,collector,store,analyzer,report,cli,server}`와 `fixtures/viewtrace/`, `test/viewtrace-*.test.ts`, `ui/viewtrace/`를 권장한다. 단일 파일/디렉터리 선택은 구현자가 조정할 수 있지만 계층별 책임과 기존 경계는 유지한다. 새 public bin은 `viewtrace`; M0–M5 동안 기존 `agent-pigeon` bin과 회귀는 유지한다. 삭제·breaking migration은 이 로드맵 밖의 별도 결정이다.

## 3. 공통 데이터·정직성·보안 계약

### 3.1 이벤트와 provenance

- domain vocabulary는 `SEARCH`, `READ`, `CLAIM`, `COMPARE`, `HYPOTHESIS`, `CONTRADICTION`, `VERIFY`, `RECOMMEND`다. CLI의 `CONFLICT`는 `CONTRADICTION`의 표시 이름이다. 별도로 run lifecycle과 operation 결과를 모델링한다.
- 공통 필수 필드: `schemaVersion`, `eventId`, `runId`, `type`, `occurredAt`(명시적 timezone의 ISO 8601), collector의 `receivedAt`와 `sequence`, `adapterId`, `adapterVersion`, `origin`, source reference. `sequence`는 run 내 collector 수신 순서를 나타내며 누락된 시각을 가짜로 채우지 않는다.
- provenance의 세 범주: **Agent reported**(명시적 사용자 대상 판단/rationale), **ViewTrace observed**(로그/도구 결과에서 관찰된 행위), **ViewTrace inferred**(관찰을 근거로 한 요약·추론). Notion §4의 inferred와 §11의 observed는 서로 다른 층으로 모두 유지한다.
- observed record에는 원본 위치(파일/record ID/line 또는 byte offset), tool call/result ID와 가능한 content hash를 연결한다. 원문 파일의 존재·hash는 내용의 진실성을 보증하지 않는다. reference JSONL 작성자가 `observed`라고 주장하는 것만으로 collector가 verified observed로 승격하지 않는다.
- reported rationale은 “Agent가 이렇게 말했다”의 증거이지 CLAIM의 사실 확인이 아니다. inferred에는 입력 event/evidence IDs, rule/analyzer version을 붙인다. 원본이 없거나 참조가 끊기면 `unverified/missing`으로 표시한다.
- private reasoning/analysis/thinking/encrypted reasoning payload는 기본 수집·저장·출력에서 제외한다. 단순 키워드 추측만으로 자유 텍스트를 안전하다고 판단하지 않는다. adapter는 허용된 메시지 역할과 tool payload만 추출한다. `HYPOTHESIS`는 명시적 공개 판단이나 라벨 있는 추론만 담는다.
- 타입별 payload 계약을 정의한다. SEARCH=query와 관찰된 결과; READ=source와 실제 읽기 결과; CLAIM=text와 source/anchor; COMPARE=후보·기준·각 셀의 evidence 또는 UNKNOWN; CONTRADICTION=상충 claim/evidence와 동일 조건; VERIFY=대상·방법·결과·근거; RECOMMEND=선택·사용자 조건·rationale 및 관계 IDs. 필드가 없으면 unknown을 보존하며 없는 검색·읽기·비교를 합성하지 않는다.
- 같은 `(runId,eventId)`와 동일 payload의 재수신은 idempotent. 같은 ID와 다른 payload는 conflicting duplicate로 격리·진단하고 덮어쓰지 않는다. 다른 run의 같은 event ID는 충돌하지 않는다. cross-run reference, cycle, dangling link, 미래 버전은 진단한다. 늦게 온 참조는 pending으로 보존하고 종료 후 unresolved를 명시한다.

### 3.2 실행 상태와 근거 상태를 분리

| 축 | 최소 상태와 판정 |
| --- | --- |
| run lifecycle | `CREATED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `UNKNOWN`; COMPLETED는 종료 관찰이며 사실 정확성 보증이 아님 |
| collection completeness | `COMPLETE`, `PARTIAL`, `UNKNOWN`; 입력 손상·누락·collector 실패는 숨기지 않음 |
| operation | `SUCCESS`, `FAILED`, `PARTIAL`, `TIMEOUT`, `CANCELLED`, `UNKNOWN`; 시작 이벤트만 있으면 성공 아님 |
| evidence support | `STRONGLY_SUPPORTED`, `PARTIALLY_SUPPORTED`, `INSUFFICIENT_EVIDENCE`, `CONFLICTING_EVIDENCE`, `UNKNOWN` |

프로세스 exit 0, RECOMMEND 존재, 파일 mtime 최신, 마지막 자연어 “완료”는 각각으로 run 성공·근거 충분성의 증거가 되지 않는다. reference protocol의 명시적 종료·outcome과 collector completeness를 함께 판정한다. 서로 다른 축은 CLI/API/Web 모두 유지한다. 정상 종료했지만 근거 없는 추천은 `COMPLETED + INSUFFICIENT_EVIDENCE`가 가능하다. 모순을 발견하고 조사만 끝낸 경우에도 해결됐다고 표시하지 않는다.

### 3.3 local-only와 저장 경계

- 기본 데이터 루트는 `~/.viewtrace/`: `viewtrace.db`, `runs/<runId>/trace.jsonl`, `evidence/`, `artifacts/`, `config.toml`. 테스트는 명시적 임시 data root로 격리한다. 다른 HOME을 오염시키지 않는다.
- SQLite는 정규화된 조회와 commit 판단의 authoritative store다. JSONL은 최소화·redaction된 수집 record의 replay/export 표현이다. 원본 Agent history 전체 복사가 아니다. SQLite/JSONL 이중 쓰기의 crash recovery, committed cursor, 중복 방지 규칙을 M0에서 확정한다.
- run ID와 artifact ID는 파일 경로가 아니다. 경로 허용 목록, realpath/root containment, symlink/junction 정책, Windows drive/UNC/예약 이름을 검증한다. 원본 history와 임의 repo 파일은 변경하지 않는다.
- DB·trace·WAL·SHM·config·artifact에 최소 권한을 적용한다(POSIX directory 0700/file 0600; Windows는 적용 가능한 사용자 접근 제어와 한계를 문서화). SQL은 parameter binding, migration은 transaction과 버전 검사, 암묵적인 DB 삭제 금지.
- ViewTrace 기본 runtime은 외부 네트워크 요청 0건, cloud/LLM/key 요구 0개다. source URL은 기록된 값으로 표시하며 서버가 자동 fetch하지 않는다. 폰트·script·analytics·image도 자체 제공한다.
- 실제 Agent가 research를 위해 외부 네트워크를 쓰는 것과 ViewTrace가 업로드하는 것은 구분한다. M5에서도 collector/analyzer/server는 외부 송신하지 않는다. 사용자 클릭의 source 외부 이동은 명시적 링크 동작이다.
- 서버는 IPv4 `127.0.0.1`에만 bind한다. `0.0.0.0`, `::`, LAN 주소 옵션은 허용하지 않는다. `localhost` 안내 URL을 사용한다면 IPv4 접근을 실제 확인하고, 실패 시 접근 가능한 `127.0.0.1` URL을 출력한다.
- Host 허용 목록은 실제 bound port의 `127.0.0.1`/`localhost`로 제한한다. 외부 Origin과 교차 출처 쓰기를 거부하고 wildcard CORS 금지. control/ingest에는 per-install 또는 per-process 비밀과 Origin 검증을 적용한다. 비밀은 URL·로그·Raw에 노출하지 않는다. read API도 rebinding/cross-origin에 노출하지 않는다.
- prompt·query·사용자 조건·URL query token·tool output은 민감할 수 있다. 최소 저장, secret redaction, 원문 표시 제한을 구현한다. 허용된 Raw도 private reasoning과 credentials를 포함하지 않는 정제된 trace이며, 원문 부재를 숨기지 않는다. 모든 local 데이터의 수명·삭제 방법을 문서화한다.

## 4. 공통 완료 게이트 — 모든 Milestone에 적용

Milestone별 최소 테스트는 아래 게이트에 **추가**된다. 기능 구현, 검증, 보안 진단, 문서/패키징 검증 중 하나라도 빠지면 완료가 아니다.

1. **typecheck 0 error**: 최종 변경 상태에서 `npm run typecheck`와 `npm run build` 모두 exit 0. broad `any`, `@ts-ignore`, strict 약화로 숨기지 않는다. 새 browser JS도 M4에서 정적 검증 범위에 포함한다. `skipLibCheck`만으로 새 앱 코드의 오류를 숨기지 않는다.
2. **기존 regression 전부 통과**: `npm test` 전체 suite를 실행한다. 기존 CLI·parser·core·governor 연구 회귀까지 유지한다. 제품 방향 변경을 이유로 assertion 삭제/skip하지 않는다. 기존 테스트 자체의 결함 수정은 동등하거나 더 강한 assertion과 변경 이유를 남긴다.
3. **신규 핵심 동작 자동화**: 공개 CLI/bin, 실제 SQLite, 실제 HTTP, browser DOM, 실제 adapter fixture를 사용한 경계별 integration/E2E가 있어야 한다. mock 내부 함수만 통과하거나 스냅샷만 갱신하는 것으로 충분하지 않다.
4. **입력 검증**: malformed JSON/UTF-8·마지막 미완성 줄·필수 필드 누락·null/잘못된 타입·빈 ID·알 수 없는 schema/type·invalid time·음수/비유한 수치·과대 payload·중복 ID·다른 run 참조·missing source·conflicting evidence를 자동 검증한다. 불량 record를 격리하더라도 loss/completeness를 API·보고서에 노출한다.
5. **local-only 경계**: 임시 data root 밖 쓰기 0, 원본 history checksum 불변, runtime 외부 송신 0, telemetry 0. 서버 등장 이후 실제 bind·Host/Origin·CORS·traversal·symlink·SQL/XSS 공격을 검증한다. localhost bind만 확인하고 통과로 판정하지 않는다.
6. **provenance/CoT 정직성**: 조작된 observed 라벨, 없는 source, reported를 사실로 승격한 입력, inferred를 원문으로 위장한 입력, private reasoning marker를 심은 입력을 넣어 저장·CLI·API·Web·Raw 어디에도 잘못된 표기가 없는지 검증한다.
7. **실패 상태 보존**: failure/partial/timeout/cancelled/UNKNOWN, missing completion, incomplete evidence, 해결되지 않은 conflict가 정상 성공이나 강한 근거로 바뀌지 않는다. negative assertion을 각 계층에 둔다.
8. **Windows/Linux 실환경**: 지원 Node 최저 버전과 현재 지원 LTS 한 버전을 M0에서 정확히 고정하고, 두 OS의 CI matrix에서 검증한다. 드라이브/UNC/역슬래시/공백/한글/CRLF/대소문자·권한 차이·`.cmd` 실행·Ctrl+C·프로세스 정리·포트 충돌을 포함한다. `path.win32` unit test는 Windows 실행을 대체하지 않는다. macOS 검증이 없다면 지원 검증을 주장하지 않는다.
9. **skip 금지**: 핵심 unit/integration/E2E/security/OS/pack test의 `skip`, `todo`, `.only`, allow-failure가 있으면 완료 금지. 환경·자격증명 부족은 BLOCKED/NOT VERIFIED로 기록한다. 별도 optional exploratory test는 완료 증거로 세지 않는다. 필수 live test를 optional로 이동해 우회하지 않는다.
10. **우연한 통과 금지**: 최종 동일 변경 상태에서 전체 typecheck/build/regression/new suite를 서로 독립적인 임시 data root로 3회 연속 통과시킨다. OS matrix도 최종 상태 기준으로 통과해야 한다. race/stream/restart/port test는 OS별 20회 반복한다. 테스트 수정 전후의 다른 상태 결과를 합쳐 3회로 세지 않는다. 실패 후 성공할 때까지 재시도한 최종 한 번만 보고하지 않는다.
11. **재현 가능성**: clock/ID/order는 주입·고정 가능하게 하고 polling은 조건 대기와 제한 시간을 사용한다. suite 순서 공유 server/state를 제거한다. timeout·resource limit을 명시하고 leaked process/socket/file handle 0을 확인한다. 실패 로그와 모든 실행 횟수를 보존한다.
12. **실제 배포물**: 매 단계 tarball을 `npm pack`으로 만들고 깨끗한 directory에 설치한다. 지원 OS/Node matrix에서 public bin·해당 단계 기능을 실행한다. workspace 파일/개발 의존성 없이 작동해야 한다. runtime module/UI asset 누락, absolute workspace path, secret·개인 transcript·연구 output 포함은 실패다. publish는 별도 사용자 요청이며 Milestone 완료에 필요하지 않다.
13. **취약점 triage**: 새 runtime/SQLite/browser 의존성의 알려진 취약점과 install scripts를 확인한다. production High/Critical 미해결 0; 낮은 severity도 영향·완화·잔여 위험을 기록한다. security gate와 독립된 development-only advisory는 근거 있는 별도 triage가 필요하다.

### 공통 fixture와 성능 기준

최소 fixture 세트: 정상 Research, A/B/C Comparison, 조건별 Recommendation, 무근거 추천, 모든 evidence 누락, 충돌 미해결, 명시적 검증으로 해결, 오래된 자료/날짜 불명, 동일 source 복제, reported-only rationale, forged provenance, private reasoning, malformed/truncated stream, 실패/취소/부분 성공/종료 불명, cross-run/dangling/cyclic relation. 각 fixture에는 기대 event 수·상태·관계·경고와 **나오면 안 되는 결론**을 고정한다. M0에서 저장 형식을 마련하고 관련 단계까지 oracle을 완성한다.

새 deterministic normalization/analyzer는 1k와 10k 이벤트를 warmup 후 각 10회 측정한다. 동일 runner에서 10k p95 ≤ 6초, median 증가 ≤ 25배(1k 대비), 정확한 수·관계 보존을 요구한다. 작은 시간은 최소 1ms로 계산한다. M1 live 수집은 1k 이벤트/10초 synthetic stream에서 accepted→CLI 표시 p95 ≤ 1초, loss·duplicate 0; M2 10k-run 상세 API는 warmup 후 20회 p95 ≤ 2초; M4 10k-event 기본 보고서 첫 유용한 렌더링 ≤ 3초, 초기 DOM에 모든 raw event를 펼치지 않는다. runner/Node/OS/메모리와 측정 경계를 기록한다. 이미 검증한 기준 환경을 느슨하게 바꿔 통과시키지 않는다. 느린 CI라면 동일 조건의 전용 runner에서 필수 검증을 수행한다.

### 완료 기록과 짧은 목표의 실행 규칙

“현재 M1 진행, MILESTONES.md 기준으로 완료까지 구현”을 받으면 다음 순서로 작업한다.

1. `git status`, 해당 지침 파일, 이 문서, 직전 단계 완료 증거와 현재 CI를 읽는다. 사용자 변경을 보존한다.
2. 선행 게이트가 미완료이면 필요한 선행 작업부터 복구하고 상태를 알린다. 진행 번호를 완료 증거로 간주하지 않는다.
3. 아래 범위·계약·fixture를 구현하고 단계별 필수 테스트와 공통 게이트를 수행한다. 문서에 이미 결정된 routine 선택은 다시 허락을 묻지 않는다.
4. 권한 부족·네트워크·실제 Agent/OS 환경 부재는 실제 blocker로 남긴다. synthetic 성공으로 실검증을 대체하지 않는다.
5. 구현 때 `docs/milestones/M<n>-verification.md`에 검증 증거를 작성한다: 상태(`NOT STARTED / IN PROGRESS / BLOCKED / COMPLETE`), 변경 commit 또는 working-tree diff hash, 계약 변경, fixture/test ID↔요구사항 매핑, 명령·OS·Node·exit·pass/fail/skip 수, 반복 3회와 race 20회 결과, tarball 설치 결과, 취약점 triage·미해결 위험·다음 gate. 민감한 trace는 첨부하지 않는다.
6. 실패·누락·skip가 있으면 COMPLETE로 쓰지 않는다. 다음 단계 기능을 일부 구현했더라도 이전 단계를 완료했다고 소급하지 않는다. 최종 응답에는 결과와 미검증 항목을 정확히 보고한다.

이번 문서 작성에서는 위의 추가 검증 파일을 만들거나 코드를 변경하지 않는다.

## 5. M0 — ViewTrace Foundation

### 목표

코딩 세션 제품과 리서치 근거 제품의 경계를 분리하고, M1 이후가 공통으로 사용하는 event/provenance/session/SQLite/reference adapter 계약을 만든다.

### 구현 범위 / 제외 범위

- 새 `viewtrace` bin의 `--help`/`--version`, 제품명·scope·개인정보 설명, 기존 bin 호환 정책을 구현한다. 아직 없는 명령은 미구현이라고 명시한다.
- §3 계약의 schema version 1, discriminated event payload, validator, run 상태 전이, provenance/source reference, adapter interface와 capability schema를 작성한다.
- reference JSONL parser와 chunk reader를 구현한다. partial UTF-8 byte, CRLF, EOF의 마지막 완성 JSON record, 미완성 record, line limit 정책을 명시한다. warning에 원문 secret을 넣지 않는다.
- SQLite store 최소 기능: run 생성/조회, validated event append/read, unique key, transaction, schema migration, reopen, deterministic replay. DB와 JSONL commit/recovery 계약 및 파일 권한·data root를 구현한다.
- SQLite driver의 Node/OS 지원·native install·license를 검토하고 고정한다. `node:sqlite`를 사용할 경우 현재 Node 20.11에서 가능하다고 가정하지 말고 engines/CI/문서를 실제 필요한 최소 버전으로 함께 갱신한다. 이 결정은 M0 완료 전에 확정한다.
- 새 fixture/oracle 기반, Windows/Linux CI, tarball smoke를 마련한다. 기존 source/test를 제거하지 않는다.
- 제외: live watcher·Agent spawn, background service, HTTP 보고서, Evidence Engine, 완성 Web, 실제 Agent research adapter.

### 예상 위험 요소와 취약점 진단 항목

- Pigeon의 TEST_PASSED/FILE_CHANGED를 Research CLAIM/VERIFY로 재해석하는 semantic 혼합.
- reported rationale을 observed로 승격, arbitrary metadata 속 private reasoning·credential 유입, 날짜/숫자/버전 검증 누락.
- DB/JSONL commit 사이 crash, duplicate overwrite, cross-run 관계, migration 중 data loss, native driver 설치 실패와 쓰기 권한 차이.
- 현재 package.files가 새 store/CLI 모듈을 누락하거나 experimental/provider 코드가 기본 경로에 포함되는 문제.

### 완료 조건

8개 domain event와 lifecycle/status/provenance의 타입별 계약·예제가 있고, reference fixture를 validate→store→close→reopen→replay하면 event·관계·경고·상태가 동일하다. 기존 CLI 동작과 테스트는 유지되고, 깨끗한 npm 설치에서 새 bin이 실행된다. SQLite/Node 지원 결정과 local 저장 정책이 문서·패키지·CI에 일치한다. 공통 게이트 전체 충족.

### 최소 테스트 기준

- 모든 event type의 정상/필수 필드 누락/오타 타입/알 수 없는 버전, timezone 없는 시간, 빈 ID, 과대 record, NaN/Infinity(programmatic input) 검증.
- byte 단위 chunk와 멀티바이트 한글 분할, CRLF, EOF newline 유무, truncated tail, malformed 중간 줄의 loss count/위치 보존.
- same-ID same/different payload, cross-run, missing/cycle 관계, source reference 위조, reported/inferred 레이블 보존과 private payload 배제.
- 실제 SQLite transaction rollback, reopen, migration 실패 rollback, 미래 DB 버전 거부, DB lock/쓰기 거부/용량 부족의 fault injection, commit 경계별 crash recovery. 단순 in-memory mock은 부족하다.
- 임시 data root 밖 쓰기 0, 원본 fixture 불변, 네트워크 sentinel 0; 양 OS tarball `viewtrace --help/--version` 및 store smoke.

### 실패로 간주할 조건

schema 없이 느슨한 `Record<string, unknown>`로 핵심 payload를 통과시키거나, source/provenance를 신뢰 입력으로 그대로 받아 factual로 표시하거나, 이중 쓰기 복구·OS 설치·회귀 중 하나라도 미검증인 상태. migration이 조용히 DB를 초기화하는 경우는 즉시 실패다.

### 다음 Milestone 진입 조건

M0 COMPLETE 기록과 schema/store/reference fixture oracle이 확정되어 있다. M1이 DB·이벤트 의미를 임의로 다시 설계할 필요가 없어야 한다.

### TEAMHARNESS 사용 여부

**사용 안 함.** 계약과 작은 foundation을 단일 작업 흐름으로 확정한다. 외부 orchestration 실행은 이번 문서 작성에도 필요 없다.

## 6. M1 — Live CLI Trace

### 목표

reference stream을 안전하게 실시간 수집·영속화하고, 사용자가 CLI에서 현재 리서치 활동과 실제 종료 상태를 볼 수 있게 한다.

### 구현 범위 / 제외 범위

- collector의 incremental append ingestion, run 격리, validation diagnostics, idempotency, cursor/restart recovery, backpressure와 크기 제한을 구현한다. file truncate/rotation 시 새 source generation을 구분한다.
- CLI `up`, `status`, `runs`, `down`, `run -- <agent>`와 reference adapter 입력 경로(예: `run --adapter generic-jsonl -- <producer>`)를 구현하고 help에 정확한 옵션을 기록한다.
- M1 `up`은 collector service를 시작하고 readiness를 확인한다. background process·control IPC는 두 OS에서 검증된 방식으로 구현한다. loopback control을 사용하면 M2 전이라도 §3의 Host/Origin/token 경계를 즉시 적용한다. `status`는 실제 readiness와 stale PID를 구별한다.
- `run --`은 지원된 명시적 adapter만 감싼다. 일반 stdout을 임의로 SEARCH/READ로 해석하지 않는다. unsupported adapter는 실행 전에 진단한다. stdout 이벤트 framing과 Agent 일반 출력의 분리 규칙을 고정한다.
- 터미널에는 SEARCH/READ/COMPARE/CONFLICT/VERIFY/RECOMMEND 활동, reported/inferred 라벨, 경고와 상태를 표시한다. pipe/non-TTY에는 ANSI 없이 안정적인 텍스트/JSON을 제공한다. CLI escape/control characters를 정제한다.
- `down`은 collector가 소유한 프로세스만 정리하고 committed 이벤트를 보존한다. wrapper Ctrl+C와 child process tree 정리 정책을 명시한다.
- M1의 `open latest`는 run 존재를 확인하되 M2 서버 미구현을 정확히 안내한다. 종료 시 run ID·로컬 저장 위치를 출력한다. M2부터만 실제 ready report URL과 browser open을 제공한다.
- exit code 계약: 사용법/시작 실패는 nonzero; child 종료 코드는 가능한 범위에서 보존하고 signal 종료 mapping을 문서화한다. child exit 0이라도 collector 실패/손상 입력은 명시적 nonzero 또는 partial 결과로 보고하며 정상 성공으로 출력하지 않는다.
- 제외: 실제 Agent별 research 매핑, Evidence Engine, 웹 보고서·그래프. reference producer 실행 성공을 실제 Agent 지원으로 광고하지 않는다.

### 예상 위험 요소와 취약점 진단 항목

shell interpolation·악성 argument, Windows `.cmd` quoting, orphan child, stale PID/PID reuse로 다른 프로세스 종료, 동시 `up` 중복 service, stdout/stderr deadlock.

byte cursor/UTF-8 경계, rotation 재수집 중복·손실, 무한 partial line·queue 메모리 증가, disk failure가 정상 Agent 완료로 묻히는 문제. live file mtime를 사실상 실행 성공으로 사용하는 문제.

### 완료 조건

`up → run(reference producer) → status/runs → down → up`에서 run과 evidence가 정확히 보존되고, 활동이 실시간 표시되며, 정상/실패/취소/부분/불명 상태가 모두 구분된다. HTTP 보고서 없이도 독립적으로 동작한다. 공통 게이트 전체 충족.

### 최소 테스트 기준

- 공개 bin을 실제 subprocess로 실행하여 8개 domain event와 stderr/일반 stdout 혼합, unknown adapter, child exit 0/1, spawn 실패, signal/Ctrl+C를 검증한다.
- empty stream, 시작만 있는 stream, RECOMMEND 후 실패, 명시적 종료 누락, malformed 일부/전부, collector disk failure가 정상 성공으로 출력되지 않는다.
- incremental chunk/UTF-8/CRLF, truncate/rotate, duplicate/out-of-order/late reference, restart/cursor, 두 run 동시 수집, slow consumer backpressure와 line cap 검증.
- 동시 `up`, 이미 종료된 PID, PID identity 불일치, 포트/IPC 충돌, 반복 up/down, graceful flush와 abrupt crash; race 20회/OS, leaked process 0.
- 한글·공백·`&`, 따옴표를 포함한 argv, Windows executable/`.cmd`, POSIX executable 권한, 원본 history read-only, CLI terminal injection·secret/CoT sentinel 검증.
- §4 live latency/loss 기준과 tarball 설치 후 reference producer E2E.

### 실패로 간주할 조건

buffer·queue가 무제한이거나 accepted record 손실/중복이 발생하는 경우, wrapper가 Agent 실패를 0으로 숨기는 경우, `down`이 타 프로세스를 종료하는 경우, 미구현 report URL을 정상 링크로 출력하는 경우, restart/Windows 검증이 빠진 경우.

### 다음 Milestone 진입 조건

M1 COMPLETE, lifecycle/control·run ID·store query·stream cursor가 안정적이며 M2가 collector와 별도 ephemeral DB를 만들지 않고 동일 store를 조회할 수 있다.

### TEAMHARNESS 사용 여부

**사용 안 함.** collector와 CLI lifecycle의 의존성을 순차로 검증한다.

## 7. M2 — Local Report Server

### 목표

persisted run을 localhost에서 안전하게 조회하고, CLI가 실제 접근 가능한 최소 보고서 링크를 제공하게 한다.

### 구현 범위 / 제외 범위

- `up` lifecycle에 `127.0.0.1:7331` 보고서 서버 readiness를 통합한다. 포트 충돌은 명시적 실패이며 다른 서비스에 성공 링크를 연결하지 않는다. 설정 포트와 테스트용 ephemeral port는 loopback만 허용한다.
- 최소 public 계약: `GET /api/runs`(안정적 pagination), `GET /api/runs/:runId`, `GET /api/runs/:runId/events`(cursor/limit), `GET /api/adapters`, `GET /health`, `GET /runs/:runId`. collection diagnostics·completeness·provenance를 포함한다. 임의 `path=`/SQL/file URI를 받지 않는다.
- run 상세는 recorded question/final answer(있을 때), 관찰된 활동, 상태·경고·source reference를 보여주는 최소 HTML이다. 미분석 근거 상태는 UNKNOWN/분석 전으로 표시한다.
- `open latest`는 store 기준 최신 run을 안정적으로 선택하고 readiness 확인 후 실제 URL을 연다. OS별 browser launcher는 argv 기반으로 실행하며 launcher 실패 시 URL을 남긴다. run 없음/서버 중단/다른 port는 명시적으로 안내한다. headless URL-only 동작을 지원한다.
- 업데이트는 cursor polling 또는 SSE 중 하나를 선택하고 protocol/version·disconnect/reconnect·deduplication을 문서화한다. stale 응답에는 freshness 표시를 한다.
- Host/Origin/token, request size/method 제한, static root containment, CSP·안전한 URL protocol·출력 escaping·오류 redaction을 적용한다. mutable control API가 있으면 인증 없이 종료/수집을 허용하지 않는다.
- 제외: CLAIM support 자동 판정, 완성 Answer Card/Why/Graph/Inspector, source 원문 자동 다운로드, 외부 공유 URL.

### 예상 위험 요소와 취약점 진단 항목

DNS rebinding, CSRF/CORS, untrusted query/answer/URL의 stored XSS, path traversal와 symlink/junction escape, arbitrary local file read, SQL injection, oversized request/pagination DoS, exception의 경로·secret 유출. DB concurrent read/write·run 간 데이터 혼합·cursor 이후 late event 누락도 진단한다.

### 완료 조건

packed bin으로 `up → run → open latest(URL-only) → HTTP 조회 → down` E2E가 두 OS에서 동작한다. run ID만으로 등록된 데이터를 읽으며 모든 악성 입력에 대해 명시적 4xx와 안전한 오류를 제공한다. 최신 수집·부분/실패/UNKNOWN 정보가 최소 페이지와 API에 일치한다. 공통 게이트 전체 충족.

### 최소 테스트 기준

- 실제 socket address가 `127.0.0.1`인지 확인; wildcard/IPv6/LAN bind 거부, configured port/port conflict, readiness·server shutdown 검증.
- forged Host/port, external Origin, null Origin, cross-origin preflight, CORS header, control token missing/wrong, cross-site mutation·rebinding 형태 request를 실제 HTTP로 검증한다.
- `../`, encoded/double-encoded separators, 역슬래시, sibling-prefix, symlink/junction, absolute/drive/UNC/NUL 경로, 알려지지 않은 run ID로 private sentinel 파일이 읽히지 않는다. 지원 플랫폼의 filesystem 특수 사례를 실제 검사한다.
- SQL metacharacters, `<script>`, HTML attribute escape, `javascript:`/`data:`/`file:` source URL, 대형 body/limit/cursor, unsupported method, malformed URL을 검증한다.
- event pagination 전량 수집 시 누락·중복 0, concurrent writer 조회·reconnect, unknown/missing/deleted run, inferred/reported 라벨·private payload 배제를 검증한다.
- API 성능 기준과 tarball의 HTML/CSS/JS 자산 제공, 실제 browser 최소 페이지 smoke. source code 문자열 검사는 DOM 동작 검증을 대체하지 않는다.

### 실패로 간주할 조건

loopback 이외 bind, arbitrary file read, unauthenticated control mutation, XSS/secret exposure, data loss를 숨긴 API 200 성공, 정상 report 링크의 404/다른 서비스 연결, 미분석 데이터에 Strongly supported를 표시하는 경우.

### 다음 Milestone 진입 조건

M2 COMPLETE와 API/version·pagination·security 계약이 확정되어 있다. M3가 동일 store에서 읽고 derived report를 안전하게 반환할 경로가 있다.

### TEAMHARNESS 사용 여부

**사용 안 함.** 얇은 조회 경계와 최소 화면에 집중한다. 보안 테스트는 단일 구현의 필수 검증이다.

## 8. M3 — Evidence Engine

### 목표

관찰된 기록을 출처·주장·비교·충돌·검증·추천 관계로 구조화하고, 설명할 수 있는 근거 상태를 결정론적으로 산출한다.

### 구현 범위 / 제외 범위

- source normalization: URL host/scheme/default port/fragment 정책, canonical URL과 원본 URL, 접근/게시/갱신 시각 및 unknown, document/anchor/content hash를 보존한다. 의미 있는 query·문서 판본·지역·가격 조건을 지우지 않는다. 복제 URL 수를 독립 근거 수로 세지 않는다.
- source role(`OFFICIAL`, `PRIMARY_SOURCE`, `SECONDARY`, `COMMUNITY`)과 상태(`OUTDATED`, `CONFLICTING`, `UNKNOWN`)를 별도 축으로 표현한다. 공식성은 검증된 publisher/domain 정보와 근거로 판정하고 title에 “official”이 있다는 이유로 부여하지 않는다. official도 항상 옳다고 가정하지 않는다.
- claim extraction은 명시적 CLAIM과 정의된 structured payload에서 시작한다. 자유 문장 extraction을 제공하면 한계를 기록하고 inferred로 라벨한다. 관련 시간/지역/대상/조건, source anchor/snippet, support/refute/unknown 관계를 보존한다.
- Claim ↔ Evidence ↔ Decision graph와 reason 목록, A/B/C 조건별 comparison matrix, 선택하지 않은 후보의 이유를 만든다. 모든 factual 관계는 event/evidence reference 또는 라벨 있는 inference를 가진다. 없는 값은 UNKNOWN이다.
- contradiction은 같은 claim 조건에서 양립 불가능한 값/명시적 충돌부터 탐지한다. 의미 판정이 불확실하면 possible conflict/UNKNOWN으로 보존한다. 시점·지역 차이는 자동으로 동일 사실의 모순으로 단정하지 않는다.
- VERIFY는 무엇을 어떤 근거로 확인했는지 연결한다. verification 행위를 관찰한 것과 claim이 확인된 것은 분리한다. 명시적 resolution target·결과·조건·근거 없는 새 READ/최신 날짜만으로 conflict를 해결하지 않는다. 해결 전 상충 자료는 남긴다.
- 추천 rationale 3–5개는 뒷받침되는 이유가 충분할 때만 제공한다. 1개뿐이면 1개와 한계를 표시한다. 요약은 observed/reported/inferred 구분과 근거 link를 유지한다. unsupported recommendation도 답 텍스트는 보존하되 충분하다고 표시하지 않는다.
- derived report에 analyzer/rule version과 input revision/hash를 넣고, incremental/rebuild가 같은 결과를 만들게 한다. 아직 미해결인 참조가 들어오면 다시 분석하고 stale report를 표시한다.
- 제외: 외부 LLM/검색으로 사실 보충, hidden CoT 설명 생성, 보편적인 자연어 진실 판정, 숫자형 confidence, 최종 고급 Web UX.

### 근거 상태 판정의 최소 규칙

1. 평가할 answer/claim 또는 provenance 자체가 불명확하면 UNKNOWN; 평가 대상은 있으나 admissible support가 없으면 INSUFFICIENT_EVIDENCE.
2. 핵심 claim에 같은 조건의 미해결 상충 근거가 있으면 CONFLICTING_EVIDENCE. 다수 찬성 source로 상쇄하지 않는다.
3. 핵심 claim 중 일부만 직접 지지되거나 중요한 조건/가정이 남으면 PARTIALLY_SUPPORTED. collection PARTIAL/UNKNOWN이면 whole-answer의 강한 지지 판정을 제한하고 누락 범위를 명시한다.
4. STRONGLY_SUPPORTED는 명시된 핵심 claim과 사용자 필수 조건 전부가 admissible·직접적·조건에 맞는 근거로 지지되고 중요 unresolved assumption/conflict가 없을 때만 부여한다. source 수만으로 부여하지 않는다.
5. “핵심” claim/조건의 선정도 reported 또는 analyzer rule로 출처를 기록한다. 선택된 몇 개의 쉬운 claim만 검사해 whole answer를 강한 지지로 표시하지 않는다. 각 claim 상태와 answer 집계 규칙을 함께 공개한다.

### 예상 위험 요소와 취약점 진단 항목

false support·false resolution, source 중복의 증거 부풀리기, URL normalization에 의한 서로 다른 문서 병합, 출처 역할 위조, 날짜 불명인데 최신으로 처리, 조건을 지운 contradiction, reported explanation의 factual 승격. 악성 source의 prompt injection 문장은 실행 지시가 아니라 데이터로 다룬다. graph cycle/대량 edge의 CPU·메모리 폭증도 검사한다.

### 완료 조건

공통 fixture oracle 전체에서 source/claim/edge/conflict/resolution/answer status가 기대와 일치한다. 각 핵심 이유에서 원본 event/source anchor까지 추적할 수 있고, 반대로 부당한 지지·해결·공식성·CoT 주장이 0건이다. identical input/version의 rebuild는 동일 결과다. 공통 게이트 전체 충족.

### 최소 테스트 기준

- 위 5개 support 상태의 positive/negative/경계 테스트와 collection completeness를 섞은 조합. exit 0·RECOMMEND·reported “verified”만으로 support가 올라가지 않는다.
- 동일 source mirror/URL 복제·fragment/meaningful query·다른 edition, official-title spoof, community/primary 구분, outdated/날짜 불명 처리.
- 같은 조건 모순, 시간/지역/대상 차이, 상충 수치, 원문 누락, 확인 실패, 무관한 READ, 잘못된 VERIFY target, 명시적 resolution 후 conflict 보존.
- A/B/C 비교에서 missing cell/unsupported rejection·조건 불일치, 이유가 0/1/3/6개인 입력, invented reason 없는 요약.
- forged provenance/dangling/cross-run/cycle, malicious text/CoT sentinel, inference의 rule/version/입력 참조 보존.
- offline end-to-end `JSONL → collector → SQLite → analyzer → report API`의 기대 결과 비교. 순서 섞기·chunk 경계·재수신·incremental/rebuild 불변성 및 10k 성능 기준.
- golden fixture oracle은 구현 결과를 그대로 복사하지 않고 원본 근거와 수동 대조한다. security/truthfulness review에서 적어도 모든 negative fixture의 “나오면 안 되는 결론”을 검토한다.

### 실패로 간주할 조건

출처 수/Agent 말만으로 Strongly supported를 부여하는 경우, 모순·missing evidence를 요약에서 지우는 경우, infer/reported를 observed fact로 표시하는 경우, 공식성/검증 결과를 만들어내는 경우, 외부 LLM이 없으면 기본 analyzer가 동작하지 않는 경우.

### 다음 Milestone 진입 조건

M3 COMPLETE, derived report schema·집계 규칙·truthfulness oracle·graph relation ID·analyzer version이 확정된다. M4는 UI에서 독자적으로 support/관계를 재추론하지 않는다.

### TEAMHARNESS 사용 여부

**사용.** 구현 시작 때 현재 `.team-harness` 설정과 실행 도구를 확인한다. 권장 분담은 source/claim 계약, relation/conflict/verification 분석, 독립 oracle·보안 검토다. 파일 소유권과 report interface를 먼저 고정하고 의존 작업은 순차로 통합한다. coordinator는 worker 실제 산출물·로그·테스트를 읽고 공통 게이트로 완료를 판정한다. harness 사용 자체가 검증 증거는 아니다.

## 9. M4 — Full Web Report

### 목표

일반 사용자가 답에서 출발해 근거·불확실성·과정을 검증하고, 고급 사용자는 Graph/Raw까지 추적할 수 있는 완성 보고서를 만든다.

### 구현 범위 / 제외 범위

- **Answer first → Evidence second → Process third → Raw last** 순서를 적용한다. 기본은 Story이고 graph/raw는 명시적 선택으로 연다.
- Answer Card: 최종 answer/recommendation(없으면 부재), 중복 제거된 supporting/conflicting evidence 수, unresolved assumptions, evidence support, run/collection 상태와 분석 freshness.
- Why this answer?: 근거 있는 핵심 이유 최대 3–5개, claim/evidence로 drill-down. reported rationale과 inferred summary를 구분한다.
- Evidence Cards: role/status/현재성/source link/anchor와 어떤 claim을 지지·반박하는지 보여준다. unavailable content와 접근 시점/날짜 불명을 명시한다.
- Story: `Question → Search → Sources reviewed → Compare → Conflict → Verify → Recommendation`의 실제 존재하는 단계만 표시한다. 반복 SEARCH를 접을 수 있지만 unresolved conflict·missing support·확인 실패는 접힌 기본 상태에서도 드러나야 한다.
- Graph: Claim ↔ Evidence ↔ Decision edge를 탐색·선택하며 inferred edge를 구분한다. 단계 클릭으로 Evidence Inspector에 claim/evidence/conflict/resolution 및 provenance가 열린다.
- A/B/C comparison matrix: 사용자 조건, 가격/현재성/공식 근거 등 실제 관찰된 기준과 evidence/UNKNOWN을 표시한다. B/C 제외 이유도 근거 link를 제공한다.
- Raw Trace: 허용된 sanitized event와 adapter/analyzer debugging 정보, 제외된 필드와 손상 기록 개수·이유를 보여준다. private reasoning·credential은 Raw에도 표시하지 않는다.
- empty/loading/error/partial/UNKNOWN/stale/live/reconnect 상태, direct deep link·refresh, 키보드/좁은 화면·screen reader를 지원한다. 색상만으로 상태를 구분하지 않는다.
- 제외: account/cloud/sharing, IDE 통합, confidence %·근거 없는 순위 점수, source 자동 크롤링, UI 내부의 별도 판정 engine.

### 예상 위험 요소와 취약점 진단 항목

UI가 conflict를 접어 사실상 숨김, 모든 candidate를 검증된 것처럼 표시, source count와 claim count 혼동, stale summary와 최신 raw 불일치, Graph의 추론 edge를 실제 사실처럼 표시, stored/DOM XSS, 위험한 URL protocol, Raw를 통한 secret/CoT 노출. 큰 graph·raw 렌더링의 freeze와 접근성 퇴행도 진단한다.

### 완료 조건

사용자는 Answer의 이유를 선택해 claim→evidence→event provenance를 찾고, 비교 후보 제외 이유와 미해결 조건을 확인할 수 있다. Story/Graph/Inspector/Raw의 ID·상태·관계·수치가 API와 일치한다. conflict/UNKNOWN/partial을 기본 화면에서 숨기지 않고, 실제 browser E2E와 공통 게이트가 모두 통과한다.

### 최소 테스트 기준

- 실제 browser에서 정상 추천, 추천 없음, insufficient/conflicting/partial/UNKNOWN/실패/취소 run을 API fixture로 열고 visible text와 interaction을 assertion한다.
- Answer→Why→Evidence→Inspector와 Graph node/edge 선택, comparison의 B/C 제외 근거, Story collapse 후 경고 가시성, Raw lazy loading·pagination, deep link refresh.
- reported/observed/inferred의 text·visual 구분, 조작된 label·unsupported claim·private reasoning/credential sentinel이 DOM·response·browser console에 노출되지 않는다.
- 모든 동적 문자열·source URL·Raw에 XSS payload를 넣어 script execution 0, 위험 protocol navigation 0을 검증한다. browser 요청 기록으로 외부 font/script/image/telemetry 요청 0을 확인한다(사용자의 명시적 source 클릭은 별도 시나리오).
- 실시간 update/reconnect 시 동일 event 중복 0, run switch 데이터 섞임 0, stale 배지, server down/API 4xx/5xx가 정상 화면으로 오인되지 않는다.
- keyboard-only 전체 흐름, focus/Inspector 닫기·복귀, semantic labels, 자동 accessibility 검사 serious/critical 0, 360px 화면에서 필수 정보 접근·가로 overflow 확인.
- 10k-event/다량 graph 기본 화면 성능 기준, bounded DOM/페이지 분할, 양 OS packed UI browser E2E. 정적 HTML/JS 문자열 테스트와 screenshot만으로 완료 금지.
- README에 동일 질문의 “AI에게 왜?라고 묻기 vs ViewTrace evidence trail” 비교를 넣고, 대표 demo는 fixture임을 명시한다. 실제 Agent 지원을 선행 주장하지 않는다.

### 실패로 간주할 조건

default UI가 raw dump 또는 coding radar에 머무는 경우, uncertainty가 클릭 전 보이지 않는 경우, evidence 없는 이유·source role·resolution을 만들어 표시하는 경우, graph/inspector/Raw가 mock-only인 경우, 핵심 E2E/a11y/security test를 skip한 경우.

### 다음 Milestone 진입 조건

M4 COMPLETE, reference adapter의 연구→추천 E2E와 full report가 완성되어 있다. M5는 동일 schema/API/Web에 실제 Agent event만 연결할 수 있어야 한다.

### TEAMHARNESS 사용 여부

**사용.** Answer/Why/Evidence·Story/Graph/Inspector·browser E2E/security/a11y를 독립 소유권으로 나눈다. 공통 report schema와 상태 component 계약을 먼저 고정하고 통합 리뷰로 UI 재추론·정보 은폐를 확인한다.

## 10. M5 — Real Agent Adapters

### 목표

검증된 실제 Agent의 observable Research/Decision 기록을 연결하고, 관찰 가능한 범위와 부족한 부분을 정직하게 표시하는 v0.1 배포 후보를 만든다.

### 구현 범위 / 제외 범위

- 기본 검증 대상은 현재 parser 경험이 있는 **Codex와 Claude Code** 두 adapter다. 기존 coding adapter의 이름·PARTIAL 등급은 새 research 지원 증거가 아니다. 각 도구의 실제 제공 format/version/tool payload를 조사해 research mapping을 별도로 구현한다.
- capability matrix는 SEARCH/READ/CLAIM/COMPARE/HYPOTHESIS/CONTRADICTION/VERIFY/RECOMMEND, source anchor, live ingest, completion, provenance별 YES/PARTIAL/NO/UNKNOWN과 구체적 한계를 제공한다. 없던 tool result/읽기 원문/source ID는 만들어내지 않는다.
- 직접 tool/search/read result는 observed, Agent final answer/rationale는 reported, analyzer가 만든 relation/story는 inferred로 분류한다. call-only와 result 없는 operation은 성공이 아니다. provenance에는 vendor version/format·call ID·source location을 남긴다.
- `viewtrace run -- <agent>`의 supported invocation, opt-in local history/import/live collection과 fallback을 완성한다. global Agent 설정 자동 변경 금지; hook이 필요하면 explicit opt-in, 프로젝트 범위, uninstall/원상복구를 제공한다.
- 실제 source format의 변동·unknown tool/schema·truncated/malformed·missing result를 fail-safe하게 처리하고 diagnostics/capability downgrade를 노출한다.
- sanitization한 실제 fixture와 provenance manifest를 추가한다. manifest에는 도구/version/OS/수집 방식/날짜/제거된 필드·시나리오를 적고 private transcript·사용자 secret·CoT는 커밋하지 않는다.
- ZCode는 현재 debug model-io 형식의 research evidence를 별도 검증했을 때만 EXPERIMENTAL/PARTIAL로 추가한다. OpenCode는 실제 자료와 테스트가 없으면 UNAVAILABLE로 유지한다. 미검증 provider를 지원 목록에 채워 넣지 않는다.
- README·CHANGELOG·SECURITY·capability/Node/OS/install/uninstall/data delete 안내를 실제 release candidate와 일치시키고 packed artifact의 의존성·license·내용을 점검한다.
- 제외: 코딩 기능 전체 재도입, 모든 Agent FULL 지원, hidden reasoning scraping, 자동 browser/검색 실행으로 누락 보충, cloud aggregator, npm/GitHub 공개 게시 자체.

### 예상 위험 요소와 취약점 진단 항목

vendor format 변화·tool name 오분류·nested payload, multi-call result pairing 오류, wrapper exit와 실제 outcome 혼동, Agent 설명에서 fake search/read를 만들어내기, encrypted/private thinking 노출, 사용자 history 과도 탐색, symlink/history rotation, 전역 config 오염, 실제 Agent auth/quota 실패를 정상 추천 완료로 표시하는 문제.

real fixture가 synthetic과 거의 같은 성공 예만 담는 표본 편향과, masking이 관계/충돌을 지워 oracle 의미를 바꾸는 문제도 검토한다.

### 완료 조건

Codex/Claude Code 각각 실제 version과 지원 수집 경로가 고정되고, real sanitized fixture replay·실제 live run·양 OS wrapper 설치 경계 검증이 통과한다. 둘 중 하나라도 필수 검증이 불가능하면 M5 전체는 BLOCKED/IN PROGRESS이며 완성된 adapter만 부분 완료로 기록한다. capability matrix는 관측 데이터와 정확히 일치한다. 배포 tarball만으로 reference/real-adapter replay/full Web이 실행되며, 기본 ViewTrace runtime의 외부 송신은 0이다. 공통 게이트 전체 충족.

### 최소 테스트 기준

- adapter별 실제 수집한 최소 3개 독립 run: (1) search/read 후 정상 답변, (2) 비교/모순·검증 또는 unsupported capability가 드러나는 run, (3) 실패·취소·중단/partial run. 성공 예만 3개 반복하는 것으로 대체 금지.
- 각 adapter의 real fixture event/provenance를 원본 허용 record와 수동 대조하고 expected mapping을 고정한다. synthetic adversarial fixture로 없는 SEARCH/READ/VERIFY/완료를 합성하지 않는지 검증한다.
- versioned parser, tool call/result pairing·parallel/out-of-order·unknown tool·nested JSON·provider error/quota·format drift·rotation·missing source/private thinking를 regression으로 고정한다.
- runtime capability에 YES/PARTIAL을 표기한 기능은 검증 fixture가 있어야 한다. 지원하지 않는 COMPARE/VERIFY라도 unsupported/UNKNOWN 전달 테스트는 필수다. matrix 등급은 field coverage에 근거하며 모든 vendor event를 지원한다는 의미로 FULL을 사용하지 않는다.
- adapter별 실제 live research E2E 최소 1회: CLI 활동→SQLite→analyzer→Web→provenance link. observed tool action과 화면을 대조한다. live 외부 Agent 검증은 반복 3회 offline suite와 별도로 기록하며 credentials/quota 부족으로 skip할 수 없다.
- Windows/Linux에서 실제 지원 Agent launcher 또는 동일 executable 형태의 deterministic harness로 argv·`.cmd`·signal/process tree·history 경계를 검증한다. deterministic harness는 실제 live mapping 검증을 대체하지 않는다. live Agent OS가 하나뿐이면 그 검증 범위를 matrix에 표시하고 다른 OS에서 live 지원을 검증했다고 주장하지 않는다.
- 양 OS tarball 설치 후 reference end-to-end, 실제 sanitized history import/replay, full browser report, package runtime dependency/asset/secret/license audit. `npm ci`로 lock 재현 후 전체 필수 suite 3회와 race 20회/OS.
- collector/analyzer/server network sentinel 0, 원본 Agent history checksum 불변, opt-in 설정 변경/원상복구, Raw/console/DB/JSONL에서 credential/private reasoning marker 부재.

### 실패로 간주할 조건

실제 Agent 없이 synthetic만으로 “지원 완료” 선언, coding log의 성공을 research verification으로 매핑, private analysis 노출, capability 과장, global config 무단 변경, 실제 live 실패를 fixture 통과로 대체, Node/Windows/Linux 설치·core E2E·security gate 미검증.

### 다음 Milestone 진입 조건

이 로드맵의 마지막 단계다. M5 COMPLETE와 재현 가능한 release candidate·검증 기록·정직한 support matrix가 있어야 v0.1 배포 검토로 진입한다. 게시·태그·npm publish·원격 merge는 별도 요청에 따라 수행한다. 이후 Agent/extension·macOS 확대·코딩 작업 지원은 별도 Milestone으로 정의한다.

### TEAMHARNESS 사용 여부

**사용.** Codex와 Claude research adapter, 독립 provenance/privacy 검토, OS/pack/E2E 통합을 나눈다. 같은 registry/schema 파일의 동시 수정은 피하고 단일 통합 담당자가 capability와 최종 artifact를 검증한다.

## 11. TEAMHARNESS 운영의 공통 제한

- 기존 `.team-harness/config.toml`과 coordinator/worker 지침을 유지하고 M3–M5에서만 활용한다. 문서 작성, 작은 수정, M0–M2를 위해 실행하지 않는다.
- 구현 작업마다 목표·범위·비목표·cwd·파일 소유권·입출력 계약·fixture oracle·완료 기준을 포함한 self-contained worker task를 만든다. 선행 계약 작업 뒤에 구현/통합을 진행한다.
- harness coordinator는 worker의 실제 파일·로그·테스트를 확인한다. worker의 “완료” 응답이나 서로 같은 결론만으로 완료 판정하지 않는다. 공유 workspace 동시 변경·integration conflict를 점검한다.
- harness는 외부 provider를 사용할 수 있다. 이는 개발 orchestration이며 제품 runtime의 local-only와 별개다. secret·실사용 private trace·hidden reasoning을 worker prompt나 `_outputs` artifact에 포함하지 않는다. 모델/API 설정 변경·추가 비용 정책을 임의로 확장하지 않는다.
- harness/auth/provider 접근이 막히면 해당 작업의 blocker를 기록한다. harness 실행 여부와 품질 게이트 결과를 분리해서 보고하며, 누락된 필수 검증을 생략한 COMPLETE 선언은 금지한다.
