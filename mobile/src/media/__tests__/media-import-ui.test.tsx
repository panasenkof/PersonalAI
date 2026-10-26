import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { MemoryImportScreen } from '../../screens/MemoryImportScreen';
import { saveMediaNote } from '../attachments';
import { extractMedia } from '../extract';
import { importLink } from '../link-import';
import { analyzeFilesTogether } from '../joint-recognition';
import * as DocumentPicker from 'expo-document-picker';
jest.mock('../../components/BottomSheet', () => ({ BottomSheet: ({ visible, children }: any) => visible ? children : null }));
const mockBack = jest.fn();
let mockParams: any = undefined;
jest.mock("../preferences", () => ({ loadMediaPreferences: async () => ({ visionId: "", speechId: "" }) }));
jest.mock('../link-import', () => ({ importLink: jest.fn(), linkImportErrorMessage: (error: Error) => error.message }));
const mockSessionListeners=new Set<(unlocked:boolean)=>void>();
jest.mock("../../local-memory/storage", () => ({ onLocalMemorySessionChange: (fn:any) => {mockSessionListeners.add(fn);return ()=>mockSessionListeners.delete(fn);} }));
jest.mock('../../local-memory/repository', () => ({ localMemoryRepository: async () => ({}) }));
jest.mock('../../local-memory/sections', () => ({ ensureSections: async () => [{ id: 'notes', name: 'Заметки', slug: 'notes', sensitivity: 'standard' }] }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ goBack: mockBack }), useRoute: () => ({ params: mockParams }), usePreventRemove: jest.fn() }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
jest.mock('../../profile/ProfileContext', () => ({ useProfile: () => 'guest' }));
jest.mock('../../security/native-interaction', () => ({ withNativeInteraction: (fn: any) => fn() }));
jest.mock('../../direct-agent/settings', () => ({ loadDirectConnections: async () => ({ connections: [{ id: 'vision', name: 'Vision', apiKey: 'key', provider: 'openai', model: 'vision' }], activeId: 'vision' }), defaultDirectPreferences: {}, anonymousLocalAllowed: () => false }));
jest.mock('../../direct-agent/enrich-runner', () => ({ scheduleIndexTerms: jest.fn() }));
jest.mock('../vector-runner', () => ({ scheduleVectors: jest.fn() }));
jest.mock('../whisper', () => ({ useWhisperStatus: () => ({ state: 'absent' }) }));
jest.mock('../attachments', () => ({ MAX_ORIGINALS_PER_NOTE: 10, MAX_TOTAL_ORIGINAL_BYTES: 80 * 1024 * 1024, saveMediaNote: jest.fn(async () => 'note') }));
jest.mock('../extract', () => ({ ...jest.requireActual('../kinds'), extractMedia: jest.fn() }));
jest.mock('../joint-recognition', () => ({ analyzeFilesTogether: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' }] })) }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn(), requestCameraPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ copyAsync: jest.fn(async () => {}), cacheDirectory: 'file:///cache/', deleteAsync: jest.fn(async () => {}) }));
beforeEach(() => { jest.clearAllMocks(); mockParams = undefined; mockSessionListeners.clear(); });
test('picker lets user save original without transcript, provider or network; user text stays separate', async () => {
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(mockBack).toHaveBeenCalled());
  expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ body: '', sensitivity: 'standard', file: expect.objectContaining({ name: 'photo.png' }) }), expect.anything());
  expect(extractMedia).not.toHaveBeenCalled();
});
test('failed save keeps original and typed text for retry', async () => {
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error('disk_full'));
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Моя подпись');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(screen.getByText(/Не удалось сохранить/)).toBeTruthy());
  expect(mockBack).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Сведения из файла').props.value).toBe('Моя подпись');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(mockBack).toHaveBeenCalled());
});

