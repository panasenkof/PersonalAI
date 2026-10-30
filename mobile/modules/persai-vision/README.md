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

**Current guarded experiment:** a tiny `VisionProbeEngine.java` calls only
the Java-exposed MediaPipe API. The Expo Kotlin module calls its
`score(Context,String,Bitmap,String)` boundary rather than importing the
vendor API or parsing vendor Kotlin classes. This avoids globally raising
the Kotlin Gradle plugin for every app module. It still needs successful
exact-head Android compilation, APK smoke and a **separate on-device runtime**
test to establish that the transitive Kotlin runtime is compatible.

**Fail-safe:** if compilation or runtime still fails, disable/exclude the
experimental module before any default rollout; do not force Gradle resolution
to an older LiteRT version against the 1.1.0 API, do not silence metadata
errors, and do not update the whole Expo/RN Kotlin toolchain blindly.

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
