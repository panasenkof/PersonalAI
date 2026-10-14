// Release builds must use owned application IDs. PersAI has no server endpoint:
// the assistant talks directly to the model provider the user configures.
// Android release builds refuse plain http:// by default, which blocked local
// models (Ollama, LM Studio) on the home network. The app itself only allows
// http:// for private-network addresses (validateBaseUrl), so permitting
// cleartext at the OS level does not open public http:// connections.
const withLocalModelCleartext = (expoConfig) => require('expo/config-plugins').withAndroidManifest(expoConfig, mod => {
  const application = mod.modResults.manifest.application?.[0];
  if (application) application.$['android:usesCleartextTraffic'] = 'true';
  return mod;
});

module.exports = ({ config }) => {
  const androidCiRelease = process.env.PIA_ANDROID_RELEASE === 'true';
  const release = androidCiRelease || ['preview', 'production'].includes(process.env.EAS_BUILD_PROFILE);
  if (release && (!process.env.PIA_ANDROID_PACKAGE || (!androidCiRelease && !process.env.PIA_IOS_BUNDLE_ID))) {
    throw new Error(androidCiRelease
      ? 'Set PIA_ANDROID_PACKAGE to your owned Android package ID.'
      : 'Set PIA_IOS_BUNDLE_ID and PIA_ANDROID_PACKAGE to your owned application identifiers.');
  }
  const versionCodeRaw = process.env.PIA_ANDROID_VERSION_CODE;
  const versionCode = versionCodeRaw ? Number(versionCodeRaw) : undefined;
  if (versionCodeRaw && (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000)) {
    throw new Error('Invalid Android version code (positive integer required).');
  }
  return {
    ...config,
    plugins: [...(config.plugins || []), withLocalModelCleartext],
    ...(androidCiRelease && versionCode ? { version: `${config.version}-test.${versionCode}` } : {}),
    ios: { ...config.ios, ...(process.env.PIA_IOS_BUNDLE_ID ? { bundleIdentifier: process.env.PIA_IOS_BUNDLE_ID } : {}) },
    android: { ...config.android, softwareKeyboardLayoutMode: 'resize', ...(process.env.PIA_ANDROID_PACKAGE ? { package: process.env.PIA_ANDROID_PACKAGE } : {}), ...(versionCode ? { versionCode } : {}) },
    extra: { ...config.extra, ...(process.env.PIA_ANDROID_BUILD_SHA ? { buildSha: process.env.PIA_ANDROID_BUILD_SHA } : {}) },
  };
};
