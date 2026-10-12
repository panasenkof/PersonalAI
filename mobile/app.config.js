// Release builds must explicitly target an HTTPS server and owned application IDs.
module.exports = ({ config }) => {
  const androidCiRelease = process.env.PIA_ANDROID_RELEASE === 'true';
  const release = androidCiRelease || ['preview', 'production'].includes(process.env.EAS_BUILD_PROFILE);
  const endpoint = process.env.EXPO_PUBLIC_API_BASE;
  let validEndpoint = false;
  try {
    const url = new URL(endpoint);
    validEndpoint = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  } catch { /* show a useful error below */ }
  if (release && (!androidCiRelease || Boolean(endpoint)) && !validEndpoint) {
    throw new Error('Set EXPO_PUBLIC_API_BASE to your production HTTPS server before building.');
  }
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
    ...(androidCiRelease && versionCode ? { version: `${config.version}-test.${versionCode}` } : {}),
    ios: { ...config.ios, ...(process.env.PIA_IOS_BUNDLE_ID ? { bundleIdentifier: process.env.PIA_IOS_BUNDLE_ID } : {}) },
    android: { ...config.android, ...(process.env.PIA_ANDROID_PACKAGE ? { package: process.env.PIA_ANDROID_PACKAGE } : {}), ...(versionCode ? { versionCode } : {}) },
    extra: { ...config.extra, ...(androidCiRelease && !endpoint ? { apiBase: "" } : {}), ...(endpoint ? { apiBase: endpoint } : {}), ...(process.env.PIA_ANDROID_BUILD_SHA ? { buildSha: process.env.PIA_ANDROID_BUILD_SHA } : {}) },
  };
};
