#!/usr/bin/env node
// Runs one autonomous-loop agent call inside a cmux terminal surface.
//
// The loop writes a job file (agent argv, prompt, log, exit sentinel) and starts this
// process inside the ticket's surface. It forwards the agent's raw stream to the log the
// loop parses, prints a human-readable summary to the terminal, and records the exit
// code in a sentinel file the loop polls. Keeping the process alive as the surface's
// foreground command leaves the finished transcript on screen for the operator.

import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const agentBin = job.agentBin ?? process.env.LOOP_AGENT_BIN ?? 'codex';
const log = createWriteStream(job.logFile, { flags: 'a' });

let finished = false;
let child;
let buffer = '';

function finish(code) {
  if (finished) return;
  finished = true;
  try {
    writeFileSync(job.exitFile, `${code}\n`);
  } catch {}
  try {
    log.end();
  } catch {}
  process.stdout.write(`\n── ${job.label ?? 'agent'} finished with code ${code} ──\n`);
  process.exit(0);
}

function summarize(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  const item = event.item ?? {};
  const kind = item.type ?? event.type ?? 'event';
  const detail = item.text ?? item.command ?? item.message ?? item.summary ?? item.reason ?? '';
  const clean = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  return clean ? `${kind} · ${clean}` : kind;
}

function print(text) {
  buffer += text;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    process.stdout.write(`  ${summarize(line)}\n`);
  }
  if (buffer.length > 8000) {
    process.stdout.write(`  ${summarize(buffer)}\n`);
    buffer = '';
  }
}

process.stdout.write(`▶ ${job.label ?? 'agent'} · model ${job.model ?? 'default'} · ${new Date().toLocaleTimeString()}\n`);

child = spawn(agentBin, job.args, {
  cwd: job.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...(job.env ?? {}) },
});

child.stdout.on('data', chunk => {
  log.write(chunk);
  print(String(chunk));
});
child.stderr.on('data', chunk => {
  log.write(chunk);
  process.stdout.write(String(chunk).replace(/^/gm, '  ! '));
});
child.on('error', error => {
  log.write(`${error.message}\n`);
  process.stdout.write(`  ! ${error.message}\n`);
  finish(127);
});
child.on('close', code => finish(code ?? -1));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      child.kill('SIGTERM');
    } catch {}
    setTimeout(() => finish(130), 1500);
  });
}

child.stdin.end(readFileSync(job.promptFile));
