import {
  advanceRun,
  createRun,
  readRuns,
  storageKey,
  type Run,
  type AgentStatus,
  type PublisherStatus,
} from "./factory";

export type Mode = "demo" | "api";
export interface WorkRepository {
  mode: Mode;
  maxLength: number;
  list(): Promise<Run[]>;
  create(prompt: string, key: string): Promise<Run>;
  cancel(run: Run): Promise<Run>;
  approve?(run: Run): Promise<Run>;
  agentStatus?(): Promise<AgentStatus>;
  publisherStatus?(): Promise<PublisherStatus>;
  publishPr?(
    run: Run,
    target: { repository: string; base: string; branch: string },
  ): Promise<Run>;
  refreshPr?(run: Run): Promise<Run>;
  assessPr?(
    run: Run,
    decision: string,
    text: string,
    key: string,
  ): Promise<Run>;
  generate?(run: Run, phase: string, key: string): Promise<Run>;
  cancelAgent?(run: Run): Promise<Run>;
  respond?(run: Run, action: string, text: string, key: string): Promise<Run>;
  subscribe(refresh: () => void, issue: (message: string) => void): () => void;
  watch?(
    id: string,
    receive: (run: Run) => void,
    issue: (message: string) => void,
  ): () => void;
}

export class DemoRepository implements WorkRepository {
  mode = "demo" as const;
  maxLength = 2000;
  private runs: Run[];
  private listeners = new Set<() => void>();
  private issues = new Set<(message: string) => void>();
  private storageFailed = false;
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null) {
    try {
      this.runs = readRuns(storage?.getItem(storageKey) ?? null);
    } catch {
      this.runs = [];
      this.storageFailed = true;
    }
  }
  async list() {
    return this.runs;
  }
  private emit() {
    try {
      if (!this.storage) throw new Error();
      this.storage.setItem(storageKey, JSON.stringify(this.runs));
      this.storageFailed = false;
    } catch {
      this.storageFailed = true;
      this.issues.forEach((issue) =>
        issue(
          "브라우저 저장 공간을 사용할 수 없습니다. 새로고침하면 기록이 사라질 수 있습니다.",
        ),
      );
    }
    this.listeners.forEach((listener) => listener());
  }
  async create(prompt: string, _key: string) {
    const run = createRun(prompt);
    if (this.runs.filter((item) => item.status === "running").length >= 3)
      throw new Error("동시에 진행할 수 있는 데모 작업은 3개입니다.");
    this.runs = [run, ...this.runs].slice(0, 20);
    this.emit();
    return run;
  }
  async cancel(run: Run) {
    const current = this.runs.find((item) => item.id === run.id);
    if (!current || current.status !== "running")
      throw new Error("취소할 수 없는 작업입니다.");
    const cancelled = { ...current, status: "cancelled" as const };
    this.runs = this.runs.map((item) =>
      item.id === run.id ? cancelled : item,
    );
    this.emit();
    return cancelled;
  }
  subscribe(refresh: () => void, issue: (message: string) => void) {
    this.listeners.add(refresh);
    this.issues.add(issue);
    if (this.storageFailed) issue("브라우저 저장 공간을 사용할 수 없습니다.");
    const timer = window.setInterval(() => {
      if (!this.runs.some((run) => run.status === "running")) return;
      this.runs = this.runs.map(advanceRun);
      this.emit();
    }, 1800);
    return () => {
      clearInterval(timer);
      this.listeners.delete(refresh);
      this.issues.delete(issue);
    };
  }
}

