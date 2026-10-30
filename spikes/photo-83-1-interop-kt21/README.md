# №83.2: Java ABI interop compatibility gate (NOT production)

Producer: existing `spikes/photo-83-1-android/:probe` on Kotlin **2.4.21**
with the already tested MediaPipe / LiteRT-LM versions. One Java façade
delegates to its existing `UniversalVisionCompileProbe`; no second inference
writer or new user-data store. Consumer: an **independent** Android app
compiled with Kotlin **2.1.20**. Build in two separate Gradle processes:

```sh
gradle -p spikes/photo-83-1-android :probe:assembleDebug --no-daemon
gradle -p spikes/photo-83-1-interop-kt21 :consumer:assembleDebug --no-daemon
```

The consumer includes a local AAR, and puts the *same* pinned vendor
dependencies on its **runtimeOnly** classpath. Kotlin 2.1 must compile a
call to the Java façade without deserializing Kotlin 2.4 vendor metadata.
CI also inspects the façade's public ABI and checks the APK includes the
bridge. The consumer app has no launcher UI, uses no user data and requests
no Internet permission.

**Limits:** This is a compilation/packaging experiment, not successful
inference or a supported Expo build. It does NOT yet prove that Expo's Pika,
autolinking, Android runtime or universal embedding can execute in the
production APK. Never enable `mobile/modules/persai-vision` autolinking
or migrate SQLCipher until the real Expo consumer release build passes.
A Kotlin 2.4 global upgrade remains blocked by Pika
`0.3.2-2.4.21` (PR #259, exact-head CI failure).
