import { execFile } from "node:child_process";
import type { PullRequestReview } from "../src/factory";
import { HttpError } from "./store";

export type Target = { repository: string; base: string; branch: string };
export type Snapshot = Required<
  Pick<
    PullRequestReview,
    | "number"
    | "url"
    | "headSha"
    | "open"
    | "draft"
    | "checks"
    | "files"
    | "filesTruncated"
  >
>;
export interface GitHubProvider {
  repositories: string[];
  publish(
    target: Target,
    work: { id: string; prompt: string },
  ): Promise<Snapshot>;
  inspect(target: Target, number: number): Promise<Snapshot>;
}
// GitHub credentials remain in gh's server-side configuration / platform proxy.
// No shell, browser credentials, or caller-supplied host or command is used.
export class GitHubCli implements GitHubProvider {
  constructor(
    readonly repositories: string[],
    private transport?: (path: string, body?: unknown) => Promise<unknown>,
  ) {}
  private api<T>(path: string, body?: unknown): Promise<T> {
    if (this.transport) return this.transport(path, body) as Promise<T>;
    return new Promise((resolve, reject) => {
      const child = execFile(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          path,
          ...(body ? ["--method", "POST", "--input", "-"] : []),
        ],
        { timeout: 30000, maxBuffer: 2_000_000 },
        (error, stdout) => {
          if (error)
            return reject(
              new HttpError(
                502,
                "GITHUB_UNAVAILABLE",
                "GitHub 요청을 완료하지 못했습니다. 서버 인증·권한을 확인하고 다시 시도하세요.",
              ),
            );
          try {
            resolve(JSON.parse(stdout) as T);
          } catch {
            reject(
              new HttpError(
                502,
                "GITHUB_RESPONSE",
                "GitHub 응답을 확인하지 못했습니다.",
              ),
            );
          }
        },
      );
      if (body) child.stdin?.end(JSON.stringify(body));
    });
  }
  async publish(target: Target, work: { id: string; prompt: string }) {
    const { repository, branch, base } = target;
    const marker = `<!-- arkwork:${work.id} -->`;
    const find = async () => {
      const prs = await this.api<{ number: number; body: string | null }[]>(
        `repos/${repository}/pulls?state=open&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(base)}&per_page=100`,
      );
      if (prs.length && !prs.some((pr) => pr.body?.includes(marker)))
        throw new HttpError(
          409,
          "PR_ALREADY_EXISTS",
          "이 브랜치에는 다른 작업의 PR이 있습니다. 작업 전용 브랜치를 사용하세요.",
        );
      return prs.find((pr) => pr.body?.includes(marker));
    };
    let pr = await find();
    if (!pr) {
      const comparison = await this.api<{
        ahead_by: number;
        total_commits: number;
        files: unknown[];
      }>(
        `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`,
      );
      if (!comparison.ahead_by || !comparison.files.length)
        throw new HttpError(
          409,
          "NO_IMPLEMENTATION",
          "기준 브랜치와 다른 실제 커밋·파일이 필요합니다. 모의 결과로 PR을 만들 수 없습니다.",
        );
      try {
        pr = await this.api<{ number: number; body: string }>(
          `repos/${repository}/pulls`,
          {
            head: branch,
            base,
            title: `ArkWork: ${work.prompt.replace(/\s+/g, " ").slice(0, 80)}`,
            body: `${marker}\n\n요구사항\n\n${work.prompt}\n\n기존 구현 브랜치에서 제출한 결과입니다. ArkWork가 코드를 생성하거나 테스트했다고 주장하지 않습니다. 변경 파일과 CI 결과를 확인하고 ArkWork에서 평가하세요. 병합은 별도로 사람이 수행합니다.`,
          },
        );
      } catch (error) {
        // A timeout or racing retry may have created the PR. Reconcile by marker.
        pr = await find();
        if (!pr) throw error;
      }
    }
    return this.inspect(target, pr.number);
  }
  async inspect(target: Target, number: number): Promise<Snapshot> {
    const root = `repos/${target.repository}`;
    const pr = await this.api<{
      number: number;
      html_url: string;
      state: string;
      draft: boolean;
      changed_files: number;
      head: { sha: string; ref: string; repo: { full_name: string } | null };
      base: { ref: string; repo: { full_name: string } };
    }>(`${root}/pulls/${number}`);
    if (
      pr.head.ref !== target.branch ||
      pr.base.ref !== target.base ||
      pr.head.repo?.full_name.toLowerCase() !==
        target.repository.toLowerCase() ||
      pr.base.repo.full_name.toLowerCase() !== target.repository.toLowerCase()
    )
      throw new HttpError(
        409,
        "PR_TARGET_CHANGED",
        "PR의 저장소나 대상 브랜치가 변경됐습니다.",
      );
    if (
      !/^[a-f0-9]{40}$/.test(pr.head.sha) ||
      pr.html_url !== `https://github.com/${target.repository}/pull/${number}`
    )
      throw new HttpError(
        502,
        "GITHUB_RESPONSE",
        "PR 식별 정보를 확인하지 못했습니다.",
      );
    const [files, runs, statuses] = await Promise.all([
      this.api<{ filename: string; additions: number; deletions: number }[]>(
        `${root}/pulls/${number}/files?per_page=100`,
      ),
      this.api<{
        total_count: number;
        check_runs: { status: string; conclusion: string | null }[];
      }>(`${root}/commits/${pr.head.sha}/check-runs?per_page=100`),
      this.api<{ state: string; total_count: number }>(
        `${root}/commits/${pr.head.sha}/status?per_page=100`,
      ),
    ]);
    const failed =
      runs.check_runs.some(
        (r) =>
          r.status === "completed" &&
          !["success", "neutral", "skipped"].includes(r.conclusion ?? ""),
      ) || ["failure", "error"].includes(statuses.state);
    const pending =
      runs.total_count > runs.check_runs.length ||
      runs.check_runs.some((r) => r.status !== "completed") ||
      (statuses.total_count > 0 && statuses.state === "pending");
    return {
      number,
      url: pr.html_url,
      headSha: pr.head.sha,
      open: pr.state === "open",
      draft: pr.draft,
      checks: failed
        ? "failed"
        : pending
          ? "pending"
          : runs.total_count || statuses.total_count
            ? "passed"
            : "unreported",
      files: files.map((f) => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
      })),
      filesTruncated: pr.changed_files > files.length,
    };
  }
}