export class ApiRepository implements WorkRepository {
  mode = "api" as const;
  maxLength = 10000;
  private ready?: Promise<void>;
  private project?: string;
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-arkwork-request": "browser",
        ...init.headers,
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) {
        this.ready = undefined;
        this.project = undefined;
      }
      throw new Error(
        data?.message ??
          "API에 연결하지 못했습니다. 개발 서버 실행을 확인해 주세요.",
      );
    }
    return data as T;
  }
  private connect() {
    if (!this.ready)
      this.ready = (async () => {
        // This explicitly opt-in local identity is not a production login.
        await this.request("/v1/dev/session", {
          method: "POST",
          body: JSON.stringify({ identity: "owner" }),
        });
        const result = await this.request<{ projects: { id: string }[] }>(
          "/v1/projects",
        );
        this.project = result.projects[0]?.id;
        if (!this.project) throw new Error("개발 프로젝트가 없습니다.");
      })().catch((error) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
  async list() {
    await this.connect();
    return (await this.request<{ runs: Run[] }>("/v1/work-items")).runs;
  }
  async create(prompt: string, key: string) {
    const value = prompt.trim();
    if (value.length < 10 || value.length > 10000)
      throw new Error("요구사항을 10~10,000자로 입력해 주세요.");
    await this.connect();
    return (
      await this.request<{ run: Run }>(
        `/v1/projects/${this.project}/work-items`,
        {
          method: "POST",
          headers: { "idempotency-key": key },
          body: JSON.stringify({ requirements: value }),
        },
      )
    ).run;
  }
  async cancel(run: Run) {
    await this.connect();
    return this.request<Run>(`/v1/work-items/${run.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ expected_version: run.version }),
    });
  }
  async approve(run: Run) {
    await this.connect();
    const result = await this.request<{ run: Run }>(
      `/v1/work-items/${run.id}/approvals`,
      {
        method: "POST",
        body: JSON.stringify({
          expected_version: run.version,
          plan_hash: run.planHash,
          policy_version: run.policyVersion,
        }),
      },
    );
    return result.run;
  }
  async publisherStatus() {
    await this.connect();
    return this.request<PublisherStatus>("/v1/publisher");
  }
  async publishPr(
    run: Run,
    target: { repository: string; base: string; branch: string },
  ) {
    await this.connect();
    return this.request<Run>(`/v1/work-items/${run.id}/pull-request`, {
      method: "POST",
      body: JSON.stringify({ expected_version: run.version, ...target }),
    });
  }
  async refreshPr(run: Run) {
    await this.connect();
    return this.request<Run>(`/v1/work-items/${run.id}/pull-request/refresh`, {
      method: "POST",
      body: JSON.stringify({ expected_version: run.version }),
    });
  }
  async assessPr(run: Run, decision: string, text: string, key: string) {
    await this.connect();
    return this.request<Run>(`/v1/work-items/${run.id}/pull-request/reviews`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: run.version,
        head_sha: run.pullRequest?.headSha,
        decision,
        text,
        request_key: key,
      }),
    });
  }
  async agentStatus() {
    await this.connect();
    return this.request<AgentStatus>("/v1/agent");
  }
  async generate(run: Run, phase: string, key: string) {
    await this.connect();
    return (
      await this.request<{ run: Run }>(`/v1/work-items/${run.id}/codex`, {
        method: "POST",
        body: JSON.stringify({
          expected_version: run.version,
          phase,
          request_key: key,
        }),
      })
    ).run;
  }
  async cancelAgent(run: Run) {
    await this.connect();
    return this.request<Run>(`/v1/work-items/${run.id}/codex/cancel`, {
      method: "POST",
      body: "{}",
    });
  }
  async respond(run: Run, action: string, text: string, key: string) {
    await this.connect();
    return (
      await this.request<{ run: Run }>(`/v1/work-items/${run.id}/responses`, {
        method: "POST",
        body: JSON.stringify({
          expected_version: run.version,
          action,
          text,
          request_key: key,
        }),
      })
    ).run;
  }
  subscribe(refresh: () => void, _issue: (message: string) => void) {
    const timer = window.setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }
  watch(
    id: string,
    receive: (run: Run) => void,
    issue: (message: string) => void,
  ) {
    const source = new EventSource(`/v1/work-items/${id}/events`);
    source.addEventListener("work", (event) => {
      try {
        receive(JSON.parse((event as MessageEvent).data) as Run);
      } catch {
        issue("서버 이벤트를 읽지 못했습니다.");
      }
    });
    source.onopen = () => issue("");
    source.onerror = () =>
      issue(
        "진행 연결을 복구하고 있습니다. 작업 목록은 주기적으로 다시 확인합니다.",
      );
    return () => source.close();
  }
}
