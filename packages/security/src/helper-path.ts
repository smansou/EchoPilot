import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Executable shipped by `native/macos` (SwiftPM product `echopilot-secrets`). */
const DEFAULT_HELPER_BINARY = 'echopilot-secrets';

export type NativeHelperPathOptions = Readonly<{
  /** Directory of the running main-process bundle: `__dirname` of `dist/main/index.cjs`. */
  bundleDir: string;
  /** Existence probe; injectable so the lookup is testable without a built helper. */
  exists?(candidate: string): boolean;
  /** Override for the helper executable name; defaults to `echopilot-secrets`. */
  binaryName?: string;
}>;

/**
 * Candidate locations for the native secrets helper. Every candidate is derived from the main
 * bundle directory — never from the process cwd — so a binary planted elsewhere on disk (an
 * attacker-writable working directory, a stale install) can never be spawned:
 *
 *  - `dist/native/macos/.build/{release,debug}/…` — bundle-relative, matching the packaged layout
 *    convention used by the F02 native host (`native-host.ts` resolves `dist/native/PlatformHost`);
 *  - `<repo>/native/macos/.build/{release,debug}/…` — the repo checkout layout, which resolves
 *    correctly no matter where the app was launched from.
 */
export function nativeHelperCandidates(options: NativeHelperPathOptions): string[] {
  const binary = options.binaryName ?? DEFAULT_HELPER_BINARY;
  const bundleDir = resolve(options.bundleDir);
  return [
    resolve(bundleDir, '../native/macos/.build/release', binary),
    resolve(bundleDir, '../native/macos/.build/debug', binary),
    resolve(bundleDir, '../../native/macos/.build/release', binary),
    resolve(bundleDir, '../../native/macos/.build/debug', binary),
  ];
}

/**
 * Resolves the native secrets helper to an absolute path inside the app/repo tree. Throws a
 * diagnostic error instead of falling back to a bare name or a cwd-relative guess.
 */
export function resolveNativeHelperPath(options: NativeHelperPathOptions): string {
  const exists = options.exists ?? existsSync;
  const candidates = nativeHelperCandidates(options);
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new Error(
      `native secrets helper '${options.binaryName ?? DEFAULT_HELPER_BINARY}' was not found; ` +
        `build native/macos or bundle it under dist/native (looked in: ${candidates.join(', ')})`,
    );
  }
  return found;
}
