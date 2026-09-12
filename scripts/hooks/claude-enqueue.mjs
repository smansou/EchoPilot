#!/usr/bin/env node
/**
 * EchoPilot's Claude Code observation hook: dependency-free, enqueue-only.
 *
 * Claude Code invokes this command for each observed lifecycle event with the hook payload on
 * stdin. The command archives the payload durably under `ECHOPILOT_HOOK_SPOOL_DIR` and always
 * exits 0 without contacting the companion: `ECHOPILOT_HOOK_INGRESS` (may be absent, or a
 * companion that is not running) is only recorded as a hint for a later courier.
 *
 * The archive key is derived from the source event identity, so a retried delivery of the same
 * Claude event lands on the same file and can never be normalized twice.
 *
 * Usage: node claude-enqueue.mjs [--spool <dir>] [--installation <id>] [--ingress <path>]
 * Env:   ECHOPILOT_HOOK_SPOOL_DIR, ECHOPILOT_HOOK_INSTALLATION_ID, ECHOPILOT_HOOK_INGRESS
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

/** Source identity that stays stable across retries of one Claude event. */
function sourceKey(installationId, payload) {
  const identity = [
    installationId,
    payload.session_id ?? '',
    payload.hook_event_name ?? '',
    payload.tool_use_id ?? payload.notification_id ?? payload.uuid ?? '',
    payload.cwd ?? '',
  ].join('|');
  return createHash('sha256').update(identity).digest('hex');
}

function main() {
  const spoolDir = argumentValue('--spool') ?? process.env.ECHOPILOT_HOOK_SPOOL_DIR;
  if (typeof spoolDir !== 'string' || spoolDir.length === 0) return;
  const installationId = argumentValue('--installation') ?? process.env.ECHOPILOT_HOOK_INSTALLATION_ID ?? 'unconfigured';
  const ingressPath = argumentValue('--ingress') ?? process.env.ECHOPILOT_HOOK_INGRESS ?? null;

  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;

  const key = sourceKey(installationId, payload);
  const archive = JSON.stringify({
    schemaVersion: 1,
    installationId,
    key,
    receivedAt: new Date().toISOString(),
    ingressPath,
    hook: payload,
  });

  const incomingDir = `${spoolDir.replace(/\/+$/, '')}/incoming`;
  const target = `${incomingDir}/${key}.json`;
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(incomingDir, { recursive: true });
  writeFileSync(temporary, archive);
  renameSync(temporary, target);
}

try {
  main();
} catch {
  // Observation must never disturb the agent CLI: a failed enqueue is dropped, not raised.
}
