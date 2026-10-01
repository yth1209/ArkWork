import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./database";
import type { GitHubProvider, Snapshot, Target } from "./github";
import { HttpError } from "./store";
import { event, toRun, type Row } from "./work";
import { hashPlan } from "./plans";

export class PullRequests {
  constructor(
    private db: Database,
    readonly provider?: GitHubProvider,
  ) {}
  status() {
    return {
      enabled: Boolean(this.provider),
      repositories: this.provider?.repositories ?? [],
    };
  }
  private async row(tx: Queryable, workspace: string, id: string) {
    const actor = (
      await tx.query("SELECT identity FROM workspaces WHERE id=$1 FOR UPDATE", [
        workspace,
      ])
    ).rows[0];
    const row = (
      await tx.query<Row>(
        "SELECT * FROM work_items WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [id, workspace],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "작업을 찾을 수 없습니다.");
    if (actor?.identity !== "owner")
      throw new HttpError(
        403,
        "OWNER_REQUIRED",
        "소유자만 PR을 제출하고 평가할 수 있습니다.",
      );
    return row;
  }
  private enabled(target: Target) {
    if (!this.provider)
      throw new HttpError(
        409,
        "GITHUB_DISABLED",
        "서버의 GitHub PR 연결을 먼저 활성화하세요.",
      );
    if (!this.provider.repositories.includes(target.repository))
      throw new HttpError(
        403,
        "REPOSITORY_DENIED",
        "서버에 허용된 저장소만 사용할 수 있습니다.",
      );
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repository) ||
      [target.base, target.branch].some(
        (ref) =>
          !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(ref) ||
          ref.includes("..") ||
          ref.includes("//") ||
          ref.endsWith("/") ||
          ref.endsWith(".lock"),
      ) ||
      target.base === target.branch
    )
      throw new HttpError(
        422,
        "INVALID_TARGET",
        "저장소와 서로 다른 유효한 브랜치를 입력하세요.",
      );
  }
  private version(row: Row, version: number) {
    if (row.version !== version)
      throw new HttpError(
        409,
        "VERSION_CONFLICT",
        "작업이 변경됐습니다. 최신 내용을 확인하세요.",
      );
  }
  private async save(tx: Queryable, row: Row, type: string) {
    const result = (
      await tx.query<Row>(
        "UPDATE work_items SET pull_request=$2,state=$3,human_history=$4,feedback=$5,version=version+1 WHERE id=$1 RETURNING *",
        [
          row.id,
          JSON.stringify(row.pull_request),
          row.state,
          JSON.stringify(row.human_history),
          row.feedback,
        ],
      )
    ).rows[0];
    await event(tx, result, row.workspace_id, type);
    return toRun(result);
  }
  private snapshot(row: Row, snapshot: Snapshot) {
    const previous = row.pull_request!;
    const valid =
      previous.headSha === snapshot.headSha &&
      previous.checks === snapshot.checks &&
      snapshot.open &&
      !snapshot.draft &&
      !["failed", "pending"].includes(snapshot.checks);
    row.pull_request = {
      ...previous,
      ...snapshot,
      status: "ready",
      updatedAt: new Date().toISOString(),
      assessment: valid ? previous.assessment : undefined,
    };
    if (
      !row.pull_request.assessment ||
      row.pull_request.assessment.decision !== "approve"
    )
      row.state = "review_ready";
  }
  async publish(
    workspace: string,
    id: string,
    version: number,
    target: Target,
  ) {
    const initial = await this.db.transaction(async (tx) => {
      const row = await this.row(tx, workspace, id);
      this.enabled(target);
      if (row.pull_request) {
        if (
          ["repository", "base", "branch"].some(
            (key) =>
              row.pull_request![key as keyof Target] !==
              target[key as keyof Target],
          )
        )
          throw new HttpError(
            409,
            "PR_TARGET_LOCKED",
            "이 작업에는 이미 제출한 브랜치가 있습니다.",
          );
        // Same target is safely retried even after a lost response / restart.
        return row;
      }
      this.version(row, version);
      if (!row.human_workflow || row.state !== "review_ready")
        throw new HttpError(
          409,
          "INVALID_STATE",
          "결과 검토 단계에서 구현 브랜치를 제출하세요.",
        );
      row.pull_request = {
        ...target,
        submissionId: randomUUID(),
        status: "publishing",
        reviews: [],
      };
      await this.save(tx, row, "pr_publishing");
      return row;
    });
    if (initial.pull_request?.number) return toRun(initial);
    let snapshot: Snapshot;
    try {
      snapshot = await this.provider!.publish(target, {
        id,
        prompt: initial.requirements,
      });
    } catch (error) {
      // Only definitive no-write failures release the target. Ambiguous failures
      // retain the reservation so retries reconcile the same remote PR.
      if (
        error instanceof HttpError &&
        ["NO_IMPLEMENTATION", "PR_ALREADY_EXISTS"].includes(error.code)
      ) {
        await this.db.transaction(async (tx) => {
          const row = await this.row(tx, workspace, id);
          if (
            row.pull_request?.status === "publishing" &&
            row.pull_request.submissionId === initial.pull_request?.submissionId
          ) {
            row.pull_request = null;
            await this.save(tx, row, "pr_submission_rejected");
          }
        });
      }
      throw error;
    }
    return this.db.transaction(async (tx) => {
      const row = await this.row(tx, workspace, id);
      if (row.pull_request?.submissionId !== initial.pull_request?.submissionId)
        throw new HttpError(
          409,
          "SUBMISSION_CHANGED",
          "PR 제출 대상이 변경됐습니다. 현재 제출 상태를 확인하세요.",
        );
      if (row.pull_request?.number) return toRun(row);
      this.snapshot(row, snapshot);
      return this.save(tx, row, "pr_published");
    });
  }
  private async inspect(
    workspace: string,
    id: string,
    version: number,
    initial: Row,
  ) {
    try {
      return await this.provider!.inspect(
        initial.pull_request!,
        initial.pull_request!.number!,
      );
    } catch (error) {
      if (error instanceof HttpError && error.code === "PR_TARGET_CHANGED") {
        await this.db.transaction(async (tx) => {
          const row = await this.row(tx, workspace, id);
          this.version(row, version);
          row.pull_request!.assessment = undefined;
          row.state = "review_ready";
          await this.save(tx, row, "pr_target_invalidated");
        });
      }
      throw error;
    }
  }
  async refresh(workspace: string, id: string, version: number) {
    const initial = await this.db.transaction(async (tx) => {
      const row = await this.row(tx, workspace, id);
      this.version(row, version);
      if (!row.pull_request?.number)
        throw new HttpError(
          409,
          "PR_REQUIRED",
          "먼저 실제 구현 브랜치를 PR로 제출하세요.",
        );
      this.enabled(row.pull_request);
      return row;
    });
    const snapshot = await this.inspect(workspace, id, version, initial);
    return this.db.transaction(async (tx) => {
      const row = await this.row(tx, workspace, id);
      this.version(row, version);
      this.snapshot(row, snapshot);
      return this.save(tx, row, "pr_refreshed");
    });
  }
  async assess(
    workspace: string,
    id: string,
    version: number,
    sha: string,
    decision: "approve" | "changes",
    text: string,
    key: string,
  ) {
    const value = text.trim();
    if (
      !["approve", "changes"].includes(decision) ||
      value.length < 10 ||
      value.length > 2000 ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(key)
    )
      throw new HttpError(
        422,
        "INVALID_INPUT",
        "평가 의견을 10~2,000자로 입력하세요.",
      );
    const requestHash = hashPlan({ version, sha, decision, text: value });
    const initial = await this.db.transaction(async (tx) => {
      const row = await this.row(tx, workspace, id);
      const previous = (
        await tx.query(
          "SELECT request_hash FROM human_responses WHERE work_id=$1 AND request_key=$2",
          [id, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "요청 키를 다른 평가에 사용할 수 없습니다.",
          );
        return { row, replayed: true };
      }
      this.version(row, version);
      if (row.state !== "review_ready" || !row.pull_request?.number)
        throw new HttpError(
          409,
          "INVALID_STATE",
          "검토 대기 중인 PR만 평가할 수 있습니다.",
        );
      this.enabled(row.pull_request);
      if (row.pull_request.reviews.length >= 100)
        throw new HttpError(
          429,
          "REVIEW_LIMIT",
          "평가 기록 한도에 도달했습니다.",
        );
      return { row, replayed: false };
    });
    if (initial.replayed) return toRun(initial.row);
    // Re-read GitHub on each evaluation; a browser snapshot never grants approval.
    const snapshot = await this.inspect(workspace, id, version, initial.row);
    const result = await this.db.transaction(async (tx) => {
      const row = await this.row(tx, workspace, id);
      const previous = (
        await tx.query(
          "SELECT request_hash FROM human_responses WHERE work_id=$1 AND request_key=$2",
          [id, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "요청 키를 다른 평가에 사용할 수 없습니다.",
          );
        return { run: toRun(row), invalid: false };
      }
      this.version(row, version);
      this.snapshot(row, snapshot);
      if (
        snapshot.headSha !== sha ||
        !snapshot.open ||
        snapshot.draft ||
        (decision === "approve" &&
          ["failed", "pending"].includes(snapshot.checks))
      ) {
        const run = await this.save(tx, row, "pr_review_invalidated");
        return { run, invalid: true };
      }
      const assessment = {
        decision,
        headSha: sha,
        text: value,
        actor: "owner",
        at: new Date().toISOString(),
      };
      row.pull_request!.assessment = assessment;
      row.pull_request!.reviews.push(assessment);
      row.human_history.push({
        action: decision === "approve" ? "approve_pr" : "request_pr_changes",
        text: `${sha}: ${value}`,
        at: assessment.at,
      });
      row.state = decision === "approve" ? "completed" : "review_ready";
      if (decision === "changes") row.feedback = value;
      const run = await this.save(tx, row, "pr_assessed");
      await tx.query(
        "INSERT INTO human_responses (work_id,request_key,request_hash,actor) VALUES ($1,$2,$3,$4)",
        [id, key, requestHash, "owner"],
      );
      return { run, invalid: false };
    });
    if (result.invalid)
      throw new HttpError(
        409,
        "PR_CHANGED",
        "PR 커밋·공개 상태·CI가 변경됐거나 승인 조건을 충족하지 못했습니다. 최신 결과를 다시 검토하세요.",
      );
    return result.run;
  }
}
