import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectChecks } from './loop-gates.mjs';

const EMPTY_TEST = 'export {};\n';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'loop-gates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), content);
  }
  return root;
}

function assertSafeCommands(commands) {
  for (const command of commands) {
    assert.ok(['node', 'pnpm', 'swift'].includes(command[0]), `unexpected executable: ${command.join(' ')}`);
    assert.ok(command.every(part => typeof part === 'string' && part.length > 0), `invalid argv part: ${command.join(' ')}`);
    assert.ok(!command.some(part => ['sh', 'bash', 'zsh'].includes(part) || /\.sh$/.test(part)), `invented shell command: ${command.join(' ')}`);
  }
}

test('discovers nested security, memory, and desktop tests in one all-repo node command', async (t) => {
  const root = await fixture(t, {
    'apps/desktop/src/main/widget-status.test.ts': EMPTY_TEST,
    'apps/desktop/src/main/widget-status.ts': 'export {};\n',
    'apps/desktop/src/renderer/control/sessions/managed-session.test.tsx': EMPTY_TEST,
    'packages/core/src/index.ts': 'export {};\n',
    'packages/harness-codex/test/isolation.test.js': EMPTY_TEST,
    'packages/memory/src/store/acceptance.test.ts': EMPTY_TEST,
    'packages/security/test/acceptance.spec.mjs': EMPTY_TEST,
    'packages/security/test/helper-path.spec.ts': EMPTY_TEST,
  });
  const result = await collectChecks(root);
  const discovered = [
    'apps/desktop/src/main/widget-status.test.ts',
    'apps/desktop/src/renderer/control/sessions/managed-session.test.tsx',
    'packages/harness-codex/test/isolation.test.js',
    'packages/memory/src/store/acceptance.test.ts',
    'packages/security/test/acceptance.spec.mjs',
    'packages/security/test/helper-path.spec.ts',
  ];
  assert.deepEqual(result.coverage.testFiles, discovered);
  const nodeCommands = result.commands.filter(command => command[0] === 'node');
  assert.equal(nodeCommands.length, 1, 'siblings must share one all-repo node command');
  assert.deepEqual(nodeCommands[0], ['node', '--import', 'tsx', '--test', ...discovered]);
  assert.ok(discovered.some(file => file.startsWith('packages/security/')));
  assert.ok(discovered.some(file => file.startsWith('packages/memory/')));
  assert.ok(discovered.some(file => file.startsWith('apps/desktop/')));
  assert.deepEqual(result.commands.slice(-3), [['pnpm', 'contracts:check'], ['pnpm', 'typecheck'], ['pnpm', 'build']]);
  assert.deepEqual(result.coverage.nativePackages, []);
  assert.deepEqual(result.missing, []);
  assertSafeCommands(result.commands);
  assert.deepEqual(await collectChecks(root), result, 'repeated collection must be identical');
});

test('batches discovered tests into deterministic chunks of at most 30 files', async (t) => {
  const files = {};
  const expected = [];
  for (let index = 0; index < 31; index += 1) {
    const name = `packages/core/src/case-${String(index).padStart(2, '0')}.test.ts`;
    files[name] = EMPTY_TEST;
    expected.push(name);
  }
  const root = await fixture(t, files);
  const { commands, coverage } = await collectChecks(root);
  assert.deepEqual(coverage.testFiles, expected);
  const nodeCommands = commands.filter(command => command[0] === 'node');
  assert.equal(nodeCommands.length, 2);
  assert.equal(nodeCommands[0].length, 4 + 30);
  assert.deepEqual(nodeCommands[1], ['node', '--import', 'tsx', '--test', expected[30]]);
});

test('never scans excluded directories or follows symlinks', async (t) => {
  const root = await fixture(t, {
    'packages/core/.build/cache.test.ts': EMPTY_TEST,
    'packages/core/src/real.test.ts': EMPTY_TEST,
    'packages/harness-codex/src/generated/protocol.test.ts': EMPTY_TEST,
    'packages/security/dist/bundle.test.mjs': EMPTY_TEST,
    'packages/security/node_modules/dependency/evil.test.ts': EMPTY_TEST,
    'packages/security/test/helper-path.test.ts': EMPTY_TEST,
    'apps/desktop/.git/hook.spec.js': EMPTY_TEST,
    '.loop/runs/state.test.ts': EMPTY_TEST,
    'dist/out.spec.js': EMPTY_TEST,
  });
  await symlink(join(root, 'packages/security/test'), join(root, 'packages/security/linked'), 'dir');
  await symlink(join(root, 'packages/core/src/real.test.ts'), join(root, 'packages/core/src/linked.test.ts'));
  const result = await collectChecks(root);
  assert.deepEqual(result.coverage.testFiles, [
    'packages/core/src/real.test.ts',
    'packages/security/test/helper-path.test.ts',
  ]);
});

