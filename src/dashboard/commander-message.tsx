import type { SquadSummary, UserMessageInput, UserMessageReceipt } from '../shared/dashboard.js';
import { t as text } from './i18n.js';
import { api, ApiError } from './api.js';
import { time, errorText } from './display.js';

export interface MessageDraft {
  text: string;
  attempt?: UserMessageInput;
  sending?: boolean;
  notice?: string;
}
export function CommanderMessage({
  squad,
  draft,
  change,
}: {
  squad: SquadSummary;
  draft: MessageDraft;
  change: (update: (d: MessageDraft) => MessageDraft) => void;
}) {
  async function submit() {
    if (draft.sending || !draft.text.trim() || squad.status === 'dissolved') return;
    const attempt = draft.attempt || {
      squad_id: squad.id,
      submission_id: crypto.randomUUID(),
      text: draft.text.trim(),
    };
    change((d) => ({ ...d, attempt, sending: true, notice: undefined }));
    try {
      const receipt = await api<UserMessageReceipt>('/api/messages', attempt);
      change(() => ({
        text: '',
        notice: `${text('已发送 ·')} ${time(receipt.received_at)}${text('，等待指挥官读取。')}`,
      }));
    } catch (e) {
      const definitive =
        e instanceof ApiError &&
        ['INVALID_ARGUMENT', 'SQUAD_NOT_FOUND', 'SUBMISSION_CONFLICT', 'QUEUE_FULL'].includes(
          e.code,
        );
      change((d) => ({
        ...d,
        sending: false,
        attempt: definitive ? undefined : attempt,
        notice: errorText(e),
      }));
    }
  }
  return (
    <form
      className="commander-message"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="commander-message">{text('向指挥官留言（不直接修改任务）')}</label>
      <div className="message-input-row">
        <input
          id="commander-message"
          value={draft.text}
          maxLength={8000}
          placeholder={text('例如：把异常场景回归提到最高优先级')}
          disabled={!!draft.attempt || squad.status === 'dissolved'}
          onChange={(e) => {
            const text = e.target.value;
            change((d) => ({ ...d, text, notice: undefined }));
          }}
        />
        <button disabled={!!draft.sending || !draft.text.trim() || squad.status === 'dissolved'}>
          {draft.sending ? text('发送中…') : draft.attempt ? text('重试发送') : text('发送')}
        </button>
      </div>
      {draft.notice && <p role="status">{draft.notice}</p>}
      {squad.status === 'dissolved' && <p>{text('小队已关闭，无法发送留言。')}</p>}
    </form>
  );
}
