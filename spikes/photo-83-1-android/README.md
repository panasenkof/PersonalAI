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


## Vivo X200 Pro / Android 16: multi-photo ranking experiment (v0.1.4)

The real-device user confirmed: first photo = **red bicycle near a tree**
(relevant, cosine 0.7686); second photo = **completely unrelated**
(irrelevant, cosine 0.5397). One correctly ordered relevant/irrelevant pair
is a useful smoke test, **not a proven Recall@K or general precision
estimate**. We must test harder and multiple negatives before production.

This incremental version adds 2–5-photo *text→image ranking* to the **same
isolated APK / same UniversalEmbedder**. It does not modify main PersAI,
create an image index or persist user photos/vectors.

1. Install the GitHub Actions artifact named
   `persai-vision-lab-android16-ranking` from the passing exact-head
   **Vision SDK compile spike (isolated)** run. Uninstall **only Vision
   Lab** first if the ephemeral CI debug signing certificate differs.
   Application ID stays `com.persai.visionlab` (never `com.persai.app`).
2. Import the **same already downloaded** .litertlm model; do not redownload.
3. Enter one plain Russian query, e.g. `красный велосипед возле дерева`.
4. Tap **4. Добавить фото в тестовый набор** 2–5 times. Select photos
   individually, in an order you can recognize. Photo #1 means first
   picked, #2 second picked, etc. Mix a matching image, an unrelated
   image, and at least one **hard negative** (another bicycle or a similar
   red object). No need to send personal photos to the developer.
5. Tap **5. Найти наиболее подходящее фото**. The lab computes text
   embedding once, decodes/recycles images sequentially, returns sorted
   numbers `Фото №N`, scores, elapsed time and before/after PSS.
6. Compare ranked photo numbers with the photos you selected. Report
   the ranking and whether the correct photo came first. Repeat with
   other objects if desired. **There is no threshold/probability or
   confirmation of a specific person's/item's identity.**

JUnit tests use the user-labeled 0.7686 vs 0.5397 pair to validate sort
order, negative scores, tie handling, 2–5 bounds and invalid NaN
rejection. This checks code behavior only; actual 2–5-photo inference
still requires Vivo testing and photo→photo is a later, distinct gate.

## Vivo X200 Pro / Android 16: LiteRT-LM class linkage fix attempt (v0.1.3)

The user's third real Android 16 screenshot now identifies the exact blocker:
`Stage: embedder-create`, missing Java class
`com.google.ai.edge.litertlm.ActivationDataType`.

This is **a runtime class-resolution error**, not a failure in image
downsampling or evidence that the user's model/download is corrupt.
MediaPipe `tasks-retrieval:1.1.0` originally resolved the pre-release
`litertlm-android:0.17.0-alpha1`. Google LiteRT-LM's current public Kotlin
API defines the `ActivationDataType` enum and publishes stable
`litertlm-android:0.18.0`. The standalone lab therefore pins 0.18.0 as
an explicit **test-only** dependency, allowing Gradle to select it instead
of the older transitive alpha.

The isolated CI must build the APK, verify no INTERNET permission, and
**inspect the resolved 0.18.0 AAR** to confirm that
`ActivationDataType.class` is actually present before publishing
`persai-vision-lab-android16-litertlm018`. A successful compile/class
check does not prove binary compatibility of every MediaPipe call or that
the model will load on the Vivo. Real inference is still a device gate.
The existing error-stage diagnostic remains in this version for any
subsequent class/linkage failure. This test does **not** change Expo
Kotlin, PersAI memory/search, default app or the external model bytes.

The lab keeps application id `com.persai.visionlab`. Since CI debug
APK signatures may change, uninstall **only PersAI Vision Lab** when
installing this version. Reselect the existing original .litertlm file
in Downloads (the app-private imported copy is deleted by uninstall);
redownloading the 388 MB model is unnecessary.

## Vivo X200 Pro / Android 16: runtime class linkage diagnostic (v0.1.2)

The user's **second** real device attempt passed image decoding but displayed
`NoClassDefFoundError`. This exception means Android cannot resolve a
required Java class (or a transitive class failed to initialize); its
**exact class name is missing from the v0.1.1 UI**, so it is not yet
possible to safely select a particular dependency fix. This is **not proof**
of a corrupt .litertlm model, so do not ask the user to redownload the
model or replace the photo.

This narrow step:

- Adds an allowlisted error stage around model options, engine creation,
  text/image embedding and cosine calculation, to identify where the SDK fails.
- Extracts only missing Java class identifiers from `NoClassDefFoundError`
  or nested `ClassNotFoundException` and prints them in the lab UI. It
  suppresses other raw messages that could contain photos, SAF URIs,
  model file paths or user text. Unit tests cover both class resolution
  styles and privacy sanitization.
- Records the packaged ARM64 native libraries and selected Gradle runtime
  dependencies in the isolated CI summary; this is build-time data, not
  user-device telemetry. Neither source photos nor model weights are sent.
- Ships artifact `persai-vision-lab-android16-diagnostic`, version `0.1.2`;
  the main PersAI app and Kotlin 2.1 toolchain stay untouched.
- As previous debug APKs were signed with ephemeral CI keys, remove
  **only PersAI Vision Lab** before installing this new diagnostic build.
  Reselect the already downloaded model and the original test photo.
  The copied model inside the lab is removed by uninstall; the original
  in Downloads stays on the phone.

