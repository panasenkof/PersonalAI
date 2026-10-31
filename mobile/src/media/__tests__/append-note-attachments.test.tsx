import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppendNoteAttachments } from '../AppendNoteAttachments';
import { appendNoteAttachments } from '../attachments';
import { autoIndexNotePhotos83 } from '../auto-index-note-photos';
import { getDocumentAsync } from 'expo-document-picker';
const mockDelete = jest.fn(); let mockLock: (unlocked: boolean) => void;
jest.mock('../auto-index-note-photos', () => ({ autoIndexNotePhotos83: jest.fn() }));
jest.mock('../attachments', () => ({ appendNoteAttachments: jest.fn(), MAX_ORIGINALS_PER_NOTE: 10 }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/' }));
jest.mock('expo-file-system', () => ({ File: class { uri: string; exists = true; constructor(uri: string) { this.uri = uri; } delete() { mockDelete(this.uri); } } }));
jest.mock('../../security/native-interaction', () => ({ withNativeInteraction: (work: any) => work() }));
jest.mock('../../local-memory/storage', () => ({ onLocalMemorySessionChange: (cb: any) => { mockLock = cb; return jest.fn(); } }));
jest.mock('../../local-memory/errors', () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock('../../theme', () => ({ useTheme: () => ({}) }));
jest.mock('../../components/BottomSheet', () => ({ BottomSheet: ({visible, children}: any) => visible ? children : null }));
const asset = {uri:'file:///cache/doc.pdf', name:'doc.pdf', mimeType:'application/pdf', size:100};
const note: any = {id:'note', record_version:2, title:'Example'};
let props: any;
beforeEach(() => { jest.resetAllMocks(); props = {profile:'guest', note, disabled:false, onBusyChange:jest.fn(), onDraftChange:jest.fn(), onSaved:jest.fn()}; (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false, assets:[asset]}); (appendNoteAttachments as jest.Mock).mockResolvedValue({...note, record_version:3}); (autoIndexNotePhotos83 as jest.Mock).mockResolvedValue({indexed:0,current:0,pending:0,failed:0}); });
async function pick(screen: any) { fireEvent.press(screen.getByLabelText('Добавить файлы к заметке')); await waitFor(() => expect(screen.getByLabelText('Сохранить новые вложения')).toBeTruthy()); }
test('picker stages only; cancel cleans cache without saving', async () => { const s=render(<AppendNoteAttachments {...props}/>); await pick(s); expect(appendNoteAttachments).not.toHaveBeenCalled(); fireEvent.press(s.getByLabelText('Отменить добавление файлов')); expect(mockDelete).toHaveBeenCalledWith(asset.uri); expect(props.onDraftChange).toHaveBeenLastCalledWith(false); });
test('save updates parent once and clears staged originals', async () => { const s=render(<AppendNoteAttachments {...props}/>); await pick(s); fireEvent.press(s.getByLabelText('Сохранить новые вложения')); await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1)); expect(appendNoteAttachments).toHaveBeenCalledWith('guest','note',2,[asset],expect.anything()); expect(autoIndexNotePhotos83).toHaveBeenCalledWith('guest','note',expect.anything()); expect(mockDelete).toHaveBeenCalledWith(asset.uri); });
test('write failure retains staged selection for retry', async () => { (appendNoteAttachments as jest.Mock).mockRejectedValueOnce(new Error('disk full')); const s=render(<AppendNoteAttachments {...props}/>); await pick(s); fireEvent.press(s.getByLabelText('Сохранить новые вложения')); await waitFor(() => expect(s.getByText('disk full')).toBeTruthy()); expect(mockDelete).not.toHaveBeenCalled(); fireEvent.press(s.getByLabelText('Сохранить новые вложения')); await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1)); });
test('late picker after lock is discarded and cannot save', async () => { let resolve: any; (getDocumentAsync as jest.Mock).mockReturnValue(new Promise(r => { resolve=r; })); const s=render(<AppendNoteAttachments {...props}/>); fireEvent.press(s.getByLabelText('Добавить файлы к заметке')); act(() => mockLock(false)); await act(async () => resolve({canceled:false, assets:[asset]})); expect(mockDelete).toHaveBeenCalledWith(asset.uri); expect(appendNoteAttachments).not.toHaveBeenCalled(); expect(s.queryByLabelText('Сохранить новые вложения')).toBeNull(); });
test('dirty note cannot start picker', () => { const s=render(<AppendNoteAttachments {...props} disabled/>); fireEvent.press(s.getByLabelText('Добавить файлы к заметке')); expect(getDocumentAsync).not.toHaveBeenCalled(); });

test('an index failure after a committed append reports pending without claiming the save failed',async()=>{
  (autoIndexNotePhotos83 as jest.Mock).mockRejectedValueOnce(new Error('native image failure'));
  const s=render(<AppendNoteAttachments {...props}/>);
  await pick(s);fireEvent.press(s.getByLabelText('Сохранить новые вложения'));
  await waitFor(()=>expect(props.onSaved).toHaveBeenCalledTimes(1));
  expect(s.getByText(/оригиналы сохранены/)).toBeTruthy();
});
