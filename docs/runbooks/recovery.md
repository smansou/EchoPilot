# Recovery: interrupted installs, updates and rollback

EchoPilot updates are staged transactions, not in-place edits. The release store keeps the
previously working version intact until the new one is verified and committed, so an **interrupt**
— a crash, a power loss, a killed installer or a failed verification — never leaves you without a
working app.

## What happens during an install or update

`scripts/release/install.mjs` (driven by the installer, or by hand for support) runs five stages in
order: `verify` (every asset is re-hashed against `models/manifest.json`, including directory
digests and licence files), `stage` (the pack is unpacked into `staging/<version>-<id>`), `journal`
(the intent to commit is recorded), `commit` (`current` flips to the new immutable
`versions/<version>`), and `cleanup` (superseded versions beyond the retention count are pruned).
Only `commit` changes what runs.

- Interrupted before `commit`: nothing user-visible changed. The active version still verifies, and
  the half-written staging directory is discarded on the next run.
- Interrupted at or after `commit`: the new version is already active and verifiable; rerunning the
  update completes the cleanup, or you roll back.

## Rolling back

```
node scripts/release/install.mjs rollback --root "$HOME/Library/Application Support/EchoPilot/updates"
```

Rollback restores the version that was active before the most recent successful install/update and
prints `active: <version>`. Verify state at any time with
`node scripts/release/install.mjs verify --root <store>`; it re-hashes the stored active version
against the manifest recorded at install time and prints `verify: ok`. Because the record lives in
the store rather than in memory, an app restart or crash does not lose recovery information.

## Tampered or unsigned updates

An update whose bytes, layout or manifest do not match the pins is rejected before staging
completes: the tool prints one `problem: <detail>` line per violation, exits nonzero, never prints
`stage: commit`, and leaves the old version active. Updates also require a Developer ID signature
(`--signature`); a missing or bad signature is rejected the same way. The bundled **backup** policy
keeps at least the two previous versions, and the compatibility backup of the memory store is taken
before a schema-changing update, so even a successful update can be undone. If `verify` fails
after a manual edit to the store, do not delete anything — capture the `problem:` lines and roll
back first.
