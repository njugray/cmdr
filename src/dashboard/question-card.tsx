import { useState } from 'react';
import type { AnswerInput, ArtifactSummary, Question, Submission } from '../shared/dashboard.js';
import { t as text, locale } from './i18n.js';
import { api, ApiError } from './api.js';
import { enc, time, shortId, errorText, questionLabels } from './display.js';
import { ArtifactView } from './artifact-view.js';

export interface Draft {
  selected: string[];
  text: string;
  confirmed?: boolean;
  version: number;
  attempt?: AnswerInput;
  sending?: boolean;
  error?: string;
}
export const emptyDraft = (q: Question): Draft => ({ selected: [], text: '', version: q.version });

export function QuestionCard({
  q,
  draft,
  change,
  artifacts,
  taskTitle,
  openTask,
}: {
  q: Question;
  draft: Draft;
  change: (update: (d: Draft) => Draft) => void;
  artifacts: ArtifactSummary[];
  taskTitle?: string;
  openTask?: () => void;
}) {
  const [expanded, setExpanded] = useState(q.status === 'pending');
  const [evidence, setEvidence] = useState<
    Omit<Submission, 'snapshot'> & {
      snapshot: { question: Question; artifacts: ArtifactSummary[] };
    }
  >();
  const [evidenceError, setEvidenceError] = useState('');
  const changed = draft.version !== q.version;
  const locked = !!draft.sending || !!draft.attempt;
  const selectedValid = draft.selected.every((id) => q.options.some((o) => o.id === id));
  const valid =
    selectedValid &&
    (q.kind === 'text'
      ? !!draft.text.trim()
      : q.kind === 'confirm'
        ? draft.confirmed !== undefined
        : q.kind === 'single'
          ? draft.selected.length === 1
          : draft.selected.length > 0);
  async function submit() {
    if (draft.sending || changed || (!draft.attempt && !valid)) return;
    const attempt = draft.attempt || {
      question_id: q.id,
      version: draft.version,
      submission_id: crypto.randomUUID(),
      selected: draft.selected,
      text: draft.text,
      ...(draft.confirmed === undefined ? {} : { confirmed: draft.confirmed }),
    };
    change((d) => ({ ...d, attempt, sending: true, error: undefined }));
    try {
      await api('/api/answers', attempt);
      change((d) => ({ ...d, sending: false, error: text('答复已接收，正在同步处理状态。') }));
    } catch (e) {
      const definitive =
        e instanceof ApiError &&
        ['VERSION_CONFLICT', 'QUESTION_CLOSED', 'INVALID_ARGUMENT', 'SUBMISSION_CONFLICT'].includes(
          e.code,
        );
      change((d) => ({
        ...d,
        sending: false,
        attempt: definitive ? undefined : attempt,
        error:
          e instanceof ApiError && e.code === 'VERSION_CONFLICT'
            ? text('问题已更新。输入已保留，请核对新内容后再提交。')
            : `${errorText(e)}${definitive ? '' : ' ' + text('可以重试同一次提交。')}`,
      }));
    }
  }
  return (
    <article className={`question-card ${q.status}`}>
      {q.status !== 'pending' && !expanded && (
        <button
          className="question-summary"
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
        >
          <span className={`question-dot ${q.status}`} />
          <span className="summary-copy">
            <strong>{q.question}</strong>
            <small>
              {questionLabels[q.status]}
              {q.result ? ` · ${q.result}` : ''}
            </small>
          </span>
          <time>{time(q.created_at)}</time>
        </button>
      )}
      <div className="question-content" hidden={q.status !== 'pending' && !expanded}>
        <div className="card-eyebrow">
          <span className="mono" title={q.id}>
            Q-{shortId(q.id)} · {time(q.created_at)}
          </span>
          <span className={`question-state ${q.status}`}>{questionLabels[q.status]}</span>
        </div>
        <h3>{q.question}</h3>
        {q.description && <p className="preserve description">{q.description}</p>}
        <div className="question-reference">
          {taskTitle && (
            <>
              {text('关联任务')}{' '}
              <button type="button" className="subtle" onClick={openTask}>
                {taskTitle}
              </button>
              <span>·</span>
            </>
          )}
          <span>
            {text('内容版本 v')}
            {q.version}
          </span>
          {q.status !== 'pending' && (
            <button
              className="subtle collapse-question"
              type="button"
              onClick={() => setExpanded(false)}
              aria-expanded={true}
            >
              {text('收起')}
            </button>
          )}
        </div>
        {q.status === 'pending' && artifacts.map((a) => <ArtifactView key={a.id} artifact={a} />)}
        {q.status === 'pending' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {changed && (
              <div className="notice">
                <p>{text('问题或补充说明已更新。你的输入已保留，请核对新内容。')}</p>
                <button
                  type="button"
                  disabled={!!draft.sending}
                  onClick={() =>
                    change((d) => ({
                      ...d,
                      version: q.version,
                      attempt: undefined,
                      selected: d.selected.filter((id) => q.options.some((o) => o.id === id)),
                      confirmed: q.kind === 'confirm' ? d.confirmed : undefined,
                      error: undefined,
                    }))
                  }
                >
                  {text('已核对新内容')}
                </button>
              </div>
            )}
            <fieldset disabled={locked}>
              <legend>
                {q.kind === 'multiple'
                  ? text('选择所有适用项')
                  : q.kind === 'single'
                    ? text('选择一项')
                    : q.kind === 'confirm'
                      ? text('请确认')
                      : text('你的答复')}
              </legend>
              {['single', 'multiple'].includes(q.kind) && (
                <div className="options">
                  {q.options.map((o) => (
                    <label
                      key={o.id}
                      className={draft.selected.includes(o.id) ? 'option chosen' : 'option'}
                    >
                      <input
                        type={q.kind === 'single' ? 'radio' : 'checkbox'}
                        name={q.id}
                        value={o.id}
                        checked={draft.selected.includes(o.id)}
                        onChange={() =>
                          change((d) => ({
                            ...d,
                            selected:
                              q.kind === 'single'
                                ? [o.id]
                                : d.selected.includes(o.id)
                                  ? d.selected.filter((x) => x !== o.id)
                                  : [...d.selected, o.id],
                          }))
                        }
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              {q.kind === 'confirm' && (
                <div className="options">
                  {[true, false].map((value) => (
                    <label
                      key={String(value)}
                      className={draft.confirmed === value ? 'option chosen' : 'option'}
                    >
                      <input
                        type="radio"
                        name={q.id}
                        checked={draft.confirmed === value}
                        onChange={() => change((d) => ({ ...d, confirmed: value }))}
                      />
                      {value ? text('确认') : text('拒绝')}
                    </label>
                  ))}
                </div>
              )}
              <label className="input-label" htmlFor={`${q.id}-text`}>
                {q.kind === 'text' ? text('填写答复') : text('补充说明（选填）')}
              </label>
              <textarea
                id={`${q.id}-text`}
                maxLength={8000}
                rows={3}
                value={draft.text}
                onChange={(e) => {
                  const text = e.target.value;
                  change((d) => ({ ...d, text }));
                }}
                placeholder={text('写下你的意见…')}
              />
            </fieldset>
            <div className="form-footer">
              <span className="muted">{text('草稿已保留，仅在点击提交后发送')}</span>
              <button
                className="primary"
                disabled={!!draft.sending || changed || (!draft.attempt && !valid)}
              >
                {draft.sending
                  ? text('正在提交…')
                  : draft.attempt
                    ? text('重试提交')
                    : text('提交答复')}
              </button>
            </div>
            {draft.error && (
              <p role="status" className="notice">
                {draft.error}
              </p>
            )}
          </form>
        )}
        {q.answer && (
          <div className="answer-receipt">
            <b>{text('你的答复')}</b>
            <p className="preserve">
              {q.options
                .filter((o) => q.answer!.selected.includes(o.id))
                .map((o) => o.label)
                .join(locale === 'zh-CN' ? '、' : ', ')}
              {q.answer.confirmed === undefined
                ? ''
                : q.answer.confirmed
                  ? text('确认')
                  : text('拒绝')}
              {q.answer.text && `\n${q.answer.text}`}
            </p>
            <span className="muted">
              {text('接收于')} {time(q.answer.received_at)}
            </span>
            <details
              onToggle={(e) => {
                if (e.currentTarget.open && !evidence)
                  void api<typeof evidence>(`/api/submissions/${enc(q.answer!.submission_id)}`)
                    .then(setEvidence)
                    .catch((error) => setEvidenceError(errorText(error)));
              }}
            >
              <summary>{text('查看提交时的说明')}</summary>
              {evidence ? (
                <>
                  <p className="preserve">
                    {evidence.snapshot.question.description || text('没有补充文字说明。')}
                  </p>
                  {evidence.snapshot.artifacts.map((a) => (
                    <ArtifactView key={a.id} artifact={a} submission={q.answer!.submission_id} />
                  ))}
                </>
              ) : (
                <p>{evidenceError || text('正在读取…')}</p>
              )}
            </details>
          </div>
        )}
        {q.result && (
          <div className="handled-result">
            <b>{text('处理说明')}</b>
            <p className="preserve">{q.result}</p>
            <time>
              {text('处理时间')} {time(q.updated_at)}
            </time>
          </div>
        )}
      </div>
    </article>
  );
}
