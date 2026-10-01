# ArkWork MVP decisions

## Product

ArkWork is a complete Software Factory: users submit requirements and review software results. The first milestone is a Korean UI demonstrating requirements → progress → review. The user explicitly selected UI first, not actual AI execution.

## Implementation

- React + TypeScript + Vite, Node.js 24. The standalone demo still requires no backend. Default local API mode adds Fastify and a PostgreSQL-compatible persistence layer.
- `WorkRepository` separates `DemoRepository` (browser timer/storage) and `ApiRepository` (HTTP/SSE). API fixture progress runs on the server, not the browser. Both modes disclose simulated code execution, while Codex-generated planning content is marked separately.
- Recent 20 demo runs persist in localStorage. Server mode persists work, hashed sessions and ordered events in `.runtime/database` with PGlite; its list returns up to 100 items. No automatic demo-to-server data migration occurs.
- New server requirements first enter awaiting_input, then awaiting_run_approval after a human answer. A canonical plan hash binds requirements, fixture policy and limits. Approval atomically records the actor, approved version and hash, emits an event and enqueues one job. Repeated approval requests are idempotent.
- Up to three approved queued/active simulations per workspace, with one active execution. Workspace/work/job lock order, worker owner, lease expiry and generation fence execution. Expired leases recover under a two-attempt limit; stale workers cannot advance. Running cancellation uses cancelling until a worker or expired lease confirms stopped execution. Pending/unapproved cancellation completes immediately.
- User requirements are rendered as text, not HTML. Downloaded Markdown is a demo handoff, not generated software.
- Dark responsive layout supports mobile navigation and keyboard focus. Demo and fixture progress make no model calls. The optional Codex planning adapter calls the model only through explicit authenticated requests. API mode uses an explicit development identity selector through the client adapter; this is not production authentication or hosting.
- SSE supports Last-Event-ID/cursor replay, session expiry/revocation and graceful shutdown. List polling supplements SSE. Database migrations use a transaction, advisory lock and recorded checksum.
- PostgreSQL via `pg` is available behind `DATABASE_URL`; current integration evidence uses the PGlite engine. Multi-process PGlite access is unsupported.

## Next milestone

M1 foundation now has durable local work, project APIs, protected development sessions, fixture approval/queue and event delivery. Production identity, approval/state coverage beyond fixtures, external side-effect publishing, real agent execution and public hosting remain outstanding. Add GitHub authentication/integration and validate authenticated Codex execution in M2. Do not treat fixture completion as verified generated software.

Migration 002 preserves completed legacy history and requires fresh approval for unfinished pre-approval fixtures. The original 001 checksum is retained. Fixture policies do not authorize later AI calls or repository edits; new scopes need new approved plans and execution contracts.

## Handoff

The UI was merged through [PR #1](https://github.com/yth1209/ArkWork/pull/1). Current main contains the local development API, durable fixture queue and human checkpoints. Use the saved cloud environment install/start instructions; do not assume running processes survive a new task. The user now authorizes direct commits and pushes to main after validation. Create a PR only when explicitly requested.

The detailed future product plan is indexed in [docs/README.md](README.md). It does not imply those services are already implemented. Cloud-local servers are not user-facing hosting; externally accessible previews require a separate deployment integration.

## 사람 개입 흐름

새 작업에 요구사항 질문·답변, 계획 수정·승인, 구현 전 결정·재개, 결과 수정·재승인 및 최종 결과 승인을 연결했다. 입력과 이력은 DB에 저장하며 수정 계획 해시를 바꿔 이전 승인과 worker 권한을 철회한다. 결정 대기는 lease를 해제하고 재시작·시간 경과로 자동 승인되지 않는다. 상세 계약과 제한은 [사람 개입 흐름](human-checkpoints.md)을 따른다. 기본 질문·판단은 데모다. 선택적인 Codex 질문·명세 adapter를 추가했으며 실제 계정 호출 검증은 로그인 후 남아 있다.

## Codex 구독 adapter

공식 SDK·CLI 0.159.3을 고정했다. 별도 ChatGPT 로그인과 owner의 버튼 요청으로 질문·명세를 작성하며 `agent_calls`에 실행·중단·사용량 메타데이터를 저장한다. 작성한 명세는 계획 해시에 포함하고 사람 승인을 요구한다. 실제 계정 호출은 아직 검증 전이고 코드 실행은 모의다. [Codex 구독 연결](codex-subscription.md)에서 환경·인증·한도와 테스트 범위를 확인한다.