test('shared text opens an unsaved draft with a section selector and saves only on confirmation', async () => {
  mockParams = { incoming: [{ shareType: 'text', value: 'Семейный рецепт' }, { shareType: 'url', value: 'https://example.org/recipe' }] };
  const screen = render(<MemoryImportScreen />);
  await waitFor(() => expect(screen.getByLabelText('Сведения из файла').props.value).toBe('Семейный рецепт'));
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Выбрать раздел импорта'));
  fireEvent.press(screen.getByLabelText('Раздел: Заметки'));
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Рецепт с моей подписью');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ body: 'Рецепт с моей подписью', collectionId: 'notes', file: undefined }), expect.anything()));
  await waitFor(() => expect(screen.getByLabelText('Сведения из файла').props.value).toBe('https://example.org/recipe'));
  expect(mockBack).not.toHaveBeenCalled();
});
test('recognition does not overwrite the user annotation', async () => {
  (extractMedia as jest.Mock).mockResolvedValueOnce('На фото гарантия холодильника');
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Куплено для дачи');
  if (!screen.queryByLabelText('Извлечь сведения из файла')) fireEvent.press(screen.getByLabelText('Распознавание'));
  fireEvent.press(screen.getByLabelText('Извлечь сведения из файла'));
  await waitFor(() => expect(screen.getByLabelText('Распознанное содержимое файла').props.value).toBe('На фото гарантия холодильника'));
  expect(screen.getByLabelText('Сведения из файла').props.value).toBe('Куплено для дачи');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ body: 'Куплено для дачи', extractedText: 'На фото гарантия холодильника' }), expect.anything()));
});

test('URL download network error is not shown as a local-memory failure', async () => {
  (importLink as jest.Mock).mockRejectedValueOnce(new Error('Не удалось загрузить ссылку (этап: соединение).'));
  const screen = render(<MemoryImportScreen />);
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://files.example.org/music.mp3');
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByText(/этап: соединение/)).toBeTruthy());
  expect(screen.queryByText(/Не удалось выполнить операцию с памятью/)).toBeNull();
});


test('U3 presents one source step and preserves the file when a replacement URL is only drafted', async () => {
  const screen = render(<MemoryImportScreen />);
  expect(screen.getByTestId('import-source-choices')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  expect(screen.queryByLabelText('Ссылка для импорта')).toBeNull();
  fireEvent.press(screen.getByLabelText('Изменить источник'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://files.example.org/other.mp3');
  // An unconfirmed replacement cannot poison the stored file provenance.
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalled());
  expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    file: expect.objectContaining({ name: 'photo.png' }), sourceUrl: undefined,
  }), expect.anything());
});

test('U3 hides provider choices by default but keeps recognition accessible', async () => {
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Распознавание'));
  expect(screen.getByLabelText('Параметры распознавания').props.accessibilityState.expanded).toBe(false);
  expect(screen.queryByLabelText('Разобрать через Vision')).toBeNull();
  fireEvent.press(screen.getByLabelText('Параметры распознавания'));
  expect(screen.getByLabelText('Разобрать через Vision')).toBeTruthy();
  if (!screen.queryByLabelText('Извлечь сведения из файла')) fireEvent.press(screen.getByLabelText('Распознавание'));
  fireEvent.press(screen.getByLabelText('Извлечь сведения из файла'));
  await waitFor(() => expect(extractMedia).toHaveBeenCalledTimes(1));
});

test('U3 does not show source replacement buttons for Android Share text', async () => {
  mockParams = { incoming: [{ shareType: 'text', value: 'Семейный рецепт' }] };
  const screen = render(<MemoryImportScreen />);
  await waitFor(() => expect(screen.getByLabelText('Сведения из файла').props.value).toBe('Семейный рецепт'));
  expect(screen.queryByLabelText('Ссылка для импорта')).toBeNull();
  expect(screen.queryByLabelText('Сфотографировать и распознать')).toBeNull();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ body: 'Семейный рецепт' }), expect.anything()));
});

