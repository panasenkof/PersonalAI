# PersAI launcher / splash — approved asset contract (23.10.2026)

All exported mobile icon artwork is based exclusively on \`REF-ICON-A.png\` within the immutable, SHA-256-verified \`docs/design/references/PersAI_Nebula_Approved_References.zip\`. This is NOT the smaller in-app animated \`REF-ORB-B\` and not the retired light mark \`brand/persai-approved-light.png\`.

\`mobile/scripts/generate-brand.cjs\` runs automatically when Expo loads \`mobile/app.config.js\` (and can be run manually after \`npm ci\`). It regenerates these deterministic, derived PNGs:
- \`assets/icon.png\` — 1024×1024 full-colour brand (Android legacy, iOS, internal static artwork).
- \`assets/adaptive-icon.png\` — approved artwork centered within a transparent Android safe zone.
- \`assets/monochrome-icon.png\` — white themed glyph/alpha based on the luminous nebula, Android 13+.
- \`assets/splash.png\` — approved full-colour image on a dark navy splash background.

The existing tracked PNGs are fallbacks for direct source/test browsing; **they are overwritten from the approved original during every native and Expo build**. Never hand-edit them, and do not revert to the retired light icon generator. GitHub PR CI must execute \`node --test scripts/approved-brand.test.cjs\` and native prebuild. For the release APK, inspect app drawer, legacy launcher, circle/squircle masks, light/dark and themed Android launcher, and splash screen. CI proof of source hashes and PNG geometry does not replace a physical launcher check.

Do not change Android package ID, signing key, storage, in-app Skia orb or generated icons in unrelated UI PRs.
