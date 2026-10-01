# ArkWork

요구사항에서 소프트웨어 결과까지 이어지는 Software Factory.

첫 MVP는 요구사항 입력, 데모 작업 진행, 결과 검토를 제공하는 한국어 웹 UI입니다. AI 실행, 저장소 수정, 실제 PR 생성은 아직 연결되지 않았습니다.

## 개발

Node.js 24 이상에서 실행합니다.

```sh
npm ci
npm run dev -- --host 0.0.0.0
```

검증: `npm run check`, `npm test`, `npm run build`.

작업은 별도 브랜치에서 진행하고 PR로 검토합니다. 주요 결정은 `docs/architecture.md`, 개발 규칙은 `AGENTS.md`에 기록합니다.
