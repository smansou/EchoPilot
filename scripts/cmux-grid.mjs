#!/usr/bin/env node
// cmux layout manager for the autonomous loop.
//
// Layout contract: one cmux workspace holds the supervisor surface in a full-height
// pane on the left (one third of the workspace width) and a balanced grid of agent
// surfaces in the remaining two thirds. Every active ticket owns exactly one agent
// surface, so the grid grows and shrinks with the number of tickets in flight and is
// re-equalised after every change.
//
// Commands:
//   ensure  --workspace <ws> --supervisor-surface <surface>
//   spawn   --workspace <ws> --supervisor-surface <surface> --name <ticket>
//           --cwd <dir> --command <cmd> [--title <text>]
//   release --workspace <ws> --supervisor-surface <surface> --surface <surface>
//   sync    --workspace <ws> --supervisor-surface <surface> [--agents <a,b,c>]
//   show    --workspace <ws> --supervisor-surface <surface>
//
// Panes and surfaces are addressed by UUID: short refs are resolved against the
// caller's workspace, so they are unsafe when automation runs in another workspace.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CMUX = process.env.CMUX_BIN ?? '/Applications/cmux.app/Contents/Resources/bin/cmux';
const STATE_PATH = process.env.CMUX_LAYOUT_STATE ?? join(process.cwd(), '.loop', 'cmux-layout.json');
const SUPERVISOR_FRACTION = Number.parseFloat(process.env.CMUX_SUPERVISOR_RATIO ?? '') || 1 / 3;
const TOLERANCE = 4;
const UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i;

function cmux(args, { allowFail = false } = {}) {
  const result = spawnSync(CMUX, args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    if (allowFail) return { ok: false, out };
    throw new Error(`cmux ${args.join(' ')} failed: ${out || `exit ${result.status}`}`);
  }
  return { ok: true, out };
}

function view(ws) {
  const listed = JSON.parse(cmux(['--json', '--id-format', 'both', 'list-panes', '--workspace', ws]).out);
  return {
    container: listed.container_frame,
    panes: listed.panes.map(pane => ({
      id: pane.id,
      ref: pane.ref,
      x: pane.pixel_frame.x,
      y: pane.pixel_frame.y,
      w: pane.pixel_frame.width,
      h: pane.pixel_frame.height,
      surfaces: pane.surface_ids,
      selected: pane.selected_surface_id,
    })),
  };
}

function paneOfSurface(current, surfaceId) {
  return current.panes.find(pane => pane.surfaces.includes(surfaceId));
}

function paneById(current, paneId) {
  return current.panes.find(pane => pane.id === paneId);
}

function regionPanes(current, supervisor) {
  const edge = supervisor.x + supervisor.w;
  return current.panes
    .filter(pane => pane.id !== supervisor.id && pane.x >= edge - 2)
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

function supervisorPane(ws, supervisorSurface) {
  const current = view(ws);
  const pane = paneOfSurface(current, supervisorSurface);
  if (!pane) throw new Error(`supervisor surface ${supervisorSurface} is not in workspace ${ws}`);
  return { current, pane };
}

function moveSurface(ws, surfaceId, paneId) {
  cmux(['move-surface', '--workspace', ws, '--surface', surfaceId, '--pane', paneId, '--focus', 'false']);
}

function closeSurface(ws, surfaceId) {
  cmux(['close-surface', '--workspace', ws, '--surface', surfaceId], { allowFail: true });
}

function renameSurface(ws, surfaceId, title) {
  if (!title) return;
  cmux(['rename-tab', '--workspace', ws, '--surface', surfaceId, title], { allowFail: true });
}

function split(ws, direction, fromPane) {
  const current = view(ws);
  const pane = paneById(current, fromPane.id);
  if (!pane?.surfaces.length) throw new Error(`cannot split missing or empty pane ${fromPane.id}`);
  const anchor = pane.selected && pane.surfaces.includes(pane.selected) ? pane.selected : pane.surfaces[0];
  cmux(['new-split', direction, '--workspace', ws, '--surface', anchor, '--focus', 'false']);
  const created = view(ws).panes.find(entry => !current.panes.some(previous => previous.id === entry.id));
  if (!created) throw new Error(`split ${direction} created no pane`);
  return created;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// This cmux build silently drops `new-surface --command`, so wait for the login shell
// to print its prompt and type the command into the live shell instead.
function waitForPrompt(ws, surface, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const screen = cmux(['read-screen', '--workspace', ws, '--surface', surface, '--lines', '3'], { allowFail: true });
    if (screen.ok) {
      const lines = screen.out.split('\n').map(line => line.trimEnd()).filter(Boolean);
      if (lines.length && /[%$#❯>]\s*$/.test(lines.at(-1))) return true;
    }
    sleepSync(200);
  }
  return false;
}

function sendCommand(ws, surface, command) {
  waitForPrompt(ws, surface);
  cmux(['send', '--workspace', ws, '--surface', surface, command]);
  cmux(['send-key', '--workspace', ws, '--surface', surface, 'enter']);
}

function newSurface(ws, paneId, { cwd, command, title } = {}) {
  const args = ['--id-format', 'both', 'new-surface', '--workspace', ws, '--type', 'terminal', '--pane', paneId, '--focus', 'false'];
  if (cwd) args.push('--working-directory', cwd);
  const out = cmux(args).out;
  const surface = out.match(UUID)?.[0];
  if (!surface) throw new Error(`could not read the new surface id from: ${out}`);
  if (command) sendCommand(ws, surface, command);
  renameSurface(ws, surface, title);
  return surface;
}

function equalize(ws) {
  cmux(['rpc', 'workspace.equalize_splits', JSON.stringify({ workspace_id: ws })], { allowFail: true });
}

function resize(ws, paneId, direction, amount) {
  const points = Math.max(1, Math.round(Math.abs(amount)));
  cmux(['resize-pane', '--workspace', ws, '--pane', paneId, `-${direction}`, '--amount', String(points)], { allowFail: true });
}

// Prefer a grid whose cells stay close to square inside the wider-than-tall region.
function columnsFor(count, container) {
  if (count <= 1) return 1;
  const regionAspect = (container.width * (1 - SUPERVISOR_FRACTION)) / Math.max(1, container.height);
  let best = { columns: 1, score: Number.POSITIVE_INFINITY };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const score = Math.abs(Math.log(regionAspect / columns / (1 / rows)));
    if (score < best.score - 1e-9) best = { columns, score };
  }
  return best.columns;
}

function setSupervisorWidth(ws, supervisorSurface) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { current, pane } = supervisorPane(ws, supervisorSurface);
    const region = regionPanes(current, pane);
    if (!region.length) return;
    const target = Math.round(current.container.width * SUPERVISOR_FRACTION);
    const delta = target - pane.w;
    if (Math.abs(delta) <= TOLERANCE) return;
    if (delta > 0) resize(ws, pane.id, 'R', delta);
    else resize(ws, region[0].id, 'L', -delta);
  }
}

