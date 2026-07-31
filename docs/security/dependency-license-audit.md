# Dependency and License Audit

The release gate runs `pnpm run dependency:licenses` against the resolved pnpm
graph and locked Cargo metadata. Registry dependencies must declare an
approved permissive or weak-copyleft license expression. Workspace crates are
covered by the repository license and are intentionally excluded from the
third-party metadata check.

The only metadata exception is `khroma@2.1.0`: its package manifest omits the
license field, but its installed `license` file is the MIT license. The
exception is exact-version, so an upgrade becomes a failing review item.

`qrcode@1.5.4` and `@types/qrcode@1.5.5`, used only to render the one-time
device pairing challenge, both resolve under MIT-family terms and pass the
same gate.

CI also runs `rustsec/audit-check` and `pnpm audit --prod --audit-level high`.
These advisory checks intentionally remain online CI gates; the deterministic
license check is the reproducible local/offline release gate.

The 2026-07-31 release rehearsal initially found nine high-severity pnpm
advisories in transitive Router, devalue, lodash and fast-uri versions. The
workspace now resolves `react-router-dom@6.30.4` and centrally overrides those
transitives to patched releases. A fresh production audit reports zero high
findings (17 moderate and 7 low remain below the configured release threshold).
The complete frontend suite and production Web E2E passed after the lockfile
update. RustSec remains enforced by CI because `cargo-audit` is not installed
in the local release host.

Verification:

```bash
node --test scripts/check-dependency-licenses.test.mjs
pnpm run dependency:licenses
pnpm audit --prod --audit-level high
```
