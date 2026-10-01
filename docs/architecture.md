# ArkWork MVP decisions

## Product

ArkWork is a complete Software Factory: users submit requirements and review software results. The first milestone is a Korean UI demonstrating requirements → progress → review. The user explicitly selected UI first, not actual AI execution.

## Implementation

- React + TypeScript + Vite, Node.js 24. No backend or credentials required for this milestone.
- Demo state machine advances on a client-side timer. Every simulated operation is labeled. No generated code, test results or PR links are fabricated.
- Recent 20 runs persist in localStorage. They are local to the browser, not account-synced; storage failures surface a warning. A running demo resumes when the app opens.
- At most three demos run concurrently. Cancelled runs never advance. Malformed storage is discarded.
- User requirements are rendered as text, not HTML. Downloaded Markdown is a demo handoff, not generated software.
- Dark responsive layout supports mobile navigation and keyboard focus. No external AI API requests are made.

## Next milestone

Define acceptance criteria and connect a backend with durable job storage, authentication, an agent runner, isolated repository execution, real validation, and a human-reviewed PR workflow. Choose AI provider and credentials then. Do not treat client-side simulation as production execution.

## Handoff

The UI was merged through [PR #1](https://github.com/yth1209/ArkWork/pull/1). Current main contains the demo. Use the saved cloud environment install/start instructions; do not assume running processes survive a new task. All follow-up changes require a feature branch and PR; merge only on explicit instruction.

The detailed future product plan is indexed in [docs/README.md](README.md). It does not imply those services are already implemented. Cloud-local servers are not user-facing hosting; externally accessible previews require a separate deployment integration.
