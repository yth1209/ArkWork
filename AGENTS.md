# Development instructions

- Use the existing checkout; cloud tasks are already isolated. Do not create worktrees unless requested.
- Commit changes directly to main and push after appropriate validation. Do not create PRs unless the user explicitly requests one. This workflow was authorized by the user on 2026-10-01 and supersedes the previous branch-and-PR requirement.
- Keep user-facing text in Korean. Clearly label simulated behavior; never claim an AI run, commit, test, or PR occurred when it did not.
- Do not put credentials in repository files, browser storage, or frontend code.
- Run `npm run check`, `npm test`, and `npm run build` for application changes.
- Record important architectural decisions and outstanding work in docs so a new conversation can continue.
