# VibeX Companion (iOS)

iOS is a Companion Device. It pairs with the Host using the `companion` preset and never runs Agent, Git, or plugins. See ADR-0084 and `docs/plans/2026-11-06-ios-companion.md`.

Wire models come from `docs/protocol/v1/generated/swift/RemoteProtocolModels.swift`, linked into `Sources/CompanionCore`. Do not copy or edit a second protocol copy.

```bash
# pairing client and scope tests; needs a Swift 6 toolchain
swift test
```
