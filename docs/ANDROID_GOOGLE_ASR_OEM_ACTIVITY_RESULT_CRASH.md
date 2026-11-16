# Android Google ASR result crash — Vivo/Android 16 (16 Nov 2026)

## Reproduction and evidence

- Signed build `04bcefe517078ae059ddac97bf7007ba23d55701` (PR #555).
- On the home screen, tap the microphone, say `привет`, pause about two
  seconds, and the process terminates.
- `persai-android-crash-1794812233293.json` has a nonempty `java-stack-utf8`
  trace, proving PR #555's local Java crash capture works.
- Root exception on the Android main thread:
  `java.lang.IllegalArgumentException: Could not put 'class android.app.ActivityOptions$ActivityOptionsInjector' to WritableMap`
- Stack starts in Expo's `JSTypeConverterHelperKt.putGeneric`, through
  `JSTypeConverterProvider.convertToJSValue` and
  `expo.modules.intentlauncher.IntentLauncherModule`'s `OnActivityResult`.
  The system recognition Activity does return; its extras include an OEM
  `Class` value incompatible with Expo's generic JS bundle converter.

## Root cause and change

This is **not** evidence of a missing JNI or R8 class.
`mobile/src/media/android-voice-activity.ts` used
`expo-intent-launcher.startActivityAsync` to invoke
`android.speech.action.RECOGNIZE_SPEECH`. Expo's implementation copies
**the whole result Intent's extras** into a Bundle passed to JavaScript.
That fails on some Android 16 / Vivo vendor extras before the JS
`try/catch` can process the result.

Replace that one Google/system ASR Activity route (not Whisper, Gboard or
other generic intents) with `PersaiVoiceActivityModule`, an app-owned
Expo Kotlin module that uses Android `RecognizerIntent`, receives
`OnActivityResult`, reads **only** `EXTRA_RESULTS` as a string list,
and resolves a small JS map containing status + recognized string.
No raw `Intent`, `Bundle`, `Class`, full OEM extras, microphone
stream or audio ever crosses the Expo JS converter.

- The Android speech UI, language `ru-RU`, online/offline preference,
  max-results setting, existing explicit consent, draft append and manual
  send workflow remain unchanged.
- Cancellation returns `canceled`; empty text `empty`; absent module,
  malformed output and native Android result errors are handled as
  recoverable JS errors rather than crashing the process.
- Single pending recognition; no second ASR engine or independent event
  bus. Request code differs from generic intent-launcher's (12).
- The new native module is retained by the canonical R8 rules and checked
  in DEX APK audit; existing module auto-linking is used.
- No analytics, uploads, storage migration or new Android permission.

## Exact validation

1. Jest voice-Activity tests: recognized, canceled, empty, malformed,
   module unavailable and native failure; existing Google/Whisper tests.
2. TypeScript, Android Kotlin Gradle compilation, and R8 signed APK class
   audit including `PersaiVoiceActivityModule`; CI must be green.
3. **Physical Vivo acceptance remains required**: install new APK;
   Settings > Voice = Google/system, consent granted; open main microphone,
   say `привет` and pause 2–3 seconds; Android dialog must close, draft
   must contain `привет`, app must remain running, nothing sent until
   Send is tapped. Repeat 5 times, including cancel and silence.
4. Check Whisper mode unaffected, existing chat draft retained after
   cancellation, and no new Java crash entry at the test timestamp.

An emulator may not reproduce Vivo's OEM extra, so a green CI alone
does not certify physical-device acceptance.
