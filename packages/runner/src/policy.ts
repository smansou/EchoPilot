import type { ModelDecision, RunnerConfig, Ticket } from './types.js';

export const DEFAULT_CONFIG: RunnerConfig = {
  maxWorkers: 2, maxAttempts: 2, repairPaths: ['package.json', 'pnpm-lock.yaml'],
  models: {
    simple: { model: 'gpt-5.6-luna', effort: 'medium' },
    standard: { model: 'gpt-5.6-terra', effort: 'medium' },
    complex: { model: 'gpt-5.6-terra', effort: 'high' },
    review: { model: 'gpt-5.6-sol', effort: 'high' },
  },
  ticketOverrides: {},
};

export function chooseModel(ticket: Ticket, config: RunnerConfig = DEFAULT_CONFIG, purpose: 'implementation' | 'review' = 'implementation'): ModelDecision {
  if (purpose === 'review') return { ...config.models.review, reason: 'Independent review checks acceptance evidence, changes, and integration risk.' };
  const override = config.ticketOverrides[ticket.id];
  if (override) return { ...override, reason: `Explicit model override for ${ticket.id}.` };
  if (/SECURITY|RELEASE/.test(ticket.block)) return { ...config.models.review, reason: 'Security or release work warrants stronger reasoning because failure has broader impact.' };
  if (/MEMORY|VOICE|CAPTURE|GAZE|ROUTING/.test(ticket.block) || ticket.files.some(file => /^(native\/|packages\/contracts\/)/.test(file)) || ticket.id === 'F01') {
    return { ...config.models.complex, reason: 'Native mechanisms, shared interfaces, or stateful inference require deeper implementation reasoning.' };
  }
  if (/EVAL/.test(ticket.block) || ticket.files.every(file => /^(docs\/|apps\/desktop\/src\/renderer\/|fixtures\/)/.test(file))) {
    return { ...config.models.simple, reason: 'Bounded UI, documentation, or fixture work starts with the lower-cost worker tier.' };
  }
  return { ...config.models.standard, reason: 'Routine integration starts with the balanced worker tier; failures stop after the bounded retry budget.' };
}

export function validateConfig(config: RunnerConfig): void {
  if (!config || !config.models || !config.ticketOverrides || Array.isArray(config.ticketOverrides)) throw new Error('Runner configuration must include models and ticketOverrides.');
  if (!Number.isInteger(config.maxWorkers) || config.maxWorkers < 1 || config.maxWorkers > 4) throw new Error('maxWorkers must be an integer from 1 to 4.');
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 10) throw new Error('maxAttempts must be an integer from 1 to 10.');
  if (!Array.isArray(config.repairPaths) || !config.repairPaths.length || config.repairPaths.some(path => typeof path !== 'string' || !path)) throw new Error('repairPaths must be a nonempty list of approved coordinator paths.');
  const efforts = new Set(['low', 'medium', 'high', 'xhigh']);
  for (const choice of [config.models.simple, config.models.standard, config.models.complex, config.models.review, ...Object.values(config.ticketOverrides)]) {
    if (!choice || typeof choice.model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(choice.model) || !efforts.has(choice.effort)) throw new Error('Invalid model or reasoning effort in runner configuration.');
  }
}
