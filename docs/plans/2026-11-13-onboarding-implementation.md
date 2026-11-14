# Production onboarding

The approved interaction reference is `frontend/src/components/onboarding/onboarding.prototype.html`.
The implementation uses the existing account web API, Agent management service,
native configuration controls, project service and history import job.

Acceptance:

- Welcome offers optional browser sign-in. The website approves the request after
  login; the desktop polls for the result. No VibeX verification-code UI.
- One Agent page combines a flat status list, installation, authentication and
  native configuration. All built-ins remain visible, including unsupported
  platforms. Details are initially closed. ACP Registry is available below.
- The shared AgentBar roster controls activation and order without checkboxes.
  Ready and unauthenticated Agents join automatically; only a fully passing
  preflight displays Ready. Every roster member is checked before continuing,
  unauthenticated Agents may continue, and the first icon is the default Agent.
  Reordering and dragging out preserve the user's choice across refreshes.
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

This and the intermediate refinement sections retain their original verification
records. The final section describes current layout and validation results.

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
- Grouping: flat Agent status list, shared AgentBar roster, optional detail column.
- Shape: shared radius token and existing raised control components.
- Rules: Two-Layer, Same-Hex, Tokens-Only and State-Only Accent remain authoritative.

Pre-existing drift was not canonized or repaired: the sidecar explicitly identifies
itself as a historical pre-Tahoe snapshot, and retained hero fluid typography is
not a new product-wide type rule. This task extends the incumbent system.

## Requested layout refinement

- Light onboarding uses the white shell surface with no hero glow. The welcome
  title has the requested two lines, with the centered account component above
  Skip/Next and the updated optional-login description.
- Agent selection has a Demo-style step trail, a flat full-width list while
  details are closed, and a 42:58 list/detail split when open. The gray detail panel
  aligns with the list at both edges; narrow windows show either list or details.
- The three relevant frontend test files passed all 17 tests. TypeScript,
  targeted ESLint, Prettier and diff whitespace checks passed.
- Nine fixture captures cover welcome/list/details at desktop, narrow and the
  supplied screenshot dimensions in `.impeccable/review/onboarding-layout/`.
  Independent visual review returned ship with no material fixes. The independent
  documentation comparison required no design-system changes.

## Agent status and roster refinement

- Added the centered VibeX Logo above the welcome title. Removed the Agent-page
  title, row borders, selection checkboxes and external editor control.
- Rows expose installation/authentication state and the corresponding action.
  Installation opens details immediately, streams progress, then refreshes the
  shared preflight and roster. Checking failures remain visible and retryable.
- The details panel reuses Settings ? Agent preflight items and configuration
  controls. Installed Agents require all reported checks to pass for Ready;
  missing authentication has its own state. Configuration warnings remain visible
  and are not promoted to Ready.
- The shared AgentBar supports reorder, pointer drag-out, keyboard removal and
  restoring removed Agents from details. The Next action persists only eligible
  roster members and requires acknowledgment of failed installations.
- Fixed asynchronous check ordering so the initial default stays first until the
  user changes the roster. Submission locks the controls while validating/saving.
- All onboarding and shared AgentBar tests passed (8 files, 53 current tests).
  Frontend TypeScript, targeted ESLint, Prettier and whitespace checks passed.
- Browser fixture confirmed pointer drag-out, restore and installation completion
  with production components and fake Host boundaries. Nine captures covering
  desktop, narrow and user-screenshot dimensions are in
  `.impeccable/review/onboarding-roster/`. Visual review disposition: ship after
  correcting Ready text contrast. Documentation comparison: no design-system changes.
- Real Agent installation/authentication was not performed as part of fixture QA.

## Agent page chrome reduction

- Removed the obsolete checkbox instruction; step navigation is the page focus
  target. List hover and selection use the shared 5% and 10% neutral washes with
  the element radius. The four statuses use icon Badges beside shared outline
  Buttons instead of custom text buttons.
- Removed the preflight title and section frame. Its controls and check items have
  explicit spacing inside the detail panel. Detail status uses the same derived
  status as the list. Authentication, configuration fields/files and environment
  sections retain their controls but shed their outer frames within onboarding.
