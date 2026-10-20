import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { IncomingShares, receiveShares } from '../IncomingShares';
import { saveMediaNote } from '../attachments';
import * as Sharing from 'expo-sharing';
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
let mockVisible = true;
let mockUnlocked = true;
jest.mock('../../profile/ProfileContext', () => ({ useProfile: () => 'guest' }));
jest.mock('../../security/visibility', () => ({ useApplicationVisible: () => mockVisible }));
jest.mock('../../local-memory/storage', () => ({ localMemorySessionUnlocked: () => mockUnlocked }));
jest.mock('../attachments', () => ({ saveMediaNote: jest.fn(async () => 'saved') }));
jest.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_a: string, s: string) => s }));
jest.mock('expo-file-system', () => ({ File: class { name = 'photo.jpg'; uri: string; constructor(value: string) { this.uri = value; } } }));
jest.mock('expo-sharing', () => ({ getSharedPayloads: jest.fn(() => []), clearSharedPayloads: jest.fn(), getResolvedSharedPayloadsAsync: jest.fn() }));
beforeEach(() => { jest.clearAllMocks(); mockVisible = mockUnlocked = true; Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true }); });
test('receives mixed media, URL and text locally, never resolves remote URL', async () => {
  await receiveShares('guest', [{ shareType: 'image', value: 'content://photo', mimeType: 'image/jpeg' }, { shareType: 'url', value: 'https://example.org/private' }, { shareType: 'text', value: 'Заметка' }]);
  expect(saveMediaNote).toHaveBeenCalledTimes(3);
  expect(saveMediaNote).toHaveBeenNthCalledWith(2, 'guest', expect.objectContaining({ body: 'https://example.org/private', sensitivity: 'sensitive', file: undefined }), undefined);
  expect(Sharing.getResolvedSharedPayloadsAsync).not.toHaveBeenCalled();
});
test('defers while locked, clears only after successful save and opens saved note', async () => {
  (Sharing.getSharedPayloads as jest.Mock).mockReturnValue([{ shareType: 'text', value: 'Заметка' }]);
  mockVisible = false; mockUnlocked = false;
  const open = jest.fn(); const screen = render(<IncomingShares open={open} />);
  expect(saveMediaNote).not.toHaveBeenCalled();
  mockVisible = mockUnlocked = true; screen.rerender(<IncomingShares open={open} />);
  await waitFor(() => expect(Sharing.clearSharedPayloads).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByText('Открыть запись')); expect(open).toHaveBeenCalledWith('saved');
});
test('failed group is retained for retry and does not claim success', async () => {
  (Sharing.getSharedPayloads as jest.Mock).mockReturnValue([{ shareType: 'text', value: 'Заметка' }]);
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error('disk_full'));
  const screen = render(<IncomingShares open={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(/Приём не завершён/)).toBeTruthy());
  expect(Sharing.clearSharedPayloads).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Повторить приём'));
  await waitFor(() => expect(Sharing.clearSharedPayloads).toHaveBeenCalledTimes(1));
});

test('native errors reveal only a stage code, retain payload and respect status bar', async () => {
  (Sharing.getSharedPayloads as jest.Mock).mockReturnValue([{ shareType: 'image', value: 'content://private/photo', mimeType: 'image/jpeg' }]);
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error('SQL INSERT secret content://private/photo'));
  const screen = render(<IncomingShares open={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(/SHARE-SAVE-MEDIA/)).toBeTruthy());
  expect(screen.queryByText(/secret/)).toBeNull();
  expect(Sharing.clearSharedPayloads).not.toHaveBeenCalled();
  expect(screen.getByTestId('incoming-share-notice').props.style.paddingTop).toBe(32);
  fireEvent.press(screen.getByText('Скрыть'));
  expect(screen.queryByTestId('incoming-share-notice')).toBeNull();
  expect(Sharing.clearSharedPayloads).not.toHaveBeenCalled();
});
