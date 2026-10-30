# №83.1 — independent Kotlin 2.4 MediaPipe SDK compile spike

This project is deliberately separate from `mobile/`. It never autolinks
into Expo, does not share Gradle settings with PersAI and contains no user
photos, model weights, SQLCipher data or server credentials.

## Why separate?

PR #248's real Android build demonstrated that MediaPipe Tasks Retrieval
`1.1.0` pulls LiteRT-LM `0.17.0-alpha1` with Kotlin metadata `2.4`.
PersAI's current Kotlin compiler `2.1` rejects it. Even moving calls into
a Java adapter does **not** work: vendor metadata is on the classpath.
This project tests a deliberately scoped solution without a broad app upgrade.

## Reproduce

Use Java 17 + Android SDK platform 35 + Gradle 8.13. The standalone
Gradle project pins AGP `8.13.0`, KGP `2.4.21`, MediaPipe
`tasks-retrieval:1.1.0` and contains a Kotlin function that uses
`embedText`, `embedImage`, and cosine similarity via the official API.

Run at the repo root:

```bash
gradle -p spikes/photo-83-1-android :probe:compileDebugKotlin :probe:assembleDebug --no-daemon
```

The **Vision SDK compile spike (isolated)** GitHub workflow also runs this
check on PR changes; it does not run the mobile app's native build.

## Pass/fail

- `PASS` means only that a pinned native SDK API can compile with this
  standalone toolchain on a CI runner.
- `FAIL` means inspect Kotlin/Gradle/SDK API versions **inside this spike**
  before touching PersAI.
- `PASS` does NOT mean compatible with Expo/RN, that the downloaded model
  loads on Android, or that Russian visual retrieval quality is acceptable.
- No cloud inference fallback, no model download, no automatic production
  switch and no mixed vector spaces.
- After a compile PASS the next real gate requires a separately provisioned
  licensed 440M `.litertlm` and synthetic photo(s) on a real Android device,
  with latency, memory, Recall@K and negative same-color vehicle pairs.
- Back in PersAI, `mobile/modules/persai-vision/expo-module.config.json`
  must remain disabled (`platforms: []`) until a **separate** Expo-compatible
  integration build is proven end to end.

References:
- https://kotlinlang.org/docs/gradle-configure-project.html
- https://developers.google.com/edge/mediapipe/solutions/retrieval/universal_embedder/android
- https://github.com/google-ai-edge/LiteRT-LM/issues/3753
