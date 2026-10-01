import { useCallback, useEffect, useMemo, useState } from "react";
import type { Run } from "./factory";
import {
  ApiRepository,
  DemoRepository,
  type Mode,
  type WorkRepository,
} from "./repositories";

export function useFactory(mode: Mode, selectedId: string | null) {
  const repository = useMemo<WorkRepository>(() => {
    if (mode === "api") return new ApiRepository();
    let storage: Storage | null = null;
    try {
      storage = localStorage;
    } catch {
      /* Repository reports unavailable storage. */
    }
    return new DemoRepository(storage);
  }, [mode]);
  const [snapshot, setSnapshot] = useState<{
    repository: typeof repository;
    runs: Run[];
  }>({ repository, runs: [] });
  const [issue, setIssue] = useState("");
  const [loading, setLoading] = useState(true);
  const runs = snapshot.repository === repository ? snapshot.runs : [];

  useEffect(() => {
    let alive = true;
    let busy = false;
    setIssue("");
    setLoading(true);
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await repository.list();
        if (alive) {
          if (repository.mode === "api") setIssue("");
          setSnapshot((current) => ({
            repository,
            runs: [
              ...next.map((item) => {
                const prior =
                  current.repository === repository
                    ? current.runs.find((run) => run.id === item.id)
                    : undefined;
                return (prior?.version ?? 0) > (item.version ?? 0)
                  ? prior!
                  : item;
              }),
              ...(current.repository === repository
                ? current.runs.filter(
                    (item) => !next.some((run) => run.id === item.id),
                  )
                : []),
            ]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, repository.mode === "demo" ? 20 : 100),
          }));
        }
      } catch (error) {
        if (alive)
          setIssue(
            error instanceof Error
              ? error.message
              : "작업을 불러오지 못했습니다.",
          );
      } finally {
        busy = false;
        if (alive) setLoading(false);
      }
    };
    void refresh();
    const unsubscribe = repository.subscribe(
      () => {
        void refresh();
      },
      (message) => {
        if (alive) setIssue(message);
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [repository]);

  const upsert = useCallback(
    (run: Run) =>
      setSnapshot((current) => {
        const existing = current.repository === repository ? current.runs : [];
        const previous = existing.find((item) => item.id === run.id);
        if (previous && (previous.version ?? 0) > (run.version ?? 0))
          return current;
        return {
          repository,
          runs: previous
            ? existing.map((item) => (item.id === run.id ? run : item))
            : [run, ...existing],
        };
      }),
    [repository],
  );

  useEffect(() => {
    if (!selectedId || loading || !repository.watch) return;
    return repository.watch(selectedId, upsert, setIssue);
  }, [repository, selectedId, loading, upsert]);

  return {
    runs,
    issue,
    loading,
    maxLength: repository.maxLength,
    create: async (prompt: string, key: string) => {
      const run = await repository.create(prompt, key);
      upsert(run);
      return run;
    },
    cancel: async (run: Run) => {
      const next = await repository.cancel(run);
      upsert(next);
    },
    approve: async (run: Run) => {
      if (!repository.approve)
        throw new Error("로컬 데모는 실행 승인을 지원하지 않습니다.");
      const next = await repository.approve(run);
      upsert(next);
    },
  };
}
