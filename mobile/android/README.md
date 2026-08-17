# VibeX Companion (Android)

Android is a Companion Device. It pairs with the Host using the `companion`
preset and never runs Agent, Git, or plugins.

## Pairing

1. On the Host, start Remote Protocol and create a pairing with
   `{ "preset": "companion" }`.
2. Enter the Host origin and one-time pairing token in the app.
3. `companion-core` redeems `POST /api/v1/auth/pairings/redeem`, refuses any
   scope outside the Companion allowlist, then checks
   `GET /api/v1/capabilities`.
4. Store the device credential in Android Keystore.

Wire models come from `docs/protocol/v1/generated/kotlin/RemoteProtocolModels.kt`.
Do not hand-edit a second protocol copy.

## Layout

- `companion-core` — JVM pairing client. Compiles with a JDK; no Android SDK.
- `app` — Jetpack Compose shell that calls `companion-core`.

```bash
# pairing client and scope tests; needs JDK 17
./gradlew :companion-core:test

# full APK; needs Android SDK
./gradlew :app:assembleDebug
```

If this tree has no Gradle wrapper yet, generate one with Gradle 8.11+ or run
the same tasks from Android Studio.
