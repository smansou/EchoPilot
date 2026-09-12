import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KernelStorage } from './types';

/**
 * Durable kernel state on disk (grants, version counters, receipts, queue — never secrets).
 * Writes go through a private-mode temporary file plus rename so a crash cannot truncate state.
 */
export function createFileKernelStorage(path: string): KernelStorage {
  return {
    async read(): Promise<string | null> {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(serialized: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
