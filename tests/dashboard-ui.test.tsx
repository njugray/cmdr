// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, CommanderMessage, QuestionCard, type Draft } from '../src/dashboard/app.js';
import { refreshQueue } from '../src/dashboard/refresh.js';
import type { Question, SquadSummary } from '../src/shared/dashboard.js';

vi.hoisted(() => {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-CN'] });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const q: Question = {
  id: 'question:one',
  squad_id: 'squad-one',
  question: 'Choose scope',
  description: 'First description',
  kind: 'single',
  options: [
    { id: 'a', label: 'Small' },
    { id: 'b', label: 'Large' },
  ],
  artifact_ids: ['art'],
  version: 1,
  status: 'pending',
  created_at: 1,
  updated_at: 1,
};
const artifact = {
  id: 'art',
  squad_id: q.squad_id,
  title: 'Plan',
  version: 1,
  created_at: 1,
  updated_at: 1,
};
function Harness({ question = q, version = 1 }: { question?: Question; version?: number }) {
  const [draft, change] = useState<Draft>({ selected: [], text: '', version: q.version });
  return (
    <QuestionCard
      q={question}
      draft={draft}
      change={change}
      artifacts={[{ ...artifact, version }]}
    />
  );
}

it('keeps DOM, focus, choices and iframe identity through ordinary updates and requires review on version changes', async () => {
  await act(() => root.render(<Harness />));
  const input = container.querySelector('input')!;
  const textarea = container.querySelector('textarea')!;
  const iframe = container.querySelector('iframe')!;
  await act(() => input.click());
  textarea.focus();
  await act(() => root.render(<Harness question={{ ...q, updated_at: 2 }} />));
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(container.querySelector('iframe')).toBe(iframe);
  expect(input.checked).toBe(true);
  await act(() =>
    root.render(
      <Harness question={{ ...q, version: 2, description: 'Changed decision' }} version={2} />,
    ),
  );
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(input.checked).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(true);
  expect(container.textContent).toContain('输入已保留');
  expect(container.querySelector('iframe')).toBe(iframe);
  expect(iframe.getAttribute('src')).toContain('/2');
});

it('retries the same immutable submission after a lost HTTP response', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ received_at: 2 }) });
  vi.stubGlobal('fetch', fetcher);
  await act(() => root.render(<Harness />));
  await act(() => container.querySelector('input')!.click());
  await act(() =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('fieldset')!.disabled).toBe(true);
  expect(container.textContent).toContain('重试提交');
  await act(() =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
});

it('uses one SSE stream for multiple squads and preserves drafts across navigation', async () => {
  const streams: any[] = [];
  class Source {
    onopen?: () => void;
    onmessage?: (e: any) => void;
    onerror?: () => void;
    close = vi.fn();
    constructor() {
      streams.push(this);
    }
  }
  vi.stubGlobal('EventSource', Source);
  const squads = [
    {
      id: q.squad_id,
      name: 'Alpha',
      status: 'active',
      active_tasks: 0,
      task_count: 0,
      pending_questions: 1,
    },
    {
      id: 'squad-two',
      name: 'Beta',
      status: 'active',
      active_tasks: 0,
      task_count: 0,
      pending_questions: 0,
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => ({
      ok: true,
      json: async () =>
        path === '/api/state'
          ? { home: '/test', version: 'test', squads }
          : path.startsWith('/api/tasks/')
            ? { task: { id: 'task:one', runs: [] }, next: null }
            : {
                squad: squads.find((s) => path.endsWith(s.id)),
                tasks: [
                  {
                    id: 'task:one',
                    title: 'Build board',
                    archived: false,
                    position: 0,
                    state: 'planned',
                    description: '',
                    acceptance: '',
                    artifact_ids: [],
                    runs: [],
                    created_at: 1,
                    updated_at: 1,
                  },
                ],
                questions: path.endsWith(q.squad_id) ? [q] : [],
                artifacts: [],
                members: [],
                activity: [],
              },
    })),
  );
  await act(async () => root.render(<App />));
  await act(() => streams[0].onopen());
  await act(() => container.querySelector<HTMLInputElement>('.question-card input')!.click());
  await act(() => container.querySelectorAll<HTMLButtonElement>('.squad-link')[1].click());
  expect(container.textContent).not.toContain('Choose scope');
  await act(() => container.querySelectorAll<HTMLButtonElement>('.squad-link')[0].click());
  expect(container.querySelector<HTMLInputElement>('.question-card input')!.checked).toBe(true);
  const questionInput = container.querySelector<HTMLInputElement>('.question-card input')!;
  await act(() => container.querySelector<HTMLButtonElement>('.task-card')!.click());
  expect(container.querySelector('[aria-label="任务详情"]')).not.toBeNull();
  expect(container.querySelector('.question-card input')).toBe(questionInput);
  expect(questionInput.checked).toBe(true);
  await act(() => container.querySelector<HTMLButtonElement>('#tab-activity')!.click());
  expect(container.querySelector('#panel-activity')).not.toBeNull();
  expect(container.querySelector('.question-card input')).toBe(questionInput);
  await act(() => streams[0].onmessage({ data: JSON.stringify({ squads: [q.squad_id] }) }));
  expect(container.querySelector('.question-card input')).toBe(questionInput);
  expect(streams).toHaveLength(1);
});

it('re-reads after an in-flight invalidation and retries failed reads without another event', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const error = vi.fn();
  const queue = refreshQueue(read, error, 10);
  queue.invalidate();
  queue.invalidate();
  queue.invalidate();
  expect(read).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10);
  expect(read).toHaveBeenCalledTimes(3);
  queue.close();
});

it('keeps a commander message immutable through retry and clears it only after receipt', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ received_at: 2, message_id: 'm_one' }),
    });
  vi.stubGlobal('fetch', fetcher);
  function MessageHarness() {
    const [draft, change] = useState({ text: 'Prioritize regression' });
    return (
      <CommanderMessage
        squad={{ id: 'one', status: 'active' } as SquadSummary}
        draft={draft}
        change={change}
      />
    );
  }
  await act(() => root.render(<MessageHarness />));
  const submit = () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await act(() => {
    submit();
  });
  expect(container.querySelector('input')!.disabled).toBe(true);
  expect(container.querySelector('input')!.value).toBe('Prioritize regression');
  expect(container.textContent).toContain('重试发送');
  await act(() => {
    submit();
  });
  expect(fetcher.mock.calls[0][0]).toBe('/api/messages');
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  expect(container.querySelector('input')!.value).toBe('');
  expect(container.querySelector('input')!.disabled).toBe(false);
  expect(container.textContent).toContain('等待指挥官读取');
});
