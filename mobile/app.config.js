// Release builds must use owned application IDs. PersAI has no server endpoint:
// the assistant talks directly to the model provider the user configures.
// Android release builds refuse plain http:// by default, which blocked local
// models (Ollama, LM Studio) on the home network. The app itself only allows
// http:// for private-network addresses (validateBaseUrl), so permitting
// cleartext at the OS level does not open public http:// connections.
// Android application identity is permanent: changing it detaches the user's
// encrypted on-device database from future upgrades.
const PERSAI_ANDROID_PACKAGE = 'com.persai.app';

const withTesseractMaven = (expoConfig) => require('expo/config-plugins').withProjectBuildGradle(expoConfig, mod => {
  // One vetted JitPack dependency. No other repository or binary is fetched
  // at run time; language model is user-downloaded and SHA256 pinned.
  const source = mod.modResults.contents;
  if (!source.includes("https://jitpack.io")) {
    mod.modResults.contents += "\nallprojects { repositories { maven { url 'https://jitpack.io' } } }\n";
  }
  return mod;
});
const withLocalModelCleartext = (expoConfig) => require('expo/config-plugins').withAndroidManifest(expoConfig, mod => {
  const application = mod.modResults.manifest.application?.[0];
  if (application) application.$['android:usesCleartextTraffic'] = 'true';
  return mod;
});

module.exports = ({ config }) => {
  // Generate native and JS artwork from the exact approved REF-ICON-A on every Expo build.
  if (typeof require === 'function') require('./scripts/generate-brand.cjs').buildApprovedBrand();
  const androidCiRelease = process.env.PIA_ANDROID_RELEASE === 'true';
  const release = androidCiRelease || ['preview', 'production'].includes(process.env.EAS_BUILD_PROFILE);
  // The former Actions variable is only a compatibility input. Never let it
  // silently replace the published package, even in a local preview build.
  if (process.env.PIA_ANDROID_PACKAGE && process.env.PIA_ANDROID_PACKAGE !== PERSAI_ANDROID_PACKAGE) {
    throw new Error('PIA_ANDROID_PACKAGE must be ' + PERSAI_ANDROID_PACKAGE + '; changing it would create a different Android app.');
  }
  if (release && !androidCiRelease && !process.env.PIA_IOS_BUNDLE_ID) {
    throw new Error('Set PIA_IOS_BUNDLE_ID for an owned iOS application identifier.');
  }
  // One app-owned Telegram API identity for all PersAI installations.
  // Release CI injects these from GitHub Secrets only. Never commit their values.
  // Like any credential packaged into a mobile client, the hash is extractable
  // from the APK; Secrets prevent source/log disclosure, not reverse engineering.
  const telegramId = (process.env.PERSAI_TELEGRAM_API_ID || '').trim();
  const telegramHash = (process.env.PERSAI_TELEGRAM_API_HASH || '').trim();
  const telegramProvided = telegramId !== '' || telegramHash !== '';
  if (telegramProvided && (
    !/^[1-9][0-9]{0,9}$/.test(telegramId) ||
    Number(telegramId) > 2147483647 ||
    !/^[0-9a-fA-F]{32}$/.test(telegramHash)
  )) {
    throw new Error('Set BOTH valid PERSAI_TELEGRAM_API_ID and PERSAI_TELEGRAM_API_HASH or neither.');
  }
  // Ordinary published APKs deliberately omit the shared identity: TDLib
  // is not embedded in those builds. Include it only when an explicitly
  // reviewed TDLib APK is staged, or in a developer build.
  const includeTelegram = telegramProvided &&
    (!androidCiRelease || process.env.TDLIB_EXPLICIT_STAGE === 'true');
  const bundledTelegram = includeTelegram
    ? { apiId: Number(telegramId), apiHash: telegramHash.toLowerCase() } : undefined;
  const versionCodeRaw = process.env.PIA_ANDROID_VERSION_CODE;
  const versionCode = versionCodeRaw ? Number(versionCodeRaw) : undefined;
  if (versionCodeRaw && (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000)) {
    throw new Error('Invalid Android version code (positive integer required).');
  }
  return {
    ...config,
    plugins: [...(config.plugins || []), withLocalModelCleartext, withTesseractMaven],
    ...(androidCiRelease && versionCode ? { version: `${config.version}-test.${versionCode}` } : {}),
    ios: { ...config.ios, ...(process.env.PIA_IOS_BUNDLE_ID ? { bundleIdentifier: process.env.PIA_IOS_BUNDLE_ID } : {}) },
    android: { ...config.android, package: PERSAI_ANDROID_PACKAGE, softwareKeyboardLayoutMode: 'resize', ...(versionCode ? { versionCode } : {}) },
    extra: { ...config.extra, ...(process.env.PIA_ANDROID_BUILD_SHA ? { buildSha: process.env.PIA_ANDROID_BUILD_SHA } : {}), ...(bundledTelegram ? { persaiTelegramApi: bundledTelegram } : {}) },
  };
};
