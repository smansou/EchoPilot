#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const journalPath = process.env.H01_ISOLATION_JOURNAL;

function journal(entry) {
  if (journalPath !== undefined) appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  journal({ method: message.method, codexHome: process.env.CODEX_HOME });
  if (message.method === 'initialize') {
    respond(message.id, { userAgent: 'isolation-fixture/0.154.0' });
  } else if (message.method === 'thread/start') {
    respond(message.id, { thread: { id: 'managed-thread' } });
  } else if (message.method === 'turn/start') {
    respond(message.id, { turn: { id: 'managed-turn' } });
  } else if (message.method === 'thread/resume') {
    respond(message.id, { thread: { id: message.params.threadId } });
  }
});
