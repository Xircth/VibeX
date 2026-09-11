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

## K-Dense scientific-agent-skills

VibeX's built-in "科学研究" (Scientific Research) plugin bundles Skill content
vendored byte-identically from K-Dense's scientific Agent Skills library.

- Project: K-Dense-AI/scientific-agent-skills
- Source: https://github.com/K-Dense-AI/scientific-agent-skills
- Commit: `9cf7d9aea7d84754db4c167ab04b299d33c444bc`
- Upstream version: `2.66.0`
- Copyright: Copyright (c) 2025 K-Dense Inc.
- Bundled: 146 of the upstream 163 Skills

The upstream library is license-heterogeneous: the repository's own MIT license
does not cover every Skill. VibeX verified each Skill's declared license when
vendoring and excluded 17 that cannot be redistributed (GPL, non-commercial,
proprietary, or undeclared). The bundled set is 99 MIT, 20 Apache-2.0,
19 BSD-3-Clause, 1 BSD-2-Clause, and 2 CC-BY-4.0.

- Per-Skill license verification and exclusion list: the plugin's `NOTICE.md`
- Full license texts: the plugin's `NOTICE.md`

## Hermes Agent brand icon

The Hermes Agent icon is adapted from the official desktop application icon.

- Project: NousResearch/hermes-agent
- Copyright: Copyright (c) 2025 Nous Research
- Source: https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/assets/icon.png
- License: MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
