// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionCard } from '../src/dashboard/question-card.js';
import { locale, resolveLanguage } from '../src/dashboard/i18n.js';

vi.hoisted(() => {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US', 'zh-CN'] });
});

it('uses the preferred system/browser language, with English fallback', () => {
  expect(locale).toBe('en');
  expect(resolveLanguage(['zh-CN', 'en'])).toBe('zh-CN');
  expect(resolveLanguage(['zh-TW'])).toBe('zh-CN');
  expect(resolveLanguage(['ZH-hk'])).toBe('zh-CN');
  expect(resolveLanguage(['en-GB', 'zh-CN'])).toBe('en');
  expect(resolveLanguage(['fr-FR', 'zh-CN'])).toBe('en');
  expect(resolveLanguage([])).toBe('en');
});

it('renders English controls without translating agent content or HTML artifacts', () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      q={{
        id: 'question:one',
        squad_id: 'one',
        question: '确认',
        description: '任务说明',
        kind: 'single',
        options: [{ id: 'a', label: '执行中' }],
        artifact_ids: ['a'],
        version: 1,
        status: 'pending',
        created_at: 1,
        updated_at: 1,
      }}
      draft={{ selected: [], text: '用户草稿', version: 1 }}
      change={() => {}}
      artifacts={[
        { id: 'a', squad_id: 'one', title: '展示内容', version: 1, created_at: 1, updated_at: 1 },
      ]}
    />,
  );
  const container = document.createElement('div');
  container.innerHTML = html;
  expect(container.querySelector('h3')?.textContent).toBe('确认');
  expect(container.querySelector('.description')?.textContent).toBe('任务说明');
  expect(container.querySelector('.option')?.textContent).toBe('执行中');
  expect(container.querySelector('textarea')?.value).toBe('用户草稿');
  expect(container.querySelector('textarea')?.placeholder).toBe('Share your thoughts…');
  expect(container.querySelector('legend')?.textContent).toBe('Select one');
  expect(container.querySelector('.primary')?.textContent).toBe('Submit answer');
  expect(container.querySelector('iframe')?.title).toBe('展示内容');
  expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/artifacts/a/1');
});
