# Production onboarding

The approved interaction reference is `frontend/src/components/onboarding/onboarding.prototype.html`.
The implementation uses the existing account web API, Agent management service,
native configuration controls, project service and history import job.

Acceptance:

- Welcome offers optional browser sign-in. The website approves the request after
  login; the desktop polls for the result. No VibeX verification-code UI.
- One Agent page combines enabled selection, truthful lifecycle status, installation,
  authentication and native configuration. All built-ins remain visible, including
  unsupported platforms. Details are initially closed. ACP Registry is available below.
- The default enabled Agent must pass preflight before continuing. Other selected
  Agents retain their actual availability and may be configured later.
- Installed built-in Agents are scanned using their existing verified history
  adapters. Empty scans skip import. Failures are visible and retryable.
- Import is an optional prerequisite to project selection. Directories are registered
  before resolving real Host workspace IDs. Agent and external-session identities
  remain distinct; Windows directory identities are deduplicated.
- Project selection supports Global, multiple imported/existing projects, folder
  selection, creation and repository cloning. Imported/new projects and Global are
  initially selected. Finishing opens selected projects and acknowledges onboarding
  only after persistence succeeds.

Verification seams: rendered onboarding interactions, browser sign-in hook/API,
project/history preparation API and existing project dialogs. Mock external account
and Host boundaries in tests; do not call account approval or mutate real history
for an unattended test.

Visual direction: preserve VibeX's existing grayscale tokens and native controls.
Replace the split selection/install pages with a compact list and optional detail
column, and replace the folded screenshots with the account component.

## Verification and review

- 14 targeted frontend test files, 134 tests passed. These exercise the production
  onboarding, the shared settings controls, account network deadlines and
  cancellation, native configuration conflict resolution, import completion races,
  partial failures, and retaining more than six selected projects.
- Frontend TypeScript, targeted ESLint and Prettier checks passed.
- Four server local-history tests passed, including a plain directory with no Git
  repository. `cargo clippy -p server --lib -- -D warnings` passed.
- Production frontend build passed. Existing Browserslist, Tailwind utility,
  circular chunk and large chunk warnings are unrelated to this change.
- Independent standards review found an import event/RPC race, incomplete account
  response-body deadlines, and an inert conflict overwrite action; all fixed and
  covered at the relevant seams. Independent specification review found a six-tab
  truncation that discarded selected projects; removed and covered with nine projects.
- Independent visual finish verdict: ship, after correcting the import primary
  action, dark page token, grouped Agent dividers, semantic radii and intro overflow.
  See `.impeccable/review/production-onboarding-finish-review.md`.
- Browser fixture replay uses the actual production components with isolated fake
  account/Host boundaries. Desktop light/dark and narrow screenshots are in
  `.impeccable/review/production-onboarding/`. Replay confirmed that Import and
  continue starts the job, waits for successful completion and selects Global plus
  imported projects. Failure recovery is verified by rendered-component tests.

Integration limits: no unattended authorization of a real VibeX account, no bulk
installation/authentication of all 21 Agents, and no mutation of the user's actual
history. Native OS folder dialogs and repository cloning were tested at their
existing dialog/API seams; screenshots do not certify native service integration.
No new IPC schemas, generated types, database queries or SQLx metadata were added.

## Design documentation check

The independent documenter failed because its upstream stream disconnected; the
final comparison was completed inline using the shipped documenter role. No
changes to `DESIGN.md` or `.impeccable/design.json` were required or authorized.
Checked those files, `PRODUCT.md`, `frontend/CLAUDE.md`, the onboarding stylesheet,
production components and the refreshed screenshots against `reference/document.md`.

- Palette: existing opaque semantic neutral surfaces and user accent roles.
- Type: existing UI font stack and compact controls; retained welcome display art.
- Grouping: inset Agent group, spacing-separated siblings, optional detail column.
- Shape: shared radius token and existing raised control components.
- Rules: Two-Layer, Same-Hex, Tokens-Only and State-Only Accent remain authoritative.

Pre-existing drift was not canonized or repaired: the sidecar explicitly identifies
itself as a historical pre-Tahoe snapshot, and retained hero fluid typography is
not a new product-wide type rule. This task extends the incumbent system.
