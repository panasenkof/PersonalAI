/**
 * Regression: camera imports must not remove the permission required by
 * Whisper and system speech recognition in the resulting Android APK.
 *
 * Expo image-picker with microphonePermission: false adds a manifest
 * permission block; this silently removes the Android microphone settings UI.
 */
const config = require('../../app.json') as {
  expo: {
    plugins: Array<string | [string, Record<string, unknown>]>;
    android?: { permissions?: string[]; blockedPermissions?: string[] };
  };
};

function optionsFor(id: string): Record<string, unknown> | null {
  const item = config.expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === id);
  return Array.isArray(item) ? item[1] : null;
}

test('Android microphone remains enabled alongside the camera image-picker plugin', () => {
  const imagePicker = optionsFor('expo-image-picker');
  const speech = optionsFor('expo-speech-recognition');
  expect(imagePicker).not.toBeNull();
  expect(imagePicker?.microphonePermission).not.toBe(false);
  expect(speech).not.toBeNull();
  expect(speech?.microphonePermission).toEqual(expect.any(String));
  expect(config.expo.android?.permissions).toContain('android.permission.RECORD_AUDIO');
  expect(config.expo.android?.blockedPermissions || []).not.toContain('android.permission.RECORD_AUDIO');
});
