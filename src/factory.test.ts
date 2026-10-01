import { describe, expect, it } from 'vitest';
import { advanceRun, createRun, readRuns, stages } from './factory';

describe('demo workflow', () => {
  it('rejects invalid input and trims requirements', () => {
    expect(() => createRun(' ')).toThrow();
    expect(() => createRun('a'.repeat(2001))).toThrow();
    expect(createRun('  팀의 할 일을 관리하는 앱을 만들어 주세요  ').prompt).toBe('팀의 할 일을 관리하는 앱을 만들어 주세요');
  });
  it('finishes at review and never advances a cancelled run', () => {
    let run = createRun('팀의 할 일을 관리하는 앱을 만들어 주세요');
    for (let i = 0; i < 10; i++) run = advanceRun(run);
    expect(run.status).toBe('review');
    expect(run.stage).toBe(stages.length - 1);
    const cancelled = { ...run, status: 'cancelled' as const };
    expect(advanceRun(cancelled)).toBe(cancelled);
  });
  it('recovers from malformed storage and rejects invalid records', () => {
    expect(readRuns('{')).toEqual([]);
    expect(readRuns('{}')).toEqual([]);
    const run = createRun('팀의 할 일을 관리하는 앱을 만들어 주세요');
    expect(readRuns(JSON.stringify([run, { ...run, stage: 99 }, { ...run, createdAt: 'invalid' }]))).toEqual([run]);
  });
});