- Empty rosters render the same empty AgentBar as populated rosters and omit the
  former empty-state prose. Removed the unused localization entries and styles.
- The 53 related tests pass. The installation test now checks matching list/detail
  status text. TypeScript and targeted ESLint pass. Browser evidence includes
  desktop, empty roster, narrow list/details and dark mode in
  `.impeccable/review/onboarding-agent-refinement/`; no horizontal overflow at
  390px. Independent visual disposition: ship. Configuration fields/files were
  checked in source because this fixture has no configuration field/file records.
- This is a local extension of existing tokens and shared components; no change
  to DESIGN.md or the design-system sidecar is needed.

## Agent list density and independent roster

- Removed the built-in label and Agent count. List rows leave space before the
  scrollbar; list and details align at the top. Both fill the remaining window
  height, with internal scrolling and no outer page scrollbar.
- The full-width roster lives outside the split grid, so opening/closing details
  does not resize it. Registry access follows it.
- List and detail statuses reuse OnboardingAgentStatusBadge, built on the shared
  Badge with a status icon and localized label.
- Only top-level settings surfaces and standalone configuration blocks lose
  their frames. Authentication's internal frame, model-provider settings
  surfaces, headings and controls retain their original styling.
- Environment supports an optional trailing toggle in AgentSectionHeading;
  onboarding places it after Add variable. Existing settings retain the leading
  toggle. aria-controls resolves to the environment body when expanded.
- 55 tests passed across 9 relevant files, including shared environment and bar
  regression tests. TypeScript and targeted ESLint passed. Browser evidence is in
  `.impeccable/review/onboarding-agent-layout/`: at 1440?1000, both panels measure
  600px high and the roster remains 560px before and after opening details.
  The restored auth inner border/padding, trailing toggle and narrow overflow
  were also checked. No design-system token or DESIGN.md changes are needed.

## Final status, authentication and viewport refinement

- Stable row statuses are Ready, Not installed, Authentication required and
  Installation failed. Missing dependencies or ACP components mean Not installed;
  only an actual failed installation produces Installation failed. Ready requires
  every preflight item to pass. Status badges sit beside the shared row buttons.
- The full-width white roster uses compact, fixed icon gaps and retains pagination.
  All roster members show their icon and name; pagination reserves every visible
  name's measured width, including during reordering. It omits the unused trailing
  action area. Its description sits beside the title.
- Preflight items and the embedded model-provider surface use the white shell
  token. Their widths align; authentication's internal subscription containers
  remain intact. Long installation logs cannot widen the details column.
- Startup onboarding now renders inside MainLegacyScope through
  StartupOverlayContext, sharing the route's design scope and modal host. Previously
  onboarding made the sibling route inert, which also made its authentication
  confirmation dialog inert. Cancel, close and confirm are now interactive while
  the underlying workspace stays inert. A rendered integration test covers this.
- Agent panels fill the space left after step navigation, roster, registry access
  and footer. Flex/grid minimum sizes allow internal scrolling without increasing
  page height. At widths up to 760px, details replace the list until closed.
- Browser fixture measurements at 1440x1000, 1280x720, 1984x1276 and 390x844
  confirm no outer vertical/horizontal overflow, equal desktop panel heights and
  visible roster/footer. At 1440x1000 the panels are about 648px high; at
  1984x1276 they grow to about 924px. Closing details restores the full-width list.
  Evidence is in `.impeccable/review/onboarding-final-polish/`.
- 112 tests passed across onboarding, shared AgentBar, environment/auth controls
  and app routes. Frontend TypeScript, targeted ESLint and formatting passed.
  Browser checks use production components with fake Host/account boundaries;
  they do not certify real external installation or authentication.
- These changes use existing design tokens/components and require no changes to
  DESIGN.md or the design-system sidecar.
- Independent visual review: ship, with no blocking findings across the four
  window sizes. Documentation comparison confirmed the final section covers the
  current status, roster, viewport and authentication-modal behavior.
