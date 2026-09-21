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

## Tampered, mis-signed and unsigned updates

An update whose bytes, layout or manifest do not match the pins is rejected before staging
completes: the tool prints one `problem: <detail>` line per violation, exits nonzero, never prints
`stage: commit`, and leaves the old version active.

The manifest travels with the pack, so it cannot be its own proof: a substituted pack can carry a
rewritten, self-consistent manifest. The signature record is what settles that —
`models/manifest.json` declares `authenticity.requiresSignature`, and the release job signs the
manifest bytes and the whole pack with the Developer ID key
(`node scripts/release/sign-manifest.mjs --manifest <file> --pack <dir> --key <private-key.pem>`).
`scripts/release/install.mjs` then:

- requires the record (`<pack>/signature.json`, or `--signature <file>`) whenever the manifest of
  record requires one, and refuses with `problem: signature: ...` when it is missing;
- verifies that the record names the pinned identity and team, that its `manifestSha256` equals the
  sha256 of the exact manifest bytes being installed, and that its `packSha256` equals the sha256
  of the whole pack directory, so a rewritten manifest or an added, removed or edited pack file is
  a mismatch even if the manifest was rewritten to agree with it;
- verifies the detached signature against the public key pinned in
  `scripts/release/installers.json` (`distribution.signingPublicKeyPem`, checked against
  `distribution.signingPublicKeySha256`, the sha256 of the PEM as JSON decodes it). The pin is never
  read from the pack, and a pack with no obtainable signature fails closed rather than installing
  unauthenticated bytes. Run `node scripts/release/sign-manifest.mjs --check-policy` before a
  signing round: it prints the pinned identity, team, record name and derived digest, and fails when
  the two digest fields drift apart — an inconsistent anchor rejects every record. The PEM in the
  repository is a provisioning placeholder; the release job replaces it with the Developer ID
  public key from the release keychain and regenerates the digest, because only that key's private
  half can produce a record this anchor accepts. `--policy <file>` points support at the release
  policy that travelled with a given installer;
- carries the requirement forward in `<root>/policy.json`: once a store has committed a signed
  version, an update may not drop back to unsigned, and `verify` and `rollback` re-check the stored
  record (and refuse a stored version that lost it) from a fresh process.

A pack whose manifest of record does not declare an authenticity requirement — a developer or
fixture pack — may install unsigned, but the tool prints `signature: none presented; ...` instead
of implying the bytes were authenticated, and the store stays in unsigned mode. A release pack
always ships `models/manifest.json` unmodified, so the requirement survives with it; a store that
has ever committed a signed version refuses such a pack outright, and `verify` prints
`signature: verified against <policy>` for every signed version it still holds.

The bundled **backup** policy keeps at least the two previous versions, and the compatibility
backup of the memory store is taken before a schema-changing update, so even a successful update
can be undone. If `verify` fails after a manual edit to the store, do not delete anything —
capture the `problem:` lines and roll back first.
