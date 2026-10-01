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

브라우저 검증: 개발 서버 실행 후 `npx playwright install chromium`으로 브라우저를 준비하고 `npm run test:smoke`를 실행합니다. 시스템 Chromium이 있다면 `CHROMIUM_PATH=/usr/bin/chromium npm run test:smoke`로 실행할 수 있습니다. 다른 포트는 `APP_URL`로 지정합니다. 데스크톱과 모바일에서 입력 검증, 진행·취소, 다운로드, 기록 복원과 가로 넘침을 검사합니다.

작업 기록은 이 브라우저에만 저장되며 최근 20개까지 유지됩니다. 실제 AI 실행과 코드 생성은 수행하지 않습니다. 민감한 정보나 자격 증명을 요구사항에 넣지 마세요.

작업은 별도 브랜치에서 진행하고 PR로 검토합니다. 주요 결정은 `docs/architecture.md`, 개발 규칙은 `AGENTS.md`에 기록합니다.