test('never mutates caller argv and returns fresh command arrays', async (t) => {
  const root = await fixture(t, {
    'packages/core/src/index.test.ts': EMPTY_TEST,
    'packages/security/test/helper-path.test.ts': EMPTY_TEST,
  });
  const testCommand = Object.freeze(['pnpm', 'typecheck']);
  const changedFiles = Object.freeze([]);
  const before = JSON.stringify([testCommand, changedFiles]);
  const first = await collectChecks(root, Object.freeze({ testCommand, changedFiles }));
  assert.equal(JSON.stringify([testCommand, changedFiles]), before, 'caller argv must stay untouched');
  assert.equal(first.commands.filter(command => command.join(' ') === 'pnpm typecheck').length, 1, 'duplicate gate must be skipped');
  const snapshot = JSON.stringify(first);
  for (const command of first.commands) command.push('--mutated');
  const second = await collectChecks(root, Object.freeze({ testCommand, changedFiles }));
  assert.equal(JSON.stringify(second), snapshot, 'results must be fresh copies');
  assert.equal(JSON.stringify([testCommand, changedFiles]), before);
  assert.notEqual(second.commands, first.commands);
  assert.notEqual(second.commands[0], first.commands[0]);
});

test('includes an explicit frozen test command exactly once', async (t) => {
  const root = await fixture(t, { 'packages/core/src/index.test.ts': EMPTY_TEST });
  const generated = ['node', '--import', 'tsx', '--test', 'packages/core/src/index.test.ts'];
  const deduped = await collectChecks(root, { testCommand: generated });
  assert.equal(deduped.commands.filter(command => command.join(' ') === generated.join(' ')).length, 1);
  const verbose = [...generated, '--test-reporter=spec'];
  const added = await collectChecks(root, { testCommand: verbose });
  assert.equal(added.commands.filter(command => command.join(' ') === verbose.join(' ')).length, 1);
  assert.deepEqual(added.commands[1], verbose, 'frozen command follows the node batch');
  const invalid = await collectChecks(root, { testCommand: 'node' });
  assert.equal(invalid.commands.filter(command => command[0] === 'node').length, 1);
  assert.ok(invalid.missing.some(entry => entry.startsWith('testCommand:')));
});

test('adds swift build and swift test only for wired native test targets', async (t) => {
  const root = await fixture(t, {
    'native/macos/Package.swift': [
      '// swift-tools-version: 5.9',
      'import PackageDescription',
      'let package = Package(',
      '    name: "EchoPilotSecurity",',
      '    products: [.executable(name: "echopilot-secrets", targets: ["Secrets"])],',
      '    targets: [',
      '        .executableTarget(name: "Secrets", path: "Sources/Secrets"),',
      '        .testTarget(name: "SecretsTests", dependencies: ["Secrets"]),',
      '    ]',
      ')',
    ].join('\n'),
    'native/macos/Sources/Secrets/main.swift': 'print("helper")\n',
    'native/macos/Tests/SecretsTests/KeychainTests.swift': 'import XCTest\nfinal class KeychainTests: XCTestCase {}\n',
  });
  const result = await collectChecks(root, {
    changedFiles: ['native/macos/Sources/Secrets/main.swift', 'native/macos/Tests/SecretsTests/KeychainTests.swift'],
  });
  assert.deepEqual(result.coverage.nativePackages, ['native/macos/Package.swift']);
  assert.deepEqual(result.commands.slice(-2), [
    ['swift', 'build', '--package-path', 'native/macos'],
    ['swift', 'test', '--package-path', 'native/macos'],
  ]);
  assert.deepEqual(result.missing, []);
  assertSafeCommands(result.commands);
});

