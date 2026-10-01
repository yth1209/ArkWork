# Codex 구독 연결

ArkWork는 공식 `@openai/codex-sdk`와 SDK가 실행하는 Codex CLI를 사용한다. SDK·CLI 버전은 0.159.3으로 고정했다. ChatGPT 구독 로그인만 지원하며 API 키로 자동 대체하지 않는다. 이 채팅의 인증이나 실행 세션은 가져오지 않는다.

## 현재 구현 범위

- 새 작업의 요구사항 확인 단계에서 Codex 질문을 작성하고 사용자가 답변한다.
- 계획 승인 대기에서 Codex가 사용자 답변·수정 의견을 반영한 명세 초안(요약·완료 조건·제외 범위)을 작성한다.
- Codex 결과는 자동 승인하지 않는다. 생성한 질문과 명세를 계획 해시에 포함하고 사람이 검토·승인해야 모의 진행을 시작한다.
- 코드 작성·실제 테스트·GitHub 작업·배포는 아직 연결하지 않았다. 명세 작성 뒤의 구현 진행은 기존 서버 모의 실행이다. 기존 데모 영상도 실제 Codex 호출 증거가 아니다.

현재 연결은 **로컬 개발 owner 계정의 개인용 pilot**이다. 여러 사용자의 구독을 서비스 계정 하나로 합치거나 상용 다중 사용자 실행을 제공하는 기능은 아니다. 운영 인증·사용자별 계정 저장·격리 worker는 후속 작업이다.

## 로그인과 시작

```sh
npm ci
npm run codex:login
npm run codex:status
ARKWORK_DEV_AUTH=1 ARKWORK_CODEX_ENABLED=1 npm run dev:api
# 별도 터미널
npm run dev -- --host 0.0.0.0
```

`codex:login`은 device 인증 URL과 일회용 코드를 표시한다. 본인 브라우저에서 로그인하고 인증을 완료한다. 계정의 보안 설정에서 device code 로그인이 허용되어 있어야 한다. `codex:status`에서 ChatGPT 로그인이 확인되어야 호출 버튼을 사용할 수 있다. 연결 해제는 `npm run codex:logout`이다.

로그인 전 또는 `ARKWORK_CODEX_ENABLED=1`이 없으면 실제 호출을 차단한다. `login status`는 로컬 인증 정보의 존재를 확인하며 구독 잔여 한도나 실제 모델 호출 성공을 보장하지 않는다. 구독의 사용 한도와 모델 접근 범위는 로그인한 계정을 따른다.

인증 정보는 별도의 `.runtime/codex-subscription`에 저장한다. `.runtime`은 Git에서 제외되고 디렉터리는 0700으로 생성한다. 인증 파일이나 토큰을 채팅·브라우저·저장소에 복사하지 않는다. `ARKWORK_CODEX_HOME`으로 외부에서 안전하게 관리하는 별도 인증 경로를 지정할 수 있다. 기존 개발 채팅의 Codex home을 지정하지 않는다.

## 호출·제한·취소

각 버튼은 실제 구독 사용량을 쓰는 호출 1회를 명시적으로 요청한다. 작업 생성·답변 저장·계획 승인만으로 Codex를 자동 호출하지 않는다. 한 workspace에서 동시 호출 1건, 회차별 같은 종류 최대 2회, 호출 시간 최대 2분이다. 실패·중단·서버 재시작 후 자동 재호출하지 않는다. 취소·실패 호출도 호출 횟수에 포함한다. 중단 전에 이미 사용한 구독 사용량이 취소된다고 보장하지 않는다.

- 입력과 요청 키, 사용자, 상태, 생성 결과의 이벤트, thread ID와 제공된 토큰 사용량을 저장한다. 비밀 인증 데이터·raw provider 오류·내부 추론은 저장하지 않는다.
- 입력을 hash로 고정한다. 중복 요청은 다시 등록하지 않고 오래된 버전은 거부한다. 실행 중 답변·계획 변경·계획 승인을 막는다.
- `Codex 호출 중단` 또는 작업 취소로 실행을 중단한다. 실행 중단 확인 후 입력을 다시 받을 수 있다. 늦게 도착한 결과·만료된 worker의 결과는 반영하지 않는다.
- 서버가 중단된 호출은 130초 실행 권한이 만료되면 실패로 기록한다. 남은 pending 호출은 다시 시작할 수 있지만 이미 시작한 호출은 반복하지 않는다.
- 수정 의견을 제출하면 기존 명세를 현재 계획에서 제거하고 이전 승인 권한을 철회한다. 새 명세를 직접 요청하거나 수정된 수동 계획을 검토하고 다시 승인할 수 있다. 이전 결과는 작업 이벤트와 호출 기록에 남는다.

API는 `GET /v1/agent`, `POST /v1/work-items/:id/codex`(expected_version, phase, request_key), `POST /v1/work-items/:id/codex/cancel`이다. 기존 로컬 세션·요청 보호·workspace 접근을 검사하며 실제 구독 호출은 owner에 한정한다.

## 실행 경계

SDK는 API 키와 DB·GitHub 자격 증명을 상속하지 않는 제한된 환경을 사용한다. 별도 임시 작업 디렉터리에서 read-only, 승인 요청 없음, shell·unified exec·apps·multi-agent 비활성, web search·작업 네트워크 접근 비활성으로 명세 데이터만 처리한다. 이 옵션들은 로컬 계획 단계의 제한이며 전체 host 읽기 격리나 운영용 컨테이너를 대체하지 않는다. 실제 코드 실행에는 별도 격리 환경이 필요하다.

출력 JSON은 필드·개수·길이를 검증한다. 질문은 1~5개, 명세 완료 조건은 1~8개, 제외 범위는 최대 8개다. 공급자 통신은 Codex CLI가 처리하므로 worker의 shell 네트워크 비활성 설정과 모델 연결은 별개다.

## 검증과 남은 작업

40개 자동 테스트, 타입 검사·빌드와 데스크톱·모바일 브라우저 검증을 통과했다. Codex 브라우저 검증은 **테스트 대역**을 사용하며 실제 계정이나 구독 사용량을 소모하지 않는다.

```sh
CHROMIUM_PATH=/usr/bin/chromium npm run test:codex-smoke
```

인증 없음 차단, structured output 검증, API 키 상속 방지, 명시적 호출과 중복 방지, 질문·명세 영속 저장과 계획 hash, 생성 중 수정·승인 차단, 취소·시간 제한·실패 후 무재시도, 만료된 worker 출력 차단을 검증했다. 실제 ChatGPT 로그인과 구독 모델 호출은 현재 환경에서 아직 검증하지 않았다. `npm run codex:login`을 시도했지만 `auth.openai.com` 연결이 egress proxy의 CONNECT 403으로 차단되어 인증 코드가 발급되지 않았다. 환경 설정 초안에 기존 네트워크 규칙을 보존하고 `auth.openai.com`, `chatgpt.com` 허용을 추가했다. 초안 저장은 현재 런타임에 적용되지 않으므로 사용자가 환경 설정을 적용한 뒤 로그인부터 다시 확인해야 한다. 그 후 별도의 명시적 pilot 호출로 모델 동작을 검증한다.

공식 참고: [SDK](https://github.com/openai/codex/tree/main/sdk/typescript), [ChatGPT 로그인](https://github.com/openai/codex#using-codex-with-your-chatgpt-plan), [인증](https://developers.openai.com/codex/auth).
