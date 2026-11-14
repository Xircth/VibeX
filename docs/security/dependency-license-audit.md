# Dependency and License Audit

The release gate runs `pnpm run dependency:licenses` against the resolved `pnpm` dependency graph and locked Cargo metadata. All third-party registry dependencies must declare an approved permissive or weak-copyleft license expression; workspace crates are covered by the repository license and excluded from external registry checks.

## Policy & Exceptions

- **Exact-Version Metadata Exceptions**: `khroma@2.1.0` omits the `license` field in `package.json` while shipping a standard MIT `license` file in its tarball. Exceptions are pinned to exact versions so any version bump triggers explicit license review.
- **Transitive Security Overrides**: Root `package.json` `pnpm.overrides` pins patched versions for transitive advisories so production dependency graphs stay free of `high` and `critical` vulnerabilities.
- **Online CI Advisory Gates**: CI additionally enforces `rustsec/audit-check` for Cargo crates and `pnpm audit --prod --audit-level high` for npm packages, complementing the deterministic offline license gate.

See root [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and [`docs/third-party/`](../third-party/) for third-party attributions and vendored skill provenance.

## Verification

```bash
node --test scripts/check-dependency-licenses.test.mjs
pnpm run dependency:licenses
pnpm audit --prod --audit-level high
```
