// A deterministic public-protocol host double. Never invokes a model or reads host state.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const file = process.argv[2];
const state = () => JSON.parse(readFileSync(file, 'utf8'));
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const s = state();
  appendFileSync(file + '.requests', JSON.stringify(m) + '\n');
  let result;
  switch (m.method) {
    case 'initialize':
      result = { userAgent: 'cmdr-test' };
      break;
    case 'thread/read':
      result = { thread: { id: m.params.threadId, status: { type: s.status } } };
      break;
    case 'thread/resume':
      s.status = 'idle';
      result = { thread: { id: m.params.threadId, status: { type: s.status } } };
      break;
    case 'thread/queue/list':
      result = { data: s.queue, nextCursor: null };
      break;
    case 'thread/turns/list':
      result = { data: s.turns, nextCursor: null };
      break;
    case 'thread/queue/add': {
      const q = {
        id: 'q' + (s.count + 1),
        input: m.params.input,
        clientUserMessageId: m.params.clientUserMessageId,
      };
      s.count++;
      s.queue.push(q);
      result = { queuedSubmission: q };
      break;
    }
    case 'thread/queue/start': {
      if (s.status !== 'idle') throw new Error('Cannot start competing turn');
      const q = s.queue.find((q) => q.id === m.params.queuedSubmissionId);
      if (!q) throw new Error('Unknown queued submission');
      s.queue = s.queue.filter((x) => x !== q);
      s.status = 'active';
      const turn = {
        id: 't' + s.count,
        startedAt: Date.now() / 1000,
        items: [{ type: 'userMessage', clientId: q.clientUserMessageId, content: q.input }],
      };
      s.turns.push(turn);
      result = { turn };
      break;
    }
    default:
      throw new Error('Unexpected method ' + m.method);
  }
  writeFileSync(file, JSON.stringify(s));
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
}
