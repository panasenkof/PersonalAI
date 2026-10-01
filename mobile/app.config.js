// Release builds must explicitly target an HTTPS server and owned application IDs.
module.exports = ({ config }) => {
  const release = ['preview', 'production'].includes(process.env.EAS_BUILD_PROFILE);
  const endpoint = process.env.EXPO_PUBLIC_API_BASE;
  let validEndpoint = false;
  try {
    const url = new URL(endpoint);
    validEndpoint = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  } catch { /* show a useful error below */ }
  if (release && !validEndpoint) {
    throw new Error('Set EXPO_PUBLIC_API_BASE to your production HTTPS server before building.');
  }
  if (release && (!process.env.PIA_IOS_BUNDLE_ID || !process.env.PIA_ANDROID_PACKAGE)) {
    throw new Error('Set PIA_IOS_BUNDLE_ID and PIA_ANDROID_PACKAGE to your owned application identifiers.');
  }
  return {
    ...config,
    ios: { ...config.ios, ...(process.env.PIA_IOS_BUNDLE_ID ? { bundleIdentifier: process.env.PIA_IOS_BUNDLE_ID } : {}) },
    android: { ...config.android, ...(process.env.PIA_ANDROID_PACKAGE ? { package: process.env.PIA_ANDROID_PACKAGE } : {}) },
    extra: { ...config.extra, ...(endpoint ? { apiBase: endpoint } : {}) },
  };
};
