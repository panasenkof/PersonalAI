import { sharePrivateFile } from '../share';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///private-cache/', EncodingType: { Base64: 'base64', UTF8: 'utf8' }, writeAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
beforeEach(() => { jest.clearAllMocks(); (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true); });

test('shares a ZIP through the system menu and removes the temporary private file', async () => {
  await sharePrivateFile('pia-account.zip', new Uint8Array([80, 75]), 'application/zip');
  const path = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls[0][0];
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(path, 'UEs=', { encoding: 'base64' });
  expect(Sharing.shareAsync).toHaveBeenCalledWith(path, expect.objectContaining({ mimeType: 'application/zip' }));
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(path, { idempotent: true });
});

test('cleans up a diagnostic file even when the share menu fails', async () => {
  (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error('cancelled'));
  await expect(sharePrivateFile('pia-diagnostics.json', '{}', 'application/json')).rejects.toThrow('cancelled');
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(expect.any(String), '{}', { encoding: 'utf8' });
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
});
