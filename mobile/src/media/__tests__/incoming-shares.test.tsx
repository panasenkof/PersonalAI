import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { IncomingShares, receiveShares } from '../IncomingShares';
import { saveMediaNote } from '../attachments';
import * as Sharing from 'expo-sharing';
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
const mockDelete = jest.fn();
const mockCopy = jest.fn(async (_options: unknown) => {});
jest.mock('expo-file-system/legacy', () => ({ copyAsync: (options: unknown) => mockCopy(options) }));
let mockVisible = true;
let mockUnlocked = true;
jest.mock('../../profile/ProfileContext', () => ({ useProfile: () => 'guest' }));
jest.mock('../../security/visibility', () => ({ useApplicationVisible: () => mockVisible }));
jest.mock('../../local-memory/storage', () => ({ localMemorySessionUnlocked: () => mockUnlocked }));
jest.mock('../vector-runner', () => ({ scheduleVectors: jest.fn() }));
jest.mock('../attachments', () => ({ saveMediaNote: jest.fn(async () => 'saved') }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'temporary-id', CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_a: string, s: string) => s }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class { uri = 'file:///cache/persai-incoming'; create() {} },
  File: class {
    name = 'photo.jpg'; uri: string; exists = true;
    constructor(value: string | { uri: string }, name?: string) { this.uri = typeof value === 'string' ? value : value.uri + '/' + name; }
    delete() { mockDelete(this.uri); }
  },
}));
jest.mock('expo-sharing', () => ({ getSharedPayloads: jest.fn(() => []), clearSharedPayloads: jest.fn(), getResolvedSharedPayloadsAsync: jest.fn() }));
beforeEach(() => { jest.clearAllMocks(); mockVisible = mockUnlocked = true; Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true }); });
test('receives mixed media, URL and text locally, never resolves remote URL', async () => {
  await receiveShares('guest', [{ shareType: 'image', value: 'content://photo', mimeType: 'image/jpeg' }, { shareType: 'url', value: 'https://example.org/private' }, { shareType: 'text', value: 'Заметка' }]);
  expect(saveMediaNote).toHaveBeenCalledTimes(3);
  expect(saveMediaNote).toHaveBeenNthCalledWith(2, 'guest', expect.objectContaining({ body: 'https://example.org/private', sensitivity: 'sensitive', file: undefined }), undefined);
  expect(Sharing.getResolvedSharedPayloadsAsync).not.toHaveBeenCalled();
});
test('opens a draft only after unlock, without saving or a banner', async () => {
  const payloads = [{ shareType: 'text', value: 'Заметка' }];
  (Sharing.getSharedPayloads as jest.Mock).mockReturnValue(payloads);
  mockVisible = false; mockUnlocked = false;
  const open = jest.fn(() => true); const screen = render(<IncomingShares open={open} />);
  expect(open).not.toHaveBeenCalled();
  mockVisible = mockUnlocked = true; screen.rerender(<IncomingShares open={open} />);
  await waitFor(() => expect(open).toHaveBeenCalledWith(payloads));
  expect(Sharing.clearSharedPayloads).toHaveBeenCalledTimes(1);
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(screen.toJSON()).toBeNull();
});
test('keeps intent until navigation is ready', () => {
  (Sharing.getSharedPayloads as jest.Mock).mockReturnValue([{ shareType: 'text', value: 'Заметка' }]);
  const screen = render(<IncomingShares open={() => false} />);
  expect(Sharing.clearSharedPayloads).not.toHaveBeenCalled();
  screen.unmount();
});

test('copies generic Gallery URI before saving and removes temporary photo', async () => {
  await receiveShares('guest', [{ shareType: 'image', value: 'content://media/external/images/media/123', mimeType: 'image/jpeg' }]);
  expect(mockCopy).toHaveBeenCalledWith({ from: 'content://media/external/images/media/123', to: 'file:///cache/persai-incoming/temporary-id' });
  expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ file: { uri: 'file:///cache/persai-incoming/temporary-id', name: 'photo.jpg', mimeType: 'image/jpeg' } }), undefined);
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/persai-incoming/temporary-id');
});
test('failed Gallery copy is cleaned up and never saved', async () => {
  mockCopy.mockRejectedValueOnce(new Error('private content URI failure'));
  await expect(receiveShares('guest', [{ shareType: 'image', value: 'content://media/123', mimeType: 'image/jpeg' }])).rejects.toThrow('SHARE-COPY');
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalled();
});
