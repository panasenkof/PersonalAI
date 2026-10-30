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


## Vivo X200 Pro Android 16 — missing ActivationDataType (v0.1.3)

**Physical device result from Vision Lab v0.1.2:** at `embedder-create`,
Android reported `NoClassDefFoundError:
com.google.ai.edge.litertlm.ActivationDataType`. The model/image selectors
had worked. This is not evidence of invalid photo bytes or corrupt model
weights.

**Version-level finding:** `tasks-retrieval:1.1.0` selected transitive
`litertlm-android:0.17.0-alpha1`. Google AI Edge added the missing
`ActivationDataType` in September 2026 (see
[upstream change d667433](https://chromium.googlesource.com/external/github.com/google-ai-edge/LiteRT-LM/+/d667433118e4a1e6a0a6e18768a5d3abd29184e2)).
The released `litertlm-android:0.18.1` includes newer EmbeddingGemma 2
support plus a published v0.18.1 ABI fix. Version `0.18.1` is
**explicitly pinned ONLY in this standalone lab**. MediaPipe itself
remains at 1.1.0. The main Expo 57 app retains its Kotlin 2.1 toolchain
and disabled experimental MediaPipe autolinking.

**New exact-head CI gates:** compile the Kotlin 2.4 lab and JUnit tests,
resolve LiteRT-LM `0.18.1` on the consuming app runtime classpath,
load `ActivationDataType` in a JVM regression test, and inspect the
**final APK's DEX files** for its type descriptor; check no Internet
permission and publish `persai-vision-lab-android16-litertfix`.

**User action once CI passes:** remove **only** PersAI Vision Lab from
the phone before installing the new `app-debug.apk`, because GitHub
Actions debug signing keys can differ. This does not affect PersAI
(`com.persai.app`). Select the existing `.litertlm` file in Downloads,
then the same photo/query. Do not redownload model weights.

**Acceptance boundary:** this fixes a specific missing-class packaging
failure; it does *not* prove runtime compatibility between newer LiteRT-LM
and MediaPipe's internal APIs. Any next missing symbol or JNI failure
must be diagnosed on the device. Do not upgrade Kotlin or the MediaPipe
module in production, and do not claim visual search completed.

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
