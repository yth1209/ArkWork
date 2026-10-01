import Fastify from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./database";
import { AgentService } from "./agent";
import type { AgentProvider } from "./codex";
import { HttpError, Store } from "./store";

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const uuid = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
};
const params = {
  type: "object",
  properties: { id: uuid },
  required: ["id"],
  additionalProperties: false,
};

export function buildApp(
  db: Database,
  options: {
    devAuth: boolean;
    origin?: string;
    intervalMs?: number;
    cookieSecure?: boolean;
    agent?: AgentProvider;
  },
) {
  if (!options.devAuth)
    throw new Error(
      "현재 API는 로컬 개발용입니다. ARKWORK_DEV_AUTH=1로 명시적으로 활성화하세요.",
    );
  const app = Fastify({
    logger: false,
    bodyLimit: 32_000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const store = new Store(db, options.intervalMs);
  const agent = options.agent ? new AgentService(db, options.agent) : undefined;
  const origin = options.origin ?? "http://localhost:5173";
  const allowedHosts = new Set(["localhost", "127.0.0.1"]);
  const sessions = new WeakMap<
    object,
    { workspace: string; expiresAt: number; tokenHash: string }
  >();
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => {
    await agent?.close();
    for (const close of streams) close();
    streams.clear();
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof HttpError ? error : null;
    const validation =
      error !== null &&
      typeof error === "object" &&
      "validation" in error &&
      error.validation;
    const status = failure?.status ?? (validation ? 422 : 500);
    if (status >= 500)
      console.error(
        "API request failed",
        request.id,
        error instanceof Error ? error.name : "unknown",
      );
    reply.status(status).send({
      code: failure?.code ?? (validation ? "INVALID_INPUT" : "INTERNAL_ERROR"),
      message:
        failure?.message ??
        (validation
          ? "입력 형식과 길이를 확인해 주세요."
          : "요청을 처리하지 못했습니다."),
      retryable: status >= 500 || status === 429,
      request_id: request.id,
    });
  });

  app.addHook("onRequest", async (request) => {
    if (!allowedHosts.has(request.hostname))
      throw new HttpError(403, "LOCAL_ONLY", "로컬 개발 API만 지원합니다.");
    if (request.headers.origin && request.headers.origin !== origin)
      throw new HttpError(
        403,
        "ORIGIN_REJECTED",
        "허용되지 않은 요청 출처입니다.",
      );
    if (
      request.method !== "GET" &&
      request.headers["x-arkwork-request"] !== "browser"
    )
      throw new HttpError(
        403,
        "REQUEST_HEADER_REQUIRED",
        "요청 보호 헤더가 필요합니다.",
      );
    if (
      request.url.split("?")[0] === "/health" ||
      request.url.split("?")[0] === "/v1/dev/session"
    )
      return;
    const token = request.headers.cookie?.match(
      /(?:^|;\s*)arkwork_session=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    if (!token)
      throw new HttpError(401, "AUTH_REQUIRED", "개발 세션 연결이 필요합니다.");
    const { rows } = await db.query(
      "SELECT workspace_id,expires_at FROM sessions WHERE token_hash=$1 AND expires_at>now()",
      [hash(token)],
    );
    if (!rows[0])
      throw new HttpError(
        401,
        "AUTH_REQUIRED",
        "세션이 만료되었습니다. 다시 연결해 주세요.",
      );
    sessions.set(request, {
      workspace: String(rows[0].workspace_id),
      expiresAt: new Date(String(rows[0].expires_at)).getTime(),
      tokenHash: hash(token),
    });
  });
  const workspace = (request: object) => sessions.get(request)!.workspace;

  app.get("/health", async () => {
    await db.query("SELECT 1");
    return {
      ok: true,
      executionMode: "fixture",
      authMode: "local-development",
    };
  });

  app.post<{ Body: { identity: "owner" | "guest" } }>(
    "/v1/dev/session",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            identity: { type: "string", enum: ["owner", "guest"] },
          },
          required: ["identity"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const token = randomBytes(32).toString("hex");
      const session = await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO workspaces (id,identity) VALUES ($1,$2) ON CONFLICT(identity) DO NOTHING",
          [randomUUID(), request.body.identity],
        );
        const result = await tx.query(
          "SELECT id FROM workspaces WHERE identity=$1 FOR UPDATE",
          [request.body.identity],
        );
        const id = String(result.rows[0].id);
        if (
          !(
            await tx.query("SELECT id FROM projects WHERE workspace_id=$1", [
              id,
            ])
          ).rows.length
        )
          await tx.query(
            "INSERT INTO projects (id,workspace_id,name) VALUES ($1,$2,$3)",
            [randomUUID(), id, "개발 프로젝트"],
          );
        await tx.query("DELETE FROM sessions WHERE expires_at<=now()");
        await tx.query(
          "INSERT INTO sessions VALUES ($1,$2,now()+interval '12 hours')",
          [hash(token), id],
        );
        return {
          workspaceId: id,
          identity: request.body.identity,
          authMode: "local-development",
        };
      });
      reply.header(
        "set-cookie",
        `arkwork_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${options.cookieSecure ? "; Secure" : ""}`,
      );
      reply.header("cache-control", "no-store");
      return session;
    },
  );

  app.get("/v1/agent", async () =>
    agent
      ? agent.provider.status()
      : {
          enabled: false,
          authenticated: false,
          authMode: "chatgpt-subscription",
          message: "서버에서 Codex 연결을 아직 활성화하지 않았습니다.",
        },
  );
  app.post<{
    Params: { id: string };
    Body: {
      expected_version: number;
      phase: "questions" | "specification";
      request_key: string;
    };
  }>(
    "/v1/work-items/:id/codex",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            expected_version: { type: "integer", minimum: 1 },
            phase: { type: "string", enum: ["questions", "specification"] },
            request_key: { type: "string", pattern: "^[a-zA-Z0-9-]{8,100}$" },
          },
          required: ["expected_version", "phase", "request_key"],
        },
      },
    },
    async (request) => {
      if (!agent) {
        await store.get(workspace(request), request.params.id);
        throw new HttpError(
          409,
          "CODEX_DISABLED",
          "서버의 Codex 연결을 먼저 활성화하세요.",
        );
      }
      return agent.start(
        workspace(request),
        request.params.id,
        request.body.expected_version,
        request.body.phase,
        request.body.request_key,
      );
    },
  );
  app.post<{ Params: { id: string }; Body: Record<string, never> }>(
    "/v1/work-items/:id/codex/cancel",
    {
      schema: { params, body: { type: "object", additionalProperties: false } },
    },
    async (request) => {
      if (!agent) return store.get(workspace(request), request.params.id);
      return agent.cancel(workspace(request), request.params.id);
    },
  );

  app.get("/v1/session", async (request) => ({
    workspaceId: workspace(request),
    authMode: "local-development",
  }));
  app.post("/v1/logout", async (request, reply) => {
    const token = request.headers.cookie?.match(
      /arkwork_session=([a-f0-9]{64})/,
    )?.[1];
    if (token)
      await db.query("DELETE FROM sessions WHERE token_hash=$1", [hash(token)]);
    reply.header(
      "set-cookie",
      "arkwork_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { ok: true };
  });
  app.get("/v1/projects", async (request) => ({
    projects: await store.projects(workspace(request)),
  }));
  app.post<{ Body: { name: string } }>(
    "/v1/projects",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name)
        throw new HttpError(
          422,
          "INVALID_INPUT",
          "프로젝트 이름을 입력하세요.",
        );
      return reply
        .status(201)
        .send(await store.createProject(workspace(request), name));
    },
  );
  app.get("/v1/work-items", async (request) => ({
    runs: await store.list(workspace(request)),
    executionMode: "fixture",
  }));
  app.post<{ Params: { id: string }; Body: { requirements: string } }>(
    "/v1/projects/:id/work-items",
    {
      schema: {
        params,
        body: {
          type: "object",
          properties: {
            requirements: { type: "string", minLength: 10, maxLength: 10000 },
          },
          required: ["requirements"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(key))
        throw new HttpError(422, "INVALID_KEY", "유효한 요청 키가 필요합니다.");
      const requirements = request.body.requirements.trim();
      if (requirements.length < 10)
        throw new HttpError(
          422,
          "INVALID_INPUT",
          "요구사항을 10~10,000자로 입력하세요.",
        );
      const result = await store.create(
        workspace(request),
        request.params.id,
        requirements,
        key,
      );
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/work-items/:id",
    { schema: { params } },
    (request) => store.get(workspace(request), request.params.id),
  );
  app.post<{ Params: { id: string }; Body: { expected_version: number } }>(
    "/v1/work-items/:id/cancel",
    {
      schema: {
        params,
        body: {
          type: "object",
          properties: { expected_version: { type: "integer", minimum: 1 } },
          required: ["expected_version"],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const run = await store.cancel(
        workspace(request),
        request.params.id,
        request.body.expected_version,
      );
      return (
        (await agent?.cancel(workspace(request), request.params.id)) ?? run
      );
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      expected_version: number;
      plan_hash: string;
      policy_version: string;
    };
  }>(
    "/v1/work-items/:id/approvals",
    {
      schema: {
        params,
        body: {
          type: "object",
          properties: {
            expected_version: { type: "integer", minimum: 1 },
            plan_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            policy_version: { type: "string", minLength: 1, maxLength: 64 },
          },
          required: ["expected_version", "plan_hash", "policy_version"],
          additionalProperties: false,
        },
      },
    },
    (request) =>
      store.approve(
        workspace(request),
        request.params.id,
        request.body.expected_version,
        request.body.plan_hash,
        request.body.policy_version,
      ),
  );

  app.post<{
    Params: { id: string };
    Body: {
      expected_version: number;
      action: string;
      text: string;
      request_key: string;
    };
  }>(
    "/v1/work-items/:id/responses",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            expected_version: { type: "integer", minimum: 1 },
            action: {
              type: "string",
              enum: ["answer", "revise", "continue", "accept"],
            },
            text: { type: "string", maxLength: 2000 },
            request_key: { type: "string", pattern: "^[a-zA-Z0-9-]{8,100}$" },
          },
          required: ["expected_version", "action", "text", "request_key"],
        },
      },
    },
    (request) =>
      store.respond(
        workspace(request),
        request.params.id,
        request.body.expected_version,
        request.body.action,
        request.body.text,
        request.body.request_key,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: number } }>(
    "/v1/work-items/:id/events",
    {
      schema: {
        params,
        querystring: {
          type: "object",
          properties: { cursor: { type: "integer", minimum: 0 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const session = sessions.get(request)!;
      await store.get(session.workspace, id);
      const cursorInput =
        request.headers["last-event-id"] ?? String(request.query.cursor ?? 0);
      if (typeof cursorInput !== "string" || !/^\d{1,10}$/.test(cursorInput))
        throw new HttpError(
          422,
          "INVALID_CURSOR",
          "이벤트 위치가 올바르지 않습니다.",
        );
      let cursor = Number(cursorInput);
      let busy = false;
      let closed = false;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      const send = async () => {
        if (busy || closed) return;
        if (Date.now() >= session.expiresAt) {
          reply.raw.end();
          return;
        }
        busy = true;
        try {
          if (
            !(
              await db.query(
                "SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>now()",
                [session.tokenHash],
              )
            ).rows.length
          ) {
            reply.raw.end();
            return;
          }
          const events = await store.events(session.workspace, id, cursor);
          for (const item of events) {
            if (closed) break;
            cursor = Number(item.sequence);
            reply.raw.write(
              `id: ${cursor}\nevent: work\ndata: ${JSON.stringify(item.payload)}\n\n`,
            );
          }
        } catch {
          reply.raw.end();
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => {
        void send();
      }, 250);
      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(": heartbeat\n\n");
      }, 15000);
      const close = () => {
        cleanup();
        reply.raw.end();
      };
      const cleanup = () => {
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        streams.delete(close);
      };
      reply.raw.on("close", cleanup);
      streams.add(close);
      await send();
    },
  );
  return { app, store, agent };
}
