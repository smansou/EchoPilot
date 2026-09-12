/**
 * Generated contract validation for recorded evaluation fixtures.
 *
 * Fails when a checked-in fixture no longer satisfies the v1 scenario contract, when the driver
 * exposes a different set of scoring hooks than the recorded fixtures require, or when the
 * generated contract schema is missing or reports a different revision.
 *
 * Usage: node --import tsx scripts/check-contracts.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONTRACT_VERSION, REQUIRED_CHECKS, parseScenario } from '../packages/eval/src/index.ts';

const root = resolve(import.meta.dirname, '..');
const fixtureDir = join(root, 'fixtures', 'q01');

const failures: string[] = [];
let fixtureCount = 0;
const coveredChecks = new Set<string>();

const fixtureFiles = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json')).sort();
for (const file of fixtureFiles) {
  const raw = JSON.parse(await readFile(join(fixtureDir, file), 'utf8')) as unknown;
  try {
    const scenario = parseScenario(raw);
    if (!['synthetic', 'consented'].includes(scenario.consent)) {
      throw new Error(`consent must be synthetic or consented, got ${scenario.consent}`);
    }
    const checkIds = new Set(scenario.expectations.map((expectation) => expectation.checkId));
    for (const checkId of checkIds) coveredChecks.add(checkId);
    fixtureCount += 1;
    console.log(
      `ok ${file} — scenario ${scenario.scenarioId}, ${scenario.events.length} events, `
      + `checks [${[...checkIds].sort().join(', ')}]`,
    );
  } catch (error) {
    failures.push(`${file}: ${(error as Error).message}`);
  }
}

const uncoveredChecks = REQUIRED_CHECKS.filter((checkId) => !coveredChecks.has(checkId));
if (uncoveredChecks.length > 0) {
  failures.push(`fixtures/q01: no recorded fixture exercises scoring hook(s) ${uncoveredChecks.join(', ')}`);
}

try {
  const schema = JSON.parse(
    await readFile(join(root, 'packages', 'contracts', 'generated', 'echopilot-v1.schema.json'), 'utf8'),
  ) as { $id?: string; $defs?: { EventEnvelope?: { properties?: { schemaVersion?: { const?: number } } } } };
  const revision = schema.$defs?.EventEnvelope?.properties?.schemaVersion?.const;
  if (schema.$id !== 'https://echopilot.local/contracts/v1' || revision !== CONTRACT_VERSION) {
    throw new Error('generated schema is not the v1 contract revision');
  }
  console.log(`ok generated contract schema — v${CONTRACT_VERSION}`);
} catch (error) {
  failures.push(`packages/contracts/generated/echopilot-v1.schema.json: ${(error as Error).message}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`fail ${failure}`);
  console.error(`${failures.length} contract check failure(s)`);
  process.exit(1);
}

console.log(`contracts ok — ${fixtureCount} fixture(s), ${REQUIRED_CHECKS.length} scoring hooks, v${CONTRACT_VERSION}`);
