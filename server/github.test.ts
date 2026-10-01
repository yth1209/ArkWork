import { expect, it, vi } from "vitest";
import { GitHubCli } from "./github";
const target = {
  repository: "owner/repo",
  base: "main",
  branch: "factory/change",
};
const sha = "a".repeat(40);
function transport(
  options: {
    existing?: boolean;
    empty?: boolean;
    checks?: unknown;
    status?: unknown;
    foreign?: boolean;
  } = {},
) {
  return vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
    if (path.includes("pulls?"))
      return options.existing
        ? [{ number: 7, body: "<!-- arkwork:work-id -->" }]
        : [];
    if (path.includes("compare/"))
      return {
        ahead_by: options.empty ? 0 : 1,
        files: options.empty ? [] : [{}],
      };
    if (path.endsWith("/pulls") && body) return { number: 7 };
    if (path.endsWith("/pulls/7"))
      return {
        html_url: "https://github.com/owner/repo/pull/7",
        state: "open",
        draft: false,
        changed_files: 101,
        head: {
          sha,
          ref: target.branch,
          repo: {
            full_name: options.foreign ? "other/repo" : target.repository,
          },
        },
        base: { ref: target.base, repo: { full_name: target.repository } },
      };
    if (path.includes("/files?"))
      return [{ filename: "file.ts", additions: 1, deletions: 0 }];
    if (path.includes("/check-runs?"))
      return (
        options.checks ?? {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "success" }],
        }
      );
    if (path.includes("/status?"))
      return options.status ?? { state: "pending", total_count: 0 };
    throw new Error(`Unexpected route ${path}`);
  });
}
it("creates a real PR only after a nonempty comparison and includes a stable reconciliation marker", async () => {
  const api = transport();
  const github = new GitHubCli([target.repository], api);
  const result = await github.publish(target, {
    id: "work-id",
    prompt: "팀 작업 앱",
  });
  expect(result).toMatchObject({
    number: 7,
    headSha: sha,
    checks: "passed",
    filesTruncated: true,
  });
  expect(
    api.mock.calls.find(([path, body]) => path.endsWith("/pulls") && body)?.[1],
  ).toMatchObject({
    base: "main",
    head: target.branch,
    body: expect.stringContaining("<!-- arkwork:work-id -->"),
  });
});
it("reuses the marked PR on retry without posting or comparing", async () => {
  const api = transport({ existing: true });
  await new GitHubCli([target.repository], api).publish(target, {
    id: "work-id",
    prompt: "팀 작업 앱",
  });
  expect(api.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
  expect(api.mock.calls.some(([path]) => path.includes("compare/"))).toBe(
    false,
  );
});
it("refuses an empty branch and a changed repository", async () => {
  const api = transport({ empty: true });
  await expect(
    new GitHubCli([target.repository], api).publish(target, {
      id: "work-id",
      prompt: "앱",
    }),
  ).rejects.toMatchObject({ code: "NO_IMPLEMENTATION" });
  expect(api.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
  await expect(
    new GitHubCli([target.repository], transport({ foreign: true })).inspect(
      target,
      7,
    ),
  ).rejects.toMatchObject({ code: "PR_TARGET_CHANGED" });
});
it.each([
  [
    { total_count: 0, check_runs: [] },
    { total_count: 0, state: "pending" },
    "unreported",
  ],
  [
    { total_count: 1, check_runs: [{ status: "in_progress" }] },
    { total_count: 0, state: "pending" },
    "pending",
  ],
  [
    {
      total_count: 101,
      check_runs: [{ status: "completed", conclusion: "success" }],
    },
    { total_count: 0, state: "pending" },
    "pending",
  ],
  [
    {
      total_count: 1,
      check_runs: [{ status: "completed", conclusion: "failure" }],
    },
    { total_count: 0, state: "pending" },
    "failed",
  ],
  [
    { total_count: 0, check_runs: [] },
    { total_count: 1, state: "failure" },
    "failed",
  ],
])(
  "reports check evidence conservatively",
  async (checks, status, expected) => {
    const result = await new GitHubCli(
      [target.repository],
      transport({ checks, status }),
    ).inspect(target, 7);
    expect(result.checks).toBe(expected);
  },
);