test('signals native missing wiring and unverified tests instead of claiming coverage', async (t) => {
  const root = await fixture(t, {
    'native/macos/Package.swift': [
      '// swift-tools-version: 5.9',
      'import PackageDescription',
      'let package = Package(',
      '    name: "EchoPilotSecurity",',
      '    targets: [',
      '        .executableTarget(name: "Secrets", path: "Sources/Secrets"),',
      '        .testTarget(name: "SecretsTests", path: "Tests/SecretsTests"),',
      '    ]',
      ')',
    ].join('\n'),
    'native/macos/Sources/PlatformHost/main.swift': 'print("legacy")\n',
    'native/macos/Sources/Secrets/main.swift': 'print("helper")\n',
    'native/macos/Tests/main.swift': 'import Foundation\nprint("script")\n',
  });
  const result = await collectChecks(root, {
    changedFiles: [
      'native/macos/Sources/PlatformHost/main.swift',
      'native/macos/Sources/Secrets/main.swift',
      'native/macos/Tests/main.swift',
    ],
  });
  assert.deepEqual(result.missing, [
    'swift wiring: native/macos/Sources/PlatformHost/main.swift is not referenced by any target in native/macos/Package.swift; not validated',
    'unverified native test: native/macos/Tests/main.swift is not referenced by any target in native/macos/Package.swift; not validated',
  ]);
  assert.deepEqual(result.coverage.nativePackages, ['native/macos/Package.swift']);
  assert.ok(result.commands.some(command => command.join(' ') === 'swift build --package-path native/macos'));
  assert.ok(result.commands.some(command => command.join(' ') === 'swift test --package-path native/macos'));
  assertSafeCommands(result.commands);
});

test('flags executable Tests/main.swift scripts as unverified XCTest', async (t) => {
  const root = await fixture(t, {
    'native/macos/Package.swift': [
      '// swift-tools-version: 5.9',
      'import PackageDescription',
      'let package = Package(',
      '    name: "EchoPilotSecurity",',
      '    targets: [',
      '        .executableTarget(name: "Secrets", path: "Sources/Secrets"),',
      '        .testTarget(name: "SecretsTests", path: "Tests"),',
      '    ]',
      ')',
    ].join('\n'),
    'native/macos/Tests/main.swift': 'import Foundation\nprint("executable harness")\n',
    'native/macos/Tests/KeychainTests.swift': 'import XCTest\nfinal class KeychainTests: XCTestCase {}\n',
  });
  const result = await collectChecks(root, {
    changedFiles: ['native/macos/Tests/main.swift', 'native/macos/Tests/KeychainTests.swift'],
  });
  assert.deepEqual(result.missing, [
    'unverified native test: native/macos/Tests/main.swift is an executable script, not an XCTest case in native/macos/Package.swift; not validated',
  ]);
  assertSafeCommands(result.commands);
});

test('resolves the nearest manifest and keeps swift test per manifest', async (t) => {
  const root = await fixture(t, {
    'native/macos/Package.swift': [
      '// swift-tools-version: 5.9',
      'import PackageDescription',
      'let package = Package(',
      '    name: "EchoPilotSecurity",',
      '    targets: [',
      '        .executableTarget(name: "Secrets", path: "Sources/Secrets"),',
      '        .testTarget(name: "SecretsTests", dependencies: ["Secrets"]),',
      '    ]',
      ')',
    ].join('\n'),
    'native/macos/Tools/Package.swift': [
      '// swift-tools-version: 5.9',
      'import PackageDescription',
      'let package = Package(',
      '    name: "EchoPilotTools",',
      '    targets: [.executableTarget(name: "Tool", path: "Sources/Tool")],',
      ')',
    ].join('\n'),
    'native/macos/Sources/Secrets/KeychainStore.swift': 'struct KeychainStore {}\n',
    'native/macos/Tools/Sources/Tool/main.swift': 'print("tool")\n',
    'native/ios/App/main.swift': 'print("no manifest here")\n',
  });
  const result = await collectChecks(root, {
    changedFiles: [
      'native/macos/Sources/Secrets/KeychainStore.swift',
      'native/macos/Tools/Sources/Tool/main.swift',
      'native/ios/App/main.swift',
      'docs/notes.md',
      '../outside.swift',
    ],
  });
  assert.deepEqual(result.coverage.nativePackages, ['native/macos/Package.swift', 'native/macos/Tools/Package.swift']);
  assert.deepEqual(result.commands.slice(-3), [
    ['swift', 'build', '--package-path', 'native/macos'],
    ['swift', 'test', '--package-path', 'native/macos'],
    ['swift', 'build', '--package-path', 'native/macos/Tools'],
  ]);
  assert.deepEqual(result.missing, [
    'changed file outside repository: ../outside.swift',
    'swift wiring: native/ios/App/main.swift has no Package.swift in its directory ancestry; not validated',
  ]);
  assertSafeCommands(result.commands);
});