**Stop condition:** once the actual missing class and stage are visible,
fix only its verified packaging/runtime dependency in a subsequent small PR.
Do **not** invent model-support claims or disable a missing-class error to
force a green result.

## Vivo X200 Pro / Android 16: fixed image decode (v0.1.1)

The first on-device run exposed `ArithmeticException` when tapping
"Проверить сходство локально". Root cause in `MainActivity.decodeBoundedImage`:
`BitmapFactory.Options.inSampleSize` was used as an integer divisor before
being initialized. The Android decoder treats `0` as `1`, **Kotlin division
does not**. This occurred before any MediaPipe call, so it was not evidence
of invalid model weights or a broken image.

The fix initializes sampling at **1**, computes safe downsampling using
`ImageSampling.factor`, and includes real JUnit cases for small/large and
invalid dimensions. The standalone CI runs those tests before producing
`persai-vision-lab-android16-fixed`.

**Installation after the first APK:** CI-created debug APKs are signed with
runner-specific ephemeral debug certificates. A direct APK upgrade may fail
with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signatures differ). Uninstall
**only PersAI Vision Lab**, not PersAI; then install the corrected lab. This
erases only the lab's private imported model copy. The original model
downloaded in the phone's Downloads directory is unaffected: simply select
the existing `.litertlm` again, along with the same test photo. No need to
download model weights again. The corrected APK's application id is still
`com.persai.visionlab` (not `com.persai.app`).

**Acceptance boundary:** passing CI means sample sizing is tested and the
offline APK is built. Real model runtime still needs re-checking on Vivo
X200 Pro; never claim inference works based on a unit test.

## №83.1 · Vivo X200 Pro / Android 16 lab application

The separate `:app` module builds an **installable offline debug APK** with
application ID `com.persai.visionlab` and label **PersAI Vision Lab**.
It does not replace `com.persai.app` and does not read the PersAI database,
gallery or chat history automatically. The main app's Kotlin toolchain and
dependencies are unchanged.

The APK targets Android 15+ APIs and runs on Android 16/ARM64; inference is
tested only after installation on the actual Vivo X200 Pro. The model is
**not bundled** in the APK, making the APK considerably smaller than a
distribution containing 388–798 MB of weights. The app has **no Internet
permission**, which is checked on the final APK by CI.

### Using the lab on the phone

1. Open [the PR's **Vision SDK compile spike (isolated)** GitHub Action](https://github.com/panasenkof/PersonalAI/actions/workflows/vision-sdk-compile.yml) and download the artifact
   `persai-vision-lab-android16` **only after the exact-head workflow passes**.
   Extract the ZIP to get `app-debug.apk`. GitHub artifacts expire after
   14 days. As a debug build, this is only for a controlled experiment;
   do not distribute it as a production APK.
2. Obtain the CPU/GPU LiteRT model (388 MB) from the
   [LiteRT Community Text-Vision 440M files](https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm/tree/main):
   `embeddinggemma-2-text-vision-440m.litertlm`. Review the model card and
   redistribution terms on the source page. Do **not** choose 740M audio or
   the 270M text-only variant. There is also a
   `embeddinggemma-2-text-vision-440m_MediaTek_MT6991.litertlm`
   (~798 MB) for MediaTek MT6991 (Dimensity 9400), but start with the
   generic 388 MB model for comparable CPU/GPU baseline.
3. Install `app-debug.apk` on the Vivo X200 Pro (Android 16), allowing
   installation from the chosen file manager only when Android prompts.
   It appears as **PersAI Vision Lab**, separate from PersAI.
4. In the lab tap **Выбрать модель** and choose the downloaded
   `.litertlm` file. The model is copied once into the app-private directory
   with a streaming SHA-256 digest; the displayed prefix is diagnostic
   provenance, **not** independent verification of the source.
5. Tap **Выбрать фотографию**, select a non-sensitive photo with a
   recognizable object (e.g. a bicycle next to a tree), enter a Russian
   query, then tap **Проверить сходство локально**. For a negative
   comparison, repeat with an unrelated photo. The app only displays a
   cosine score, elapsed cold-call time and **before/after PSS**;
   it does not claim recall or peak memory measurements.
6. Report whether the model loaded, the two scores, load+inference
   time, and whether the device felt hot. No need to upload personal photos
   or send private model bytes to the project.

**Resource budget:** leave at least 2 GiB of free phone storage for the
model import and runtime files; prefer running the test with other heavy AI
apps closed. This is a conservative workspace recommendation, not a
measured device requirement. No continuous indexing is started.

### C0 / C3-B gate

- No new SQLCipher table, persistent photo vector index, user-facing photo
  search route, full app Kotlin migration, original byte copier or cloud
  pipeline. The existing `UniversalVisionCompileProbe` performs the one
  explicit local text-image cosine comparison.
- Only a user-selected image URI is decoded in memory, resized for bounded
  inference and recycled. No original photo is copied into the app. Model
  stays private to the lab and is removed by uninstalling the lab/clearing data.
- The app has no INTERNET permission or network code; CI inspects the built
  APK manifest and fails if the permission is present. A developer must not
  use model downloads in the standard CI.
- **Build success != runtime success.** The real Vivo Android 16 test and
  memory/quality measurements remain pending until carried out on the phone.
- If the SDK crashes, use the lab only and do not enable the quarantined
  `mobile/modules/persai-vision` in the main PersAI APK.