test('U3 uses the confirmed URL returned by a successful text download', async () => {
  (importLink as jest.Mock).mockResolvedValueOnce({ source: 'https://example.org/recipe', text: 'Хлеб: мука и вода' });
  const screen = render(<MemoryImportScreen />);
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://example.org/recipe');
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByLabelText('Распознанное содержимое файла').props.value).toBe('Хлеб: мука и вода'));
  expect(screen.queryByLabelText('Ссылка для импорта')).toBeNull();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    sourceUrl: 'https://example.org/recipe', extractedText: 'Хлеб: мука и вода', file: undefined,
  }), expect.anything()));
});


const multiple = [
  { uri: "file:///cache/a.png", name: "a.png", mimeType: "image/png", size: 1200 },
  { uri: "file:///cache/b.txt", name: "b.txt", mimeType: "text/plain", size: 2400 },
];

test("two selected files share one note and support ordered recognition without joint LLM request", async () => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({ canceled: false, assets: multiple });
  (extractMedia as jest.Mock).mockResolvedValueOnce("Фото").mockResolvedValueOnce("Документ");
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(() => expect(screen.getByText("Вложения · 2")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Распознавание"));
  expect(screen.getByLabelText("Распознавать по очереди").props.accessibilityState.selected).toBe(true);
  fireEvent.press(screen.getByLabelText("Извлечь сведения из файла"));
  await waitFor(() => expect(screen.getByLabelText("Распознанное содержимое файла").props.value).toContain("Файл 2: b.txt"));
  expect(extractMedia).toHaveBeenCalledTimes(2);
  expect((extractMedia as jest.Mock).mock.calls.map(x => x[0].name)).toEqual(["a.png", "b.txt"]);
  expect(analyzeFilesTogether).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText("Сохранить сведения в память"));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith("guest", expect.objectContaining({
    files: multiple, title: "a.png", extractedText: expect.stringContaining("Файл 2: b.txt"),
  }), expect.anything()));
});

test("joint mode uses one additional synthesis request and stores the shared result in the same note", async () => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({ canceled: false, assets: multiple });
  (extractMedia as jest.Mock).mockResolvedValueOnce("Фото").mockResolvedValueOnce("Документ");
  (analyzeFilesTogether as jest.Mock).mockResolvedValueOnce("Оба файла описывают один рецепт.");
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(() => expect(screen.getByText("Вложения · 2")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Распознавание"));
  fireEvent.press(screen.getByLabelText("Распознавать вместе"));
  fireEvent.press(screen.getByLabelText("Извлечь сведения из файла"));
  await waitFor(() => expect(screen.getByLabelText("Распознанное содержимое файла").props.value).toContain("Оба файла описывают один рецепт."));
  expect(analyzeFilesTogether).toHaveBeenCalledTimes(1);
  expect(analyzeFilesTogether).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ name: "a.png", text: "Фото" }),
    expect.objectContaining({ name: "b.txt", text: "Документ" }),
  ]), expect.anything(), true, expect.anything());
  fireEvent.press(screen.getByLabelText("Сохранить сведения в память"));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith("guest", expect.objectContaining({
    files: multiple, extractedText: expect.stringContaining("Совместный анализ материалов"),
  }), expect.anything()));
});

