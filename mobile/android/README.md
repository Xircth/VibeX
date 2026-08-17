# VibeX Companion (Android)

Android is a Companion Device. It pairs with the Host using the `companion`
preset and never runs Agent, Git, or plugins.

Pairing:

1. On the Host, start Remote Protocol and create a pairing with
   `{ "preset": "companion" }`.
2. Enter the Host origin and one-time pairing token in the app.
3. Store the device credential in Android Keystore.

The wire models live in
`docs/protocol/v1/generated/kotlin/RemoteProtocolModels.kt`.
Host authorization still uses the Companion scope set from ADR-0054.

This directory is the product home for the Kotlin/Compose app. The protocol
contract is already tested in `crates/remote-protocol` and
`crates/server` pairing tests.