// equalize_splits makes every leaf pane the same size, which also resizes the
// supervisor column. Walk the columns left to right, moving each boundary onto the
// even-width position; every move takes its points from the next column, so after the
// last one every column matches without touching the supervisor width again.
function equalizeColumns(ws, cells, supervisorSurface) {
  if (cells.length < 2) return;
  for (let index = 0; index < cells.length - 1; index += 1) {
    const { current, pane: supervisor } = supervisorPane(ws, supervisorSurface);
    const left = paneById(current, cells[index][0].id);
    const right = paneById(current, cells[index + 1][0].id);
    if (!left || !right) continue;
    const target = (current.container.width - supervisor.w) / cells.length;
    const delta = target - left.w;
    if (Math.abs(delta) <= TOLERANCE) continue;
    if (delta > 0) resize(ws, left.id, 'R', delta);
    else resize(ws, right.id, 'L', -delta);
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { agents: [] };
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function optionalArg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requireArg(name) {
  const value = optionalArg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function context() {
  return { ws: requireArg('workspace'), supervisorSurface: requireArg('supervisor-surface') };
}

function surfacesOutside(ws, supervisorSurface) {
  const current = view(ws);
  const supervisor = paneOfSurface(current, supervisorSurface);
  const keep = new Set(supervisor?.surfaces ?? []);
  if (supervisor) keep.add(supervisorSurface);
  return current.panes.flatMap(pane => pane.surfaces).filter(surface => !keep.has(surface));
}

// Give the agent region a pane to live in, splitting it off the supervisor column once.
function ensureRegion(ws, supervisorSurface, cwd) {
  let { current, pane: supervisor } = supervisorPane(ws, supervisorSurface);
  let region = regionPanes(current, supervisor);
  if (!region.length) {
    split(ws, 'right', supervisor);
    ({ current, pane: supervisor } = supervisorPane(ws, supervisorSurface));
    region = regionPanes(current, supervisor);
    setSupervisorWidth(ws, supervisorSurface);
  }
  const state = readState();
  const occupied = (state.agents ?? []).map(agent => paneOfSurface(current, agent)).find(Boolean);
  return occupied ?? region[0];
}

function buildGrid(ws, agents) {
  const current = view(ws);
  const columns = columnsFor(agents.length, current.container);
  const root = paneOfSurface(current, agents[0]);
  if (!root) throw new Error(`agent surface ${agents[0]} is not on screen`);
  const columnsOfPanes = [root];
  for (let index = 1; index < columns; index += 1) columnsOfPanes.push(split(ws, 'right', columnsOfPanes[index - 1]));
  const cells = [];
  for (let index = 0; index < columns; index += 1) {
    const entries = Math.ceil((agents.length - index) / columns);
    const column = [columnsOfPanes[index]];
    for (let row = 1; row < entries; row += 1) column.push(split(ws, 'down', column[row - 1]));
    cells.push(column);
  }
  return cells;
}

function sync({ ws, supervisorSurface, agents }) {
  if (!agents.length) {
    writeState({ workspace: ws, supervisorSurface, agents: [], updatedAt: new Date().toISOString() });
    return { agents: [], columns: 0, rows: 0 };
  }
  // Gather every agent surface into one pane. Panes that lose their last surface
  // collapse, leaving exactly [supervisor pane | agent pane] to rebuild from.
  const current = view(ws);
  const root = paneOfSurface(current, agents[0]);
  if (!root) throw new Error(`agent surface ${agents[0]} is not on screen`);
  for (const surface of agents.slice(1)) {
    const pane = paneOfSurface(current, surface);
    if (!pane) throw new Error(`agent surface ${surface} is not on screen`);
    if (pane.id !== root.id) moveSurface(ws, surface, root.id);
  }
  for (const surface of surfacesOutside(ws, supervisorSurface)) {
    if (!agents.includes(surface)) closeSurface(ws, surface);
  }

  const cells = buildGrid(ws, agents);
  const columns = cells.length;
  const rows = Math.max(...cells.map(column => column.length));
  for (let index = 0; index < agents.length; index += 1) {
    moveSurface(ws, agents[index], cells[index % columns][Math.floor(index / columns)].id);
  }
  for (const surface of surfacesOutside(ws, supervisorSurface)) {
    if (!agents.includes(surface)) closeSurface(ws, surface);
  }

  equalize(ws);
  setSupervisorWidth(ws, supervisorSurface);
  equalizeColumns(ws, cells, supervisorSurface);
  const plan = { agents, columns, rows, cells: cells.map(column => column.map(pane => pane.id)) };
  writeState({ workspace: ws, supervisorSurface, ...plan, updatedAt: new Date().toISOString() });
  return plan;
}

function commandEnsure() {
  const { ws, supervisorSurface } = context();
  const pane = ensureRegion(ws, supervisorSurface, process.cwd());
  setSupervisorWidth(ws, supervisorSurface);
  console.log(JSON.stringify({ workspace: ws, supervisorSurface, regionPane: pane.id }));
}

function commandSpawn() {
  const { ws, supervisorSurface } = context();
  const title = optionalArg('title', optionalArg('name'));
  const pane = ensureRegion(ws, supervisorSurface, optionalArg('cwd', process.cwd()));
  const surface = newSurface(ws, pane.id, {
    cwd: optionalArg('cwd', process.cwd()),
    command: optionalArg('command'),
    title,
  });
  const state = readState();
  const agents = [...new Set([...(state.agents ?? []), surface])];
  const plan = sync({ ws, supervisorSurface, agents });
  console.log(JSON.stringify({ surface, ...plan }));
}

function commandSync() {
  const { ws, supervisorSurface } = context();
  const requested = (optionalArg('agents', readState().agents?.join(',')) ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const current = view(ws);
  const agents = requested.filter(surface => paneOfSurface(current, surface));
  console.log(JSON.stringify(sync({ ws, supervisorSurface, agents })));
}

function commandRelease() {
  const { ws, supervisorSurface } = context();
  const surface = requireArg('surface');
  closeSurface(ws, surface);
  const state = readState();
  const current = view(ws);
  const agents = (state.agents ?? []).filter(agent => agent !== surface).filter(agent => paneOfSurface(current, agent));
  console.log(JSON.stringify(sync({ ws, supervisorSurface, agents })));
}

function commandShow() {
  const { ws, supervisorSurface } = context();
  const current = view(ws);
  const supervisor = paneOfSurface(current, supervisorSurface);
  console.log(`container ${current.container.width}x${current.container.height} workspace ${ws}`);
  for (const pane of current.panes) {
    const role = pane.id === supervisor?.id ? 'supervisor' : 'agent';
    const frame = `${Math.round(pane.x)},${Math.round(pane.y)} ${Math.round(pane.w)}x${Math.round(pane.h)}`;
    console.log(`${role.padEnd(10)} ${frame.padEnd(22)} surfaces=${pane.surfaces.join(',')}`);
  }
}

function commandSend() {
  const ws = requireArg('workspace');
  const surface = requireArg('surface');
  sendCommand(ws, surface, requireArg('command'));
  console.log(JSON.stringify({ workspace: ws, surface }));
}

const commands = { ensure: commandEnsure, spawn: commandSpawn, sync: commandSync, release: commandRelease, send: commandSend, show: commandShow };
const name = process.argv[2];
if (!commands[name]) {
  console.error(`usage: cmux-grid.mjs <${Object.keys(commands).join('|')}> [options]`);
  process.exit(2);
}
try {
  commands[name]();
} catch (error) {
  console.error(`cmux-grid: ${error.message}`);
  process.exit(1);
}