test("joint analysis failure preserves independently recognized files for one note", async () => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({ canceled: false, assets: multiple });
  (extractMedia as jest.Mock).mockResolvedValueOnce("Фото").mockRejectedValueOnce(new Error("Кодек недоступен"));
  (analyzeFilesTogether as jest.Mock).mockRejectedValueOnce(new Error("Провайдер недоступен"));
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(() => expect(screen.getByText("Вложения · 2")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Распознавание"));
  fireEvent.press(screen.getByLabelText("Распознавать вместе"));
  fireEvent.press(screen.getByLabelText("Извлечь сведения из файла"));
  await waitFor(() => expect(screen.getByText(/совместный анализ не получился/i)).toBeTruthy());
  expect(screen.getByLabelText("Распознанное содержимое файла").props.value).toContain("Файл 1: a.png");
  expect(screen.getByLabelText("Распознанное содержимое файла").props.value).not.toContain("Кодек недоступен");
  expect(screen.getByText(/Не распознано — Кодек недоступен/)).toBeTruthy();
});

test("joint recognition is unavailable for sensitive notes and restores sequential mode", async () => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({ canceled: false, assets: multiple });
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(() => expect(screen.getByText("Вложения · 2")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Распознавание"));
  fireEvent.press(screen.getByLabelText("Распознавать вместе"));
  fireEvent.press(screen.getByLabelText("Личные — только на телефоне"));
  expect(screen.getByLabelText("Распознавать вместе").props.accessibilityState.disabled).toBe(true);
  expect(screen.getByLabelText("Распознавать по очереди").props.accessibilityState.selected).toBe(true);
});

test('gallery uses selected collection without automatic model calls', async () => {
  mockParams = { source: 'photo', collectionId: 'notes' };
  require('expo-image-picker').launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///gallery/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' }] });
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText('Выбрать фото из галереи'));
  await waitFor(() => screen.getByLabelText('Сохранить сведения в память'));
  expect(extractMedia).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalled());
  expect((saveMediaNote as jest.Mock).mock.calls[0][1]).toMatchObject({ collectionId: 'notes', file: { name: 'a.jpg' } });
});


test('compact import hides optional controls and prevents saving a discarded original without text', async () => {
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => screen.getByText('photo.png'));
  expect(screen.queryByLabelText('Извлечь сведения из файла')).toBeNull();
  expect(screen.queryByLabelText('Название импортируемой заметки')).toBeNull();
  expect(screen.queryByLabelText('Раздел: Заметки')).toBeNull();
  expect(screen.getByTestId('import-save-bar')).toBeTruthy();
  expect(screen.getByLabelText('Сохранить сведения в память').props.accessibilityState.disabled).toBe(false);
  fireEvent.press(screen.getByLabelText('Дополнительные параметры'));
  fireEvent.press(screen.getByRole('checkbox'));
  expect(screen.getByLabelText('Сохранить сведения в память').props.accessibilityState.disabled).toBe(true);
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Подпись');
  expect(screen.getByLabelText('Сохранить сведения в память').props.accessibilityState.disabled).toBe(false);
  expect(extractMedia).not.toHaveBeenCalled();
});


const mockIncomingDelete=jest.fn();
jest.mock('expo-file-system',()=>({Paths:{cache:'file:///cache'},Directory:class {uri:string;constructor(...p:string[]){this.uri=p.join('/');}create(){}},File:class {uri:string;exists=true;size=100;constructor(p:any,n?:string){this.uri=typeof p==='string'?p:p.uri+'/'+n;}get name(){return this.uri.split('/').pop();}delete(){mockIncomingDelete(this.uri);}}}));
test('incoming memory preview removes partial copy on failure and never saves it',async()=>{
  const fs=require('expo-file-system/legacy');fs.copyAsync.mockRejectedValueOnce(new Error('copy failed'));
  mockParams={incoming:[{shareType:'image',value:'content://gallery/photo.jpg',mimeType:'image/jpeg'}]};
  render(<MemoryImportScreen/>);await waitFor(()=>expect(mockIncomingDelete).toHaveBeenCalled());expect(saveMediaNote).not.toHaveBeenCalled();
});
test('lock during incoming copy discards late result and deletes it again after copy completes',async()=>{
  let resolve:any;const fs=require('expo-file-system/legacy');fs.copyAsync.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  mockParams={incoming:[{shareType:'image',value:'content://gallery/photo.jpg',mimeType:'image/jpeg'}]};
  const s=render(<MemoryImportScreen/>);await waitFor(()=>expect(resolve).toBeDefined());
  act(()=>mockSessionListeners.forEach(fn=>fn(false)));const deletes=mockIncomingDelete.mock.calls.length;
  await act(async()=>resolve());expect(mockIncomingDelete.mock.calls.length).toBeGreaterThan(deletes);expect(saveMediaNote).not.toHaveBeenCalled();expect(s.getByText('Подготовка прервана блокировкой. Повторите приём после разблокировки.')).toBeTruthy();
});
