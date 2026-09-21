/**
 * The desktop control path's production binding: one profile, its real privacy service.
 *
 * This is the module a desktop host mounts to serve the renderer's privacy panel, and it is where
 * the ticket's three seams meet for real — no doubles, no test-only helpers:
 *
 *   - the **store** is the M01 `createMemoryStore` profile, whose own `privacy` handle admits every
 *     batch before it is written (so an ordinary import cannot resurrect a forgotten record);
 *   - **forget** runs that handle's `forget`, which removes the raw lineage, condenses the derived
 *     state and records the tombstone the storage boundary consults;
 *   - **export/restore** run the passphrase-sealed `exportProfile` / `importProfile` pair, so a
 *     restore only ever lands in a new, absent directory;
 *   - **private sessions** open the same in-memory registry the store's ingest boundary diverts
 *     captures into, so beginning one here changes what this profile persists.
 *
 * `snapshot()` exposes the durable state a host route would publish: which sessions are open and
 * which identities are suppressed. The handle owns the store's lifetime, so closing the host closes
 * the profile; callers that keep their own store should not create a host over the same directory.
 */
import { createMemoryStore, type PrivacyBoundMemoryStore } from '../../../../../../packages/memory/src/store/index.js';
import { exportProfile, importProfile } from '../../../../../../packages/security/src/privacy/index.js';
import type { PrivacyOperations, PrivacySessionEntry } from './index.js';

export type ProfilePrivacyHostOptions = Readonly<{
  /** The profile directory the store opens (its `profile.db`, `projects/` and derivation sidecars). */
  directory: string;
  /** Key material for the encrypted store; never written to disk in plaintext. */
  key: string;
  /** Profile registry identity the store and its key check are bound to. */
  profileId: string;
  /** Where an export archive is written; it must not live inside `directory`. */
  archivePath: string;
  /** Where a restore is installed; it must be absent, so a restore never mixes with a profile. */
  restoreDirectory: string;
}>;

export type ProfilePrivacySnapshot = Readonly<{
  /** Session ids whose private choice is currently in force. */
  openSessions: readonly string[];
  /** Identities the profile's durable forget ledger suppresses, tombstones included. */
  forgotten: readonly Readonly<{ sourceId: string; sourceEventIds: readonly string[] }>[];
}>;

export type ProfilePrivacyHost = Readonly<{
  readonly directory: string;
  readonly store: PrivacyBoundMemoryStore;
  readonly operations: PrivacyOperations;
  snapshot(): Promise<ProfilePrivacySnapshot>;
  close(): Promise<void>;
}>;

/**
 * Opens the profile and returns the operations the renderer control drives. The store's own
 * `privacy` handle is used for both the ledger and the session registry, so a choice made here is
 * exactly the choice the storage boundary enforces — there is no second policy to keep in sync.
 */
export async function createProfilePrivacyHost(options: ProfilePrivacyHostOptions): Promise<ProfilePrivacyHost> {
  if (options === null || typeof options !== 'object') throw new TypeError('createProfilePrivacyHost requires { directory, key, profileId, archivePath, restoreDirectory }');
  const directory = requireText(options.directory, 'a profile directory');
  const archivePath = requireText(options.archivePath, 'an export archive path');
  const restoreDirectory = requireText(options.restoreDirectory, 'a restore directory');
  const store = await createMemoryStore({ directory, key: requireText(options.key, 'store key material'), profileId: requireText(options.profileId, 'a profileId') });
  const privacy = store.privacy;

  const operations: PrivacyOperations = {
    bound: true,
    forget: async (selection) => {
      const receipt = await privacy.forget({
        ...(selection.eventIds === undefined ? {} : { eventIds: selection.eventIds }),
        ...(selection.sources === undefined ? {} : { sources: selection.sources }),
      });
      return { deleted: receipt.deleted, condensed: receipt.condensed };
    },
    exportProfile: async ({ passphrase }) => {
      const receipt = await exportProfile({ directory, destination: archivePath, passphrase });
      return { files: receipt.files };
    },
    importProfile: async ({ archive, passphrase }) => {
      // The archive a user picked wins; the configured path is the default for a one-shot restore.
      const receipt = await importProfile({ archive: archive.length > 0 ? archive : archivePath, directory: restoreDirectory, passphrase });
      return { files: receipt.files };
    },
    beginPrivateSession: ({ sessionId }) => {
      privacy.privateSessions.begin({ sessionId });
    },
    endPrivateSession: ({ sessionId }): readonly PrivacySessionEntry[] => {
      const session = privacy.privateSessions.get(sessionId);
      return session === undefined ? [] : session.end();
    },
  };

  return {
    directory,
    store,
    operations,
    snapshot: async () => ({
      openSessions: privacy.privateSessions.openSessions(),
      forgotten: await privacy.tombstones(),
    }),
    close: () => store.close(),
  };
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`createProfilePrivacyHost requires ${label}`);
  return value;
}
