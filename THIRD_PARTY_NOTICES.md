# Third-Party Notices

## GSAP

VibeX uses GSAP and its React integration to animate the onboarding
experience.

- Projects: GreenSock/GSAP and GreenSock/react
- Versions: GSAP `3.15.0`, @gsap/react `2.1.2`
- Sources: https://github.com/greensock/GSAP and
  https://github.com/greensock/react
- License: GreenSock Standard "No Charge" License
- License terms: https://gsap.com/standard-license

## Codeg

Portions of the Office watch lifecycle, delegation companion behavior, and
Automation scheduling behavior were adapted from Codeg at commit
`549add8d3ba07f31464c9cddde8ba7a7478eed14`.

- Upstream author metadata: `feitao`
- License: Apache License 2.0
- Source files and modifications:
  `docs/third-party/codeg-adoption.md`
- License text: `docs/third-party/licenses/Apache-2.0.txt`

## OfficeCLI

VibeX's built-in Office plugin downloads a version-locked OfficeCLI binary
from the upstream GitHub release and verifies its published SHA-256 before
execution. VibeX does not execute OfficeCLI's remote installation scripts.

- Project: iOfficeAI/OfficeCLI
- Version pinned by the bundled manifest: `v1.0.140`
- Source: https://github.com/iOfficeAI/OfficeCLI
- License: Apache License 2.0
- License text: `docs/third-party/licenses/Apache-2.0.txt`
