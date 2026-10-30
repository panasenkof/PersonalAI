# PersAI Android vision experiment — №83.1 (NOT production search)

Isolated Expo native module `PersaiVisionProbe`, using **MediaPipe Tasks Retrieval
1.1.0** and its built-in LiteRT-LM implementation. It is intentionally lazy:
neither the main app nor the SQLCipher search has a caller, and there is **no
model in the APK**. Native compilation alone is not a model inference PASS.

## Opt-in real-device/benchmark prerequisites

1. Use a *development* Android build supporting Expo native modules. Verify
   `com.google.mediapipe:tasks-retrieval:1.1.0` resolves and no Gradle/
   ExecuTorch ABI conflicts occur; confirm CPU/GPU delegate capabilities.
2. Obtain the licensed `EmbeddingGemma 2 Text-Vision 440M` LiteRT-LM bundle
   under the relevant model terms. Do not commit weights or private images.
   Verify the SHA-256 and record the source/revision used for the run.
3. Deliberately stage model at app-private
   `files/persai-vision-models/<name>.litertlm` and one *synthetic* JPEG/PNG
   at app-private `cache/persai-vision-probe/<name>.jpg`, e.g. through a
   development-only test harness. Neither path is a URL or an external
   gallery URI; never allow user-supplied paths to escape the sandbox.
4. Call the gated `runPhotoProbe83({modelName,modelSha256,imageName,query})`
   with an unlocked **test** profile. It hashes the model locally, bounds
   image size and dimensions, decodes into memory, creates the on-device
   embedder, embeds text/image and calculates a single cosine value. No
   photo, text, raw vector, or path is sent over the network or logged.
   AppLock is checked at dispatch; further lock-cancellation and 2-phase
   source checks remain required **before** production.
5. Record run timestamp, Android build, device/ABI, available RAM,
   startup and inference latency, peak RAM/temperature, GPU/CPU fallback,
   SHA/model revision, reference query and expected image label. Delete
   staged synthetic image and uninstall/test-clean the model if desired.

## Native ABI finding from CI #41068005020 (30 Oct 2026)

The pinned MediaPipe `tasks-retrieval:1.1.0` brings transitive
`litertlm-android:0.17.0-alpha1` built with Kotlin **2.4 metadata**.
Expo/RN's project Kotlin compiler accepts **2.1 metadata** in this build:
`persai-vision:compileReleaseKotlin` fails. This is a *real* reproducible
incompatibility; TypeScript/Jest green does not repair it.

**Second exact-head CI run #41069503073:** a small `VisionProbeEngine.java`
adapter did **not** resolve the mismatch: `persai-vision:compileReleaseKotlin`
still rejected the Kotlin 2.4 metadata. Because compilation fails before
the APK starts, **no inference, ABI, RAM or search-quality result exists**.

**Fail-safe now enforced:** `expo-module.config.json` has
`"platforms": []`, which excludes this experimental native module from
Expo's default Android autolinking. The code and pinned dependency remain
only as source for an independent **native Kotlin 2.4+ compatibility spike**,
not as an app feature. The JavaScript wrapper fails closed with
`vision_native_unavailable`. A regression test prevents silently switching
Android autolinking back on. Existing Expo/RN Kotlin 2.1 remains unchanged.

**Next real go/no-go:** create a standalone Android sample with compatible
Kotlin/AGP/Gradle, compile and run the actual 440M model on synthetic photos;
measure RAM and latencies. Only **after** that may a separate integration PR
propose verified toolchain compatibility with Expo. Do not force Gradle
resolution to older LiteRT against MediaPipe 1.1.0, suppress metadata errors,
or globally upgrade Kotlin without a separate full-stack compatibility review.

## Deliberate limitations

- A high cosine means visual similarity, **never confirmed identity** of a
  person/car. Two same-color models may look alike.
- Only one image and one query, no persisted vector index or original
  materialization, no multi-note search, no results UI, no automatic download,
  no background job, no OCR, no cross-user/file access.
- Actual inference on Android needs a suitable model staged manually and
  is **NOT VERIFIED** by Jest or ordinary native CI. The `setModelAssetPath`
  private absolute-path behavior requires device verification.
- If Gradle resolves but module initialization fails or RAM is too high,
  **do not add a fallback cloud upload**. Existing text FTS/MiniLM stays intact.
- Prior to 83.2 production: source ID, attachment fingerprint, revision and
  ACL must be rechecked on result use; vectors live in each profile's
  encrypted SQLCipher, not app-private debug caches.

References (checked 30.10.2026):
- https://developers.google.com/edge/mediapipe/solutions/retrieval/universal_embedder/android
- https://mvnrepository.com/artifact/com.google.mediapipe/tasks-retrieval/1.1.0
- `Plans/LOCAL_MULTIMODAL_AI.md` / `openspec/changes/photo-search-83-baseline/proposal.md`
