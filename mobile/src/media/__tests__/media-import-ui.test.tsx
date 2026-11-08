import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { MemoryImportScreen } from '../../screens/MemoryImportScreen';
import { saveMediaNote } from '../attachments';
import { extractMedia } from '../extract';
import { importLink } from '../link-import';
import { analyzeFilesTogether } from '../joint-recognition';
import { ensureSections } from '../../local-memory/sections';
import { Alert, Linking } from 'react-native';
import { classifyImportCollectionWithAgent } from '../import-llm-classifier';
import * as DocumentPicker from 'expo-document-picker';
jest.mock('../../components/BottomSheet', () => ({ BottomSheet: ({ visible, children }: any) => visible ? children : null }));
jest.mock('../../components/NoteAiEditor', () => ({
  NoteAiEditor: ({onApply, onClose}: any) => {
    const {Text} = require('react-native');
    return <Text onPress={() => { onApply({title: '', body: 'Правка модели'}); onClose(); }}>Применить тестовую правку</Text>;
  },
}));
const mockBack = jest.fn();
const mockDispatch = jest.fn();
let mockParams: any = undefined;
jest.mock("../preferences", () => ({ loadMediaPreferences: async () => ({ visionId: "", speechId: "" }) }));
jest.mock('../link-import', () => ({
  importLink: jest.fn(),
  publicImportUrl: jest.requireActual('../link-import').publicImportUrl,
  linkImportErrorMessage: (error: Error) => error.message,
}));
let mockUnlocked=true;
const mockSessionListeners=new Set<(unlocked:boolean)=>void>();
jest.mock("../../local-memory/storage", () => ({ onLocalMemorySessionChange: (fn:any) => {mockSessionListeners.add(fn);return ()=>mockSessionListeners.delete(fn);},localMemorySessionUnlocked:()=>mockUnlocked }));
jest.mock('../../direct-agent/agent-preferences',()=>({loadModelCallLimit:jest.fn(async()=>4)}));
jest.mock('../import-llm-classifier',()=>({
  classifyImportCollectionWithAgent:jest.fn(async()=>null),
  classificationExcerpt:(body:string,text:string)=>({substantive:(body+' '+text).trim().length>=8}),
}));
jest.mock('../../local-memory/repository', () => ({ localMemoryRepository: async () => ({}) }));
jest.mock('../../local-memory/sections', () => ({ ensureSections: jest.fn(async () => [{ id: 'notes', name: 'Заметки', slug: 'notes', sensitivity: 'standard' }]) }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ goBack: mockBack, dispatch: mockDispatch }), useRoute: () => ({ params: mockParams }), usePreventRemove: jest.fn() }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 56 }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
jest.mock('../../profile/ProfileContext', () => ({ useProfile: () => 'guest' }));
jest.mock('../../security/native-interaction', () => ({ withNativeInteraction: (fn: any) => fn() }));
jest.mock('../../direct-agent/settings', () => ({ loadDirectConnections: async () => ({ connections: [{ id: 'vision', name: 'Vision', apiKey: 'key', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'vision' }], activeId: 'vision' }), defaultDirectPreferences: {}, anonymousLocalAllowed: () => false }));
jest.mock('../../direct-agent/enrich-runner', () => ({ scheduleIndexTerms: jest.fn() }));
jest.mock('../vector-runner', () => ({ scheduleVectors: jest.fn() }));
jest.mock('../whisper', () => ({ useWhisperStatus: () => ({ state: 'absent' }) }));
jest.mock('../attachments', () => ({ MAX_ORIGINALS_PER_NOTE: 10, MAX_TOTAL_ORIGINAL_BYTES: 80 * 1024 * 1024, saveMediaNote: jest.fn(async () => 'note') }));
jest.mock('../extract', () => ({ ...jest.requireActual('../kinds'), extractMedia: jest.fn(),
  officialAudioProvider: (c: any) => c.provider === 'openai' && c.baseUrl === 'https://api.openai.com/v1',
}));
jest.mock('../joint-recognition', () => ({ analyzeFilesTogether: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///cache/photo.png', name: 'photo.png', mimeType: 'image/png' }] })) }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn(), requestCameraPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ copyAsync: jest.fn(async () => {}), cacheDirectory: 'file:///cache/', deleteAsync: jest.fn(async () => {}) }));
beforeEach(() => { jest.clearAllMocks(); mockParams = undefined; mockUnlocked=true; mockSessionListeners.clear();
  jest.spyOn(Alert,"alert").mockImplementation((title,_message,buttons:any)=> {
    if(title==="Автоматические теги и раздел") {
      const skip=buttons?.find((item:any)=>item.text==="Сохранить без ИИ");
      skip?.onPress?.();
    }
  });
  (ensureSections as jest.Mock).mockResolvedValue([{ id: 'notes', name: 'Заметки', slug: 'notes', sensitivity: 'standard' }]);
});
afterEach(()=>{jest.restoreAllMocks();});
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
  fireEvent.press(screen.getByLabelText('Выбрать коллекцию'));
  fireEvent.press(screen.getByLabelText('Коллекция: Заметки'));
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Рецепт с моей подписью');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ body: 'Рецепт с моей подписью', collectionId: 'notes', file: undefined }), expect.anything()));
  await waitFor(() => expect(screen.getByLabelText('Сведения из файла').props.value).toBe('https://example.org/recipe'));
  expect(mockBack).not.toHaveBeenCalled();
});
test('MSG-1: Telegram text+link Share opens URL-only preview; caption remains, no automatic model or network',async()=>{
  const caption='Это мой комментарий к статье';
  mockParams={incoming:[{shareType:'text',value:caption+'\\nhttps://t.me/public_news/123'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByLabelText('Сведения из файла').props.value)
    .toContain(caption));
  expect(screen.getByText('Ссылка · без текста страницы')).toBeTruthy();
  expect(screen.getByText(/Формат публичного поста/)).toBeTruthy();
  expect(screen.getByLabelText('Загрузить содержимое публичной ссылки после согласия')).toBeTruthy();
  expect(importLink).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:'https://t.me/public_news/123',
      body:caption+'\\nhttps://t.me/public_news/123',
      extractedText:'',file:undefined}),expect.anything()));
  expect(importLink).not.toHaveBeenCalled();
});

test('MSG-1: explicit Telegram fetch uses existing importLink and leaves user caption untouched',async()=>{
  (importLink as jest.Mock).mockResolvedValueOnce({
    source:'https://t.me/public_news/124',title:'Текст публичного поста',
    text:'Проверенный содержательный текст публичного поста',
    partial:true,textCoverage:"telegram_post_text_only",
  });
  mockParams={incoming:[{shareType:'url',value:'https://t.me/public_news/124'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByLabelText('Загрузить содержимое публичной ссылки после согласия')).toBeTruthy());
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Загрузить содержимое публичной ссылки после согласия'));
  await waitFor(()=>expect(importLink).toHaveBeenCalledWith('https://t.me/public_news/124',
    expect.anything()));
  await waitFor(()=>expect(screen.getByLabelText('Распознанное содержимое файла').props.value)
    .toBe('Проверенный содержательный текст публичного поста'));
  expect(screen.getByText(/Фото, видео, вложения, автор и дата не подтверждены/)).toBeTruthy();
  expect(screen.getByLabelText('Сведения из файла').props.value)
    .toBe('https://t.me/public_news/124');
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:'https://t.me/public_news/124',
      extractedText:'Проверенный содержательный текст публичного поста',
      body:'https://t.me/public_news/124'}),expect.anything()));
});

test('MSG-1: MAX channel link is URL-only, never falsely shown as fetched post',async()=>{
  mockParams={incoming:[{shareType:'text',value:'Читайте у нас!\\nhttps://max.ru/channel_news'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByText('Ссылка · без текста страницы')).toBeTruthy());
  expect(screen.getByText(/MAX · Сохранится только ссылка/)).toBeTruthy();
  expect(screen.queryByLabelText('Загрузить содержимое публичной ссылки после согласия')).toBeNull();
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:'https://max.ru/channel_news',
      body:'Читайте у нас!\\nhttps://max.ru/channel_news',extractedText:''}),expect.anything()));
});

test('MSG-0: multi-URL Share is text only; never chooses a random source URL',async()=>{
  mockParams={incoming:[{shareType:'text',
    value:'Две версии: https://t.me/public_news/123 и https://t.me/public_news/124'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByLabelText('Сведения из файла').props.value).toContain('Две версии'));
  expect(screen.queryByText('Ссылка · без текста страницы')).toBeNull();
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:undefined,extractedText:''}),expect.anything()));
});

test('MSG-0: private Telegram share is text-only, no public fetch or verified source',async()=>{
  mockParams={incoming:[{shareType:'url',value:'https://t.me/c/123/345'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByText(/не является публичным постом/)).toBeTruthy());
  expect(screen.queryByLabelText('Загрузить содержимое публичной ссылки после согласия')).toBeNull();
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:undefined,
      body:'https://t.me/c/123/345'}),expect.anything()));
});

test('MSG-0: invalid or local Share URL stays as text without unsafe origin attribution',async()=>{
  mockParams={incoming:[{shareType:'url',value:'http://127.0.0.1/private'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByText(/не прошёл проверку публичной HTTPS/)).toBeTruthy());
  expect(screen.queryByText('Ссылка · без текста страницы')).toBeNull();
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:undefined}),expect.anything()));
});

test('MSG-1: failed public fetch retains original URL-only draft, not a false successful read',async()=>{
  (importLink as jest.Mock).mockRejectedValueOnce(new Error('Доступ к материалу закрыт (HTTP 403).'));
  mockParams={incoming:[{shareType:'url',value:'https://t.me/public_news/199'}]};
  const screen=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(screen.getByLabelText('Загрузить содержимое публичной ссылки после согласия')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Загрузить содержимое публичной ссылки после согласия'));
  await waitFor(()=>expect(screen.getByText(/HTTP 403/)).toBeTruthy());
  expect(screen.getByText('Ссылка · без текста страницы')).toBeTruthy();
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({sourceUrl:'https://t.me/public_news/199',
      extractedText:''}),expect.anything()));
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
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://files.example.org/music.mp3');
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByText(/этап: соединение/)).toBeTruthy());
  expect(screen.queryByText(/Не удалось выполнить операцию с памятью/)).toBeNull();
});


test('step 8 saves link-only without a network request, and only on explicit confirmation', async () => {
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://example.org/articles/ai');
  fireEvent.press(screen.getByLabelText('Продолжить только со ссылкой'));
  expect(importLink).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(screen.getByText('Ссылка · без текста страницы')).toBeTruthy();
  expect(screen.getByText(/не текст статьи/)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Прочитать позже про ИИ');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledTimes(1));
  expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    file: undefined, sourceUrl: 'https://example.org/articles/ai',
    body: 'Прочитать позже про ИИ', extractedText: '',
    title: 'Ссылка · example.org',
  }), expect.anything());
  await waitFor(() => expect(mockBack).toHaveBeenCalled());
});

test('step 8 keeps the link-only fallback available after a failed fetch', async () => {
  (importLink as jest.Mock).mockRejectedValueOnce(new Error('Сайт отказал в загрузке: HTTP 403.'));
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://example.org/private-article');
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByText(/HTTP 403/)).toBeTruthy());
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Продолжить только со ссылкой'));
  expect(screen.getByText('Ссылка · без текста страницы')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    sourceUrl: 'https://example.org/private-article', extractedText: '',
  }), expect.anything()));
});

test('step 8 refuses invalid or private links before building a link-only draft', () => {
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'http://127.0.0.1/data');
  fireEvent.press(screen.getByLabelText('Продолжить только со ссылкой'));
  expect(screen.queryByText('Ссылка · без текста страницы')).toBeNull();
  expect(screen.queryByLabelText('Сохранить сведения в память')).toBeNull();
  expect(importLink).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
});

test('step 8 network retry retains user annotation rather than replacing it with extracted page text', async () => {
  (importLink as jest.Mock).mockResolvedValueOnce({ source:'https://example.org/article', text:'Содержание статьи' });
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://example.org/article');
  fireEvent.press(screen.getByLabelText('Продолжить только со ссылкой'));
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Моя важная пометка');
  fireEvent.press(screen.getByLabelText('Заменить вложение'));
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByLabelText('Распознанное содержимое файла').props.value).toBe('Содержание статьи'));
  expect(screen.getByLabelText('Сведения из файла').props.value).toBe('Моя важная пометка');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    sourceUrl:'https://example.org/article', body:'Моя важная пометка', extractedText:'Содержание статьи',
  }), expect.anything()));
});

test('U3 presents one source step and preserves the file when a replacement URL is only drafted', async () => {
  const screen = render(<MemoryImportScreen />);
  expect(screen.getByTestId('import-source-choices')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  expect(screen.queryByLabelText('Ссылка для импорта')).toBeNull();
  fireEvent.press(screen.getByLabelText('Заменить вложение'));
  fireEvent.press(screen.getByText('Ссылка'));
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
  expect(screen.queryByLabelText('Сфотографировать')).toBeNull();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({ body: 'Семейный рецепт' }), expect.anything()));
});

test('U3 uses the confirmed URL returned by a successful text download', async () => {
  (importLink as jest.Mock).mockResolvedValueOnce({ source: 'https://example.org/recipe', text: 'Хлеб: мука и вода' });
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://example.org/recipe');
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByLabelText('Распознанное содержимое файла').props.value).toBe('Хлеб: мука и вода'));
  expect(screen.queryByLabelText('Ссылка для импорта')).toBeNull();
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    sourceUrl: 'https://example.org/recipe', extractedText: 'Хлеб: мука и вода', file: undefined,
  }), expect.anything()));
});



test('step 8 C uses the extracted article title and warns when page markup is incomplete', async () => {
  (importLink as jest.Mock).mockResolvedValueOnce({
    source: 'https://example.org/recipe',
    text: 'Пирог\nМука 200 г\n1. Смешать\n2. Выпекать',
    title: 'Пирог с яблоками', partial: true,
  });
  const screen = render(<MemoryImportScreen />);
  fireEvent.press(screen.getByText('Ссылка'));
  fireEvent.changeText(screen.getByLabelText('Ссылка для импорта'), 'https://example.org/recipe');
  fireEvent.press(screen.getByText('Загрузить по ссылке'));
  await waitFor(() => expect(screen.getByText(/разметка обрывается/)).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText('Сведения из файла'), 'Моя пометка');
  fireEvent.press(screen.getByLabelText('Сохранить сведения в память'));
  await waitFor(() => expect(saveMediaNote).toHaveBeenCalledWith('guest', expect.objectContaining({
    sourceUrl: 'https://example.org/recipe', title: 'Пирог с яблоками',
    body: 'Моя пометка', extractedText: expect.stringContaining('Мука 200 г'),
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
  expect(screen.queryByLabelText('Коллекция: Заметки')).toBeNull();
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

test.each(['camera','gallery','file'])('direct %s launch opens once and cancellation returns without saving', async source => {
  mockParams = {source};
  const picker = require('expo-image-picker');
  picker.requestCameraPermissionsAsync.mockResolvedValue({granted:true});
  const launch = source === 'camera' ? picker.launchCameraAsync : source === 'gallery'
    ? picker.launchImageLibraryAsync : DocumentPicker.getDocumentAsync as jest.Mock;
  launch.mockResolvedValueOnce({canceled:true});
  render(<MemoryImportScreen/>);
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(saveMediaNote).not.toHaveBeenCalled();
});

test('leaving a typed link is guarded before download', () => {
  mockParams = {source:'link'};
  const ui = render(<MemoryImportScreen/>);
  const guard = require('@react-navigation/native').usePreventRemove;
  expect(guard).toHaveBeenLastCalledWith(false,expect.any(Function));
  fireEvent.changeText(ui.getByLabelText('Ссылка для импорта'),'https://example.org');
  expect(guard).toHaveBeenLastCalledWith(true,expect.any(Function));
  expect(importLink).not.toHaveBeenCalled();
});

test('cancelled replacement keeps caption and original in preview', async () => {
  mockParams = {source:'file'};
  const ui = render(<MemoryImportScreen/>);
  await waitFor(() => ui.getByText('photo.png'));
  fireEvent.changeText(ui.getByLabelText('Сведения из файла'),'Моя подпись');
  fireEvent.press(ui.getByLabelText('Заменить вложение'));
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({canceled:true});
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => ui.getByLabelText('Заменить вложение'));
  expect(ui.getByText('photo.png')).toBeTruthy();
  expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Моя подпись');
  expect(mockBack).not.toHaveBeenCalled();
});


test('step 8 D: PDF coverage preview identifies missing pages and retains author comment on save',async()=>{
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
    canceled:false,assets:[{uri:'file:///cache/manual.pdf',name:'manual.pdf',mimeType:'application/pdf'}],
  });
  const coverage={totalPageCount:3,extractedPageCount:2,missingPages:[2],coverage:'partial'};
  const segments=[
    {text:'Начало',location:{kind:'page',page:1}},
    {text:'Конец',location:{kind:'page',page:3}},
  ];
  (extractMedia as jest.Mock).mockImplementationOnce(async (...args:any[])=>{
    args[6](segments);
    args[7](coverage);
    return 'Страница 1:\nНачало\n\nСтраница 3:\nКонец';
  });
  const ui=render(<MemoryImportScreen/>);
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(()=>expect(ui.getByText('manual.pdf')).toBeTruthy());
  fireEvent.changeText(ui.getByLabelText('Сведения из файла'),'Это мой договор');
  fireEvent.press(ui.getByLabelText('Распознавание'));
  fireEvent.press(ui.getByLabelText('Извлечь сведения из файла'));
  await waitFor(()=>expect(ui.getByText(/2 из 3 стр.*2.*OCR пока не выполнялся/)).toBeTruthy());
  expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Это мой договор');
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    body:'Это мой договор',
    extractedText:expect.stringContaining('Страница 3'),
    recognitions:[expect.objectContaining({pdfCoverage:coverage,segments})],
  }),expect.anything()));
});


test('step 8 E photo document-text action is opt-in and keeps user annotation',async()=>{
  (extractMedia as jest.Mock).mockResolvedValueOnce('Счёт № 17\nСумма: 2 050 ₽');
  const ui=render(<MemoryImportScreen/>);
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(()=>expect(ui.getByText('photo.png')).toBeTruthy());
  fireEvent.changeText(ui.getByLabelText('Сведения из файла'),'Сохранить в бухгалтерию');
  if(!ui.queryByLabelText('Извлечь сведения из файла'))fireEvent.press(ui.getByLabelText('Распознавание'));
  fireEvent.press(ui.getByLabelText('Прочитать текст фотографии через ИИ'));
  expect(ui.getByText(/Это не локальное OCR/)).toBeTruthy();
  expect(ui.getByText('Отправить фото модели и прочитать текст')).toBeTruthy();
  expect(extractMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Извлечь сведения из файла'));
  await waitFor(()=>expect(ui.getByLabelText('Распознанное содержимое файла').props.value).toBe('Счёт № 17\nСумма: 2 050 ₽'));
  expect((extractMedia as jest.Mock).mock.calls[0][8]).toBe('document-text');
  expect((extractMedia as jest.Mock).mock.calls[0][2]).toBe(true);
  expect(ui.getByText(/не подтвердил точность/)).toBeTruthy();
  expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Сохранить в бухгалтерию');
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    body:'Сохранить в бухгалтерию',extractedText:'Счёт № 17\nСумма: 2 050 ₽',
  }),expect.anything()));
});
test('step 8 E personal photo remains local-only with no provider call',async()=>{
  const ui=render(<MemoryImportScreen/>);
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(()=>expect(ui.getByText('photo.png')).toBeTruthy());
  if(!ui.queryByLabelText('Прочитать текст фотографии через ИИ'))fireEvent.press(ui.getByLabelText('Распознавание'));
  fireEvent.press(ui.getByLabelText('Прочитать текст фотографии через ИИ'));
  fireEvent.press(ui.getByLabelText('Личные — только на телефоне'));
  const read=ui.getByLabelText('Извлечь сведения из файла');
  expect(read.props.accessibilityState?.disabled ?? read.props.disabled).toBe(true);
  expect(extractMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    sensitivity:'sensitive',file:expect.objectContaining({name:'photo.png'}),extractedText:'',
  }),expect.anything()));
});


test('step 8 E protected collection blocks external OCR even when record is standard',async()=>{
  (ensureSections as jest.Mock).mockResolvedValueOnce([{id:'secure',name:'Личные документы',slug:'notes',sensitivity:'sensitive'}]);
  const ui=render(<MemoryImportScreen/>);
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(()=>expect(ui.getByText('photo.png')).toBeTruthy());
  if(!ui.queryByLabelText('Прочитать текст фотографии через ИИ'))fireEvent.press(ui.getByLabelText('Распознавание'));
  fireEvent.press(ui.getByLabelText('Прочитать текст фотографии через ИИ'));
  await waitFor(()=>expect(ui.getByText(/Выбранная коллекция закрыта для агента/)).toBeTruthy());
  expect(ui.getByLabelText('Извлечь сведения из файла').props.accessibilityState?.disabled ?? ui.getByLabelText('Извлечь сведения из файла').props.disabled).toBe(true);
  expect(extractMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    sensitivity:'standard',collectionId:'secure',extractedText:'',file:expect.objectContaining({name:'photo.png'}),
  }),expect.anything()));
});


test('step 8 E re-recognition protects edits with Nebula cancel and explicit confirm',async()=>{
  (extractMedia as jest.Mock).mockResolvedValueOnce('Продукт: масло').mockResolvedValueOnce('Продукт: масло 200 г');
  const ui=render(<MemoryImportScreen/>);
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(()=>expect(ui.getByText('photo.png')).toBeTruthy());
  if(!ui.queryByLabelText('Прочитать текст фотографии через ИИ'))fireEvent.press(ui.getByLabelText('Распознавание'));
  fireEvent.press(ui.getByLabelText('Прочитать текст фотографии через ИИ'));
  fireEvent.press(ui.getByLabelText('Извлечь сведения из файла'));
  await waitFor(()=>expect(ui.getByLabelText('Распознанное содержимое файла').props.value).toBe('Продукт: масло'));
  fireEvent.changeText(ui.getByLabelText('Распознанное содержимое файла'),'Продукт: масло — исправлено пользователем');
  fireEvent.press(ui.getByLabelText('Распознать заново'));
  await waitFor(()=>expect(ui.getByLabelText('Оставить текущий')).toBeTruthy());
  expect(ui.getByLabelText('Распознанное содержимое файла').props.value).toContain('исправлено пользователем');
  fireEvent.press(ui.getByLabelText('Оставить текущий'));
  expect(ui.getByLabelText('Распознанное содержимое файла').props.value).toContain('исправлено пользователем');
  (extractMedia as jest.Mock).mockResolvedValueOnce('Продукт: масло 300 г');
  fireEvent.press(ui.getByLabelText('Распознать заново'));
  await waitFor(()=>expect(ui.getByLabelText('Применить новый')).toBeTruthy());
  fireEvent.press(ui.getByLabelText('Применить новый'));
  expect(ui.getByLabelText('Распознанное содержимое файла').props.value).toBe('Продукт: масло 300 г');
  fireEvent.changeText(ui.getByLabelText('Сведения из файла'),'Мой комментарий');
  fireEvent.press(ui.getByLabelText('Улучшить текст файла с ИИ'));
  fireEvent.press(ui.getByText('Применить тестовую правку'));
  expect(ui.getByLabelText('Распознанное содержимое файла').props.value).toBe('Правка модели');
  expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Мой комментарий');
});


test('skipping an incoming material asks through Nebula, preserves the draft on cancel and never saves automatically', async () => {
  mockParams = { incoming: [
    { shareType: 'text', value: 'Текст первой заметки' },
    { shareType: 'text', value: 'Текст второй заметки' },
  ] };
  const ui = render(<MemoryImportScreen />);
  await waitFor(() => expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Текст первой заметки'));
  fireEvent.press(ui.getByLabelText('Пропустить материал'));
  expect(ui.getByLabelText('Оставить текущий материал')).toBeTruthy();
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Оставить текущий материал'));
  expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Текст первой заметки');
  fireEvent.press(ui.getByLabelText('Пропустить материал'));
  fireEvent.press(ui.getByLabelText('Пропустить материал без сохранения'));
  await waitFor(() => expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Текст второй заметки'));
  expect(saveMediaNote).not.toHaveBeenCalled();
});

test('import guarded Back shows Nebula consent and replays the original navigation action only on confirmation', async () => {
  const ui = render(<MemoryImportScreen />);
  fireEvent.press(ui.getByText('Ссылка'));
  fireEvent.changeText(ui.getByLabelText('Ссылка для импорта'), 'https://example.org/draft');
  const nav = require('@react-navigation/native');
  const findGuard = () => [...(nav.usePreventRemove as jest.Mock).mock.calls].reverse().find(([enabled]) => enabled)?.[1];
  const action = { type: 'GO_BACK' };
  act(() => { findGuard()?.({ data: { action } }); });
  expect(ui.getByLabelText('Продолжить редактирование')).toBeTruthy();
  expect(mockDispatch).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Продолжить редактирование'));
  expect(ui.getByLabelText('Ссылка для импорта').props.value).toBe('https://example.org/draft');
  act(() => { findGuard()?.({ data: { action } }); });
  fireEvent.press(ui.getByLabelText('Закрыть без сохранения'));
  await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(action));
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(saveMediaNote).not.toHaveBeenCalled();
});

test('online audio original is never uploaded before an exact one-time Nebula consent', async () => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false, assets: [{ uri: 'file:///cache/voice.mp3', name: 'voice.mp3', mimeType: 'audio/mpeg' }],
  });
  (extractMedia as jest.Mock).mockResolvedValueOnce('Расшифрованный голос');
  const ui = render(<MemoryImportScreen />);
  fireEvent.press(ui.getByLabelText('Выбрать файл для памяти'));
  await waitFor(() => expect(ui.getByText('voice.mp3')).toBeTruthy());
  if (!ui.queryByLabelText('Способ распознавания аудиофайла: Онлайн · OpenAI'))
    fireEvent.press(ui.getByLabelText('Распознавание'));
  fireEvent.press(ui.getByLabelText('Способ распознавания аудиофайла: Онлайн · OpenAI'));
  await waitFor(() => expect(ui.getByLabelText('Извлечь сведения из файла').props.disabled ?? ui.getByLabelText('Извлечь сведения из файла').props.accessibilityState?.disabled).toBeFalsy());
  fireEvent.press(ui.getByLabelText('Извлечь сведения из файла'));
  expect(ui.getByLabelText('Не отправлять')).toBeTruthy();
  expect(extractMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Не отправлять'));
  expect(extractMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Извлечь сведения из файла'));
  fireEvent.press(ui.getByLabelText('Отправить и распознать'));
  await waitFor(() => expect(extractMedia).toHaveBeenCalledTimes(1));
});

test("recognition mode choices are visible framed cards; changing one does not send or save", async () => {
  const screen=render(<MemoryImportScreen/>);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Распознавание"));
  const describe=screen.getByLabelText("Описать фотографию");
  const localOcr=screen.getByLabelText("Прочитать фотографию на телефоне");
  expect(describe.props.style.minHeight).toBe(48);
  expect(describe.props.style.borderWidth).toBe(2);
  expect(localOcr.props.style.borderWidth).toBe(1);
  expect(localOcr.props.style.borderRadius).toBe(14);
  fireEvent.press(localOcr);
  expect(screen.getByLabelText("Прочитать фотографию на телефоне").props.style.borderWidth).toBe(2);
  expect(screen.getByLabelText("Описать фотографию").props.style.borderWidth).toBe(1);
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(extractMedia).not.toHaveBeenCalled();
});

test("selection of an import connection is visibly highlighted but remains a draft",async()=>{
  const screen=render(<MemoryImportScreen/>);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Распознавание"));
  fireEvent.press(screen.getByLabelText("Параметры распознавания"));
  const provider=screen.getByLabelText("Разобрать через Vision");
  expect(provider.props.style.minHeight).toBe(48);
  expect(provider.props.style.borderWidth).toBe(2);
  expect(provider.props.accessibilityState.selected).toBe(true);
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(extractMedia).not.toHaveBeenCalled();
});


test('MSG-2.A: Android Share photo album and caption remain ONE unsaved memory draft', async () => {
  const incoming = [
    {shareType:'text',value:'Задание на завтра: страницы 24–25'},
    {shareType:'image',value:'content://telegram/photo_a.jpg',mimeType:'image/jpeg'},
    {shareType:'image',value:'content://telegram/photo_b.png',mimeType:'image/png'},
  ];
  mockParams={incoming};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByLabelText('Сведения из файла').props.value)
    .toBe('Задание на завтра: страницы 24–25'));
  expect(ui.getByText(/Файлов в одной заметке: 2/)).toBeTruthy();
  expect(ui.queryByLabelText('Пропустить материал')).toBeNull();
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledTimes(1));
  expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    body:'Задание на завтра: страницы 24–25',sourceUrl:undefined,
    receipt:JSON.stringify(incoming),
    files:[
      expect.objectContaining({name:'photo_a.jpg',mimeType:'image/jpeg'}),
      expect.objectContaining({name:'photo_b.png',mimeType:'image/png'}),
    ],
  }),expect.anything());
  await waitFor(()=>expect(mockBack).toHaveBeenCalledTimes(1));
});

test('MSG-2.A: mixed Share caption and one file become one note; never treats caption URL as verified provenance', async () => {
  const incoming=[
    {shareType:'url',value:'https://t.me/public_news/123'},
    {shareType:'file',value:'content://telegram/lesson.pdf',mimeType:'application/pdf'},
  ];
  mockParams={incoming};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByLabelText('Сведения из файла').props.value)
    .toBe(incoming[0].value));
  expect(ui.queryByText('Ссылка · без текста страницы')).toBeNull();
  expect(importLink).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledTimes(1));
  expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    body:incoming[0].value,sourceUrl:undefined,
    file:expect.objectContaining({name:'lesson.pdf'}),
    receipt:JSON.stringify(incoming),
  }),expect.anything());
});

test('MSG-2.A: album above 10 originals fails closed without incomplete note', async () => {
  mockParams={incoming:Array.from({length:11},(_,i)=>({
    shareType:'image',value:'content://telegram/photo_'+i+'.jpg',mimeType:'image/jpeg',
  }))};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByText(/Не более 10 файлов/)).toBeTruthy());
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(ui.getByLabelText('Сохранить сведения в память').props.accessibilityState.disabled).toBe(true);
  expect(mockIncomingDelete).toHaveBeenCalled();
});

test('MSG-2.A: failed second album copy rolls back the whole staged preview', async () => {
  const fs=require('expo-file-system/legacy');
  fs.copyAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('content://provider/private'));
  mockParams={incoming:[
    {shareType:'image',value:'content://telegram/one.jpg',mimeType:'image/jpeg'},
    {shareType:'image',value:'content://telegram/two.jpg',mimeType:'image/jpeg'},
  ]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(mockIncomingDelete.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(ui.getByLabelText('Сохранить сведения в память').props.accessibilityState.disabled).toBe(true);
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(JSON.stringify(ui.toJSON())).not.toContain('content://provider/private');
});

test('MSG-6.A: Android Share defaults to Inbox without creating it before confirmation', async () => {
  mockParams={incoming:[{shareType:'text',value:'Письмо из Telegram'}]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByText(/Коллекция: Входящие · Изменить/)).toBeTruthy());
  expect(ui.queryByText(/Коллекция: Заметки · Изменить/)).toBeNull();
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Выбрать коллекцию'));
  expect(ui.getByLabelText('Коллекция: Входящие')).toBeTruthy();
  fireEvent.press(ui.getByLabelText('Коллекция: Входящие'));
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    body:'Письмо из Telegram',collectionId:undefined,receipt:JSON.stringify(mockParams.incoming[0]),
  }),expect.anything()));
});

test('MSG-6.A: existing renamed Inbox remains one default choice and user can explicitly select Notes',async()=>{
  (ensureSections as jest.Mock).mockResolvedValue([
    {id:'notes',name:'Заметки',slug:'notes',sensitivity:'standard'},
    {id:'inbox-db',name:'Полученное',slug:'inbox',sensitivity:'sensitive'},
  ]);
  mockParams={incoming:[
    {shareType:'image',value:'content://telegram/a.jpg',mimeType:'image/jpeg'},
    {shareType:'image',value:'content://telegram/b.jpg',mimeType:'image/jpeg'},
  ]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByText(/Коллекция: Полученное · Изменить/)).toBeTruthy());
  expect(ui.getByText('Новая заметка · альбом')).toBeTruthy();
  fireEvent.press(ui.getByLabelText('Выбрать коллекцию'));
  expect(ui.getAllByLabelText('Коллекция: Полученное')).toHaveLength(1);
  fireEvent.press(ui.getByLabelText('Коллекция: Заметки'));
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',expect.objectContaining({
    collectionId:'notes',files:expect.arrayContaining([expect.objectContaining({name:'a.jpg'})]),
  }),expect.anything()));
});

test('MSG-6.B: exact Share replay shows truthful existing status and does not run reindexing',async()=>{
  mockParams={incoming:[{shareType:'text',value:'Мой рецепт от 7 ноября'}]};
  (saveMediaNote as jest.Mock).mockImplementationOnce(async (_profile:any,options:any)=>{
    options.onReplay({entityId:'already',recordStatus:'active'});return 'already';
  });
  const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{});
  try {
    const ui=render(<MemoryImportScreen/>);
    await waitFor(()=>expect(ui.getByText(/Коллекция: Входящие/)).toBeTruthy());
    fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
    await waitFor(()=>expect(alert).toHaveBeenCalledWith('Материал уже в памяти',
      expect.stringContaining('повторная отправка'),expect.any(Array)));
    expect(require('../../direct-agent/enrich-runner').scheduleIndexTerms).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    const choices=(alert as jest.Mock).mock.calls[0][2];
    expect(choices.map((choice:any)=>choice.text)).toEqual(['Оставить черновик','Сохранить отдельно']);
    await act(async()=>{choices[1].onPress();});
    await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledTimes(2));
    expect((saveMediaNote as jest.Mock).mock.calls[1][1]).toEqual(
      expect.objectContaining({allowSeparateCopy:true}));
    await waitFor(()=>expect(mockBack).toHaveBeenCalledTimes(1));
  }finally{alert.mockRestore();}
});

test.each([
  ['trashed','корзине'],
  ['archived','архиве'],
] as const)('MSG-6.B: replay pointing at %s retains draft and explains existing location',async(status,word)=>{
  mockParams={incoming:[{shareType:'text',value:'Сохранённый материал'}]};
  (saveMediaNote as jest.Mock).mockImplementationOnce(async (_profile:any,options:any)=>{
    options.onReplay({entityId:'already',recordStatus:status});return 'already';
  });
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByText(/Коллекция: Входящие/)).toBeTruthy());
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(ui.getByText(new RegExp(word))).toBeTruthy());
  expect(mockBack).not.toHaveBeenCalled();
  expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Сохранённый материал');
  expect(require('../../direct-agent/enrich-runner').scheduleIndexTerms).not.toHaveBeenCalled();
});


test('MSG-6.C2: LLM chooses an existing collection only after per-import approval; user still saves',async()=>{
  (ensureSections as jest.Mock).mockResolvedValue([
    {id:'notes',name:'Заметки',slug:'notes',sensitivity:'standard'},
    {id:'recipes',name:'Рецепты',slug:'recipes',sensitivity:'standard'},
    {id:'inbox',name:'Получено',slug:'inbox',sensitivity:'sensitive'},
  ]);
  (classifyImportCollectionWithAgent as jest.Mock).mockResolvedValueOnce({
    collectionId:'recipes',sectionSlug:'recipes',sectionName:'Рецепты',
    topic:'Лазанья',reason:'Подпись о рецепте',tags:['лазанья','рецепты'],excerptTruncated:false,
  });
  mockParams={incoming:[{shareType:'text',value:'Лазанья на ужин #рецепты'}]};
  const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{});
  try {
    const ui=render(<MemoryImportScreen/>);
    await waitFor(()=>expect(ui.getByLabelText('Определить раздел с ИИ')).toBeTruthy());
    expect(ui.getByText(/Коллекция: Получено/)).toBeTruthy();
    expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
    expect(saveMediaNote).not.toHaveBeenCalled();
    fireEvent.press(ui.getByLabelText('Определить раздел с ИИ'));
    expect(alert).toHaveBeenCalledWith('Разрешить ИИ подобрать раздел и теги?',
      expect.stringContaining('до 2 платных обращений'),expect.any(Array));
    const choices=(alert as jest.Mock).mock.calls[0][2];
    expect(choices.map((x:any)=>x.text)).toEqual(['Отмена','Разрешить один подбор']);
    expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
    await act(async()=>{choices[1].onPress();});
    await waitFor(()=>expect(classifyImportCollectionWithAgent).toHaveBeenCalledWith(expect.objectContaining({
      body:'Лазанья на ужин #рецепты',sensitivity:'standard',explicitConsent:true,modelCallLimit:4,
      title:'Лазанья на ужин #рецепты',
    })));
    expect(ui.getByText(/Коллекция: Рецепты/)).toBeTruthy();
    expect(ui.getByLabelText('Предложенный ИИ раздел')).toBeTruthy();
    expect(saveMediaNote).not.toHaveBeenCalled();
    fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
    await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
      expect.objectContaining({body:'Лазанья на ужин #рецепты',collectionId:'recipes'}),
      expect.anything()));
  }finally{alert.mockRestore();}
});

test('MSG-6.C2: no automatic provider request for hashtags or link-only material',async()=>{
  mockParams={incoming:[{shareType:'text',value:'Моя публикация #рецепты'}]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByText(/Коллекция: Входящие/)).toBeTruthy());
  expect(ui.queryByLabelText('Выбрать предложенный раздел «Рецепты»')).toBeNull();
  expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Сохранить сведения в память'));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith('guest',
    expect.objectContaining({collectionId:undefined}),expect.anything()));
  expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
});

test('MSG-6.C2: private record or selected protected section forbids LLM classification',async()=>{
  (ensureSections as jest.Mock).mockResolvedValue([
    {id:'notes',name:'Заметки',slug:'notes',sensitivity:'standard'},
    {id:'family',name:'Семья',slug:'family',sensitivity:'sensitive'},
    {id:'inbox',name:'Входящие',slug:'inbox',sensitivity:'sensitive'},
  ]);
  mockParams={incoming:[{shareType:'text',value:'Это заметка о поездке с семьёй'}]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByLabelText('Определить раздел с ИИ')).toBeTruthy());
  fireEvent.press(ui.getByLabelText('Личные — только на телефоне'));
  expect(ui.getByLabelText('Определить раздел с ИИ').props.accessibilityState.disabled).toBe(false);
  expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText('Обычные — доступны агенту и разбору у провайдера'));
  fireEvent.press(ui.getByLabelText('Выбрать коллекцию'));
  fireEvent.press(ui.getByLabelText('Коллекция: Семья'));
  expect(ui.getByLabelText('Определить раздел с ИИ').props.accessibilityState.disabled).toBe(false);
  expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
});

test('MSG-6.C2: failed/ambiguous model request leaves draft and Inbox unchanged',async()=>{
  (classifyImportCollectionWithAgent as jest.Mock).mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('нет ответа модели'));
  mockParams={incoming:[{shareType:'text',value:'Проверка условий поездки'}]};
  const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{});
  try {
    const ui=render(<MemoryImportScreen/>);
    await waitFor(()=>expect(ui.getByLabelText('Определить раздел с ИИ')).toBeTruthy());
    fireEvent.press(ui.getByLabelText('Определить раздел с ИИ'));
    await act(async()=>{(alert as jest.Mock).mock.calls[0][2][1].onPress();});
    expect(ui.getByText(/Коллекция: Входящие/)).toBeTruthy();
    expect(ui.getByText(/не смог уверенно подобрать/)).toBeTruthy();
    fireEvent.press(ui.getByLabelText('Определить раздел с ИИ'));
    await act(async()=>{(alert as jest.Mock).mock.calls[1][2][1].onPress();});
    expect(ui.getByText(/нет ответа модели/)).toBeTruthy();
    expect(saveMediaNote).not.toHaveBeenCalled();
    expect(ui.getByLabelText('Сведения из файла').props.value).toBe('Проверка условий поездки');
  }finally{alert.mockRestore();}
});

test('MSG-6.C2: AppLock prevents even the opt-in classifier network call',async()=>{
  mockParams={incoming:[{shareType:'text',value:'Рецепт домашней лазаньи'}]};
  const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{});
  try{
    const ui=render(<MemoryImportScreen/>);
    await waitFor(()=>expect(ui.getByLabelText('Определить раздел с ИИ')).toBeTruthy());
    mockUnlocked=false;
    fireEvent.press(ui.getByLabelText('Определить раздел с ИИ'));
    expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(ui.getByText(/Разблокируйте память/)).toBeTruthy();
  }finally{alert.mockRestore();}
});

test("MSG-6.C: source card displays verified-link bounds; external link opens ONLY by explicit tap",async()=>{
  mockParams={incoming:[{shareType:"url",value:"https://t.me/public_news/123"}]};
  const opener=jest.spyOn(Linking,"openURL").mockResolvedValue(undefined as any);
  try{
    const ui=render(<MemoryImportScreen/>);
    await waitFor(()=>expect(ui.getByTestId("source-provenance-card")).toBeTruthy());
    expect(ui.getByText(/Формат публичного поста/)).toBeTruthy();
    expect(ui.queryByText(/Дата по метаданным/)).toBeNull();
    expect(opener).not.toHaveBeenCalled();
    fireEvent.press(ui.getByLabelText("Открыть ссылку на источник в браузере"));
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith("https://t.me/public_news/123");
    expect(saveMediaNote).not.toHaveBeenCalled();
    fireEvent.press(ui.getByLabelText("Сохранить сведения в память"));
    await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith("guest",
      expect.objectContaining({sourceUrl:"https://t.me/public_news/123",
        sourceCoverage:"url_only"}),expect.anything()));
  }finally{opener.mockRestore();}
});

test("MSG-6.C: explicit Telegram HTML extraction records text-only coverage, never author/date",async()=>{
  (importLink as jest.Mock).mockResolvedValueOnce({
    source:"https://t.me/public_news/123",title:"Telegram · public_news/123",
    text:"Точное сообщение публичного канала",partial:true,
    textCoverage:"telegram_post_text_only",
    telegramObservation:{messageKey:"public_news/123",textSha256:"a".repeat(64),
      textLength:36,evidence:"telegram_html_data_post_v1"},
  });
  mockParams={incoming:[{shareType:"url",value:"https://t.me/public_news/123"}]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByLabelText("Загрузить содержимое публичной ссылки после согласия")).toBeTruthy());
  fireEvent.press(ui.getByLabelText("Загрузить содержимое публичной ссылки после согласия"));
  await waitFor(()=>expect(ui.getByText(/Прочитан текст именно этого публичного поста Telegram/)).toBeTruthy());
  expect(ui.getByTestId("source-provenance-card")).toBeTruthy();
  expect(ui.getByText(/ID сообщения по data-post: public_news\/123/)).toBeTruthy();
  expect(ui.queryByText(/Дата по метаданным/)).toBeNull();
  fireEvent.press(ui.getByLabelText("Сохранить сведения в память"));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith("guest",
    expect.objectContaining({sourceCoverage:"telegram_post_text_only",
      sourceUrl:"https://t.me/public_news/123",
      telegramObservation:expect.objectContaining({messageKey:"public_news/123",textSha256:"a".repeat(64)})}),
    expect.anything()));
});

test("MSG-6.C: a plain Android Share is not misattributed to Telegram/MAX",async()=>{
  mockParams={incoming:[{shareType:"text",value:"Это моя записка от коллеги"}]};
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByTestId("source-provenance-card")).toBeTruthy());
  expect(ui.getByText(/Отправившее приложение, автор, дата и версия публикации не подтверждены/)).toBeTruthy();
  expect(ui.queryByLabelText("Открыть ссылку на источник в браузере")).toBeNull();
});

test("MSG-6C6: optional user tags remain separate from caption and are saved only after confirmation",async()=>{
  const screen=render(<MemoryImportScreen/>);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(()=>expect(screen.getByLabelText("Добавить теги")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Добавить теги"));
  expect(screen.getByLabelText("Теги заметки")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("Сведения из файла"),"Мой текст");
  fireEvent.changeText(screen.getByLabelText("Теги заметки"),"#Авто, #РЕЦЕПТЫ");
  expect(saveMediaNote).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText("Сохранить сведения в память"));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith("guest",
    expect.objectContaining({body:"Мой текст",tags:["авто","рецепты"]}),expect.anything()));
});

test("MSG-6C6: invalid tag refuses save without overwriting original caption",async()=>{
  const screen=render(<MemoryImportScreen/>);
  fireEvent.press(screen.getByLabelText("Выбрать файл для памяти"));
  await waitFor(()=>expect(screen.getByLabelText("Добавить теги")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Добавить теги"));
  expect(screen.getByLabelText("Теги заметки")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("Сведения из файла"),"Мой комментарий");
  fireEvent.changeText(screen.getByLabelText("Теги заметки"),"#bad/name");
  fireEvent.press(screen.getByLabelText("Сохранить сведения в память"));
  await waitFor(()=>expect(screen.getByText(/Тег: до 32/)).toBeTruthy());
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Сведения из файла").props.value).toBe("Мой комментарий");
});

test("IMPORT-AUTO: Save offers one informed LLM consent, then persists tags and section atomically",async()=>{
  (ensureSections as jest.Mock).mockResolvedValue([
    {id:"inbox",slug:"inbox",name:"Входящие",sensitivity:"sensitive"},
    {id:"recipes",slug:"recipes",name:"Рецепты",sensitivity:"standard"},
  ]);
  (classifyImportCollectionWithAgent as jest.Mock).mockResolvedValueOnce({
    collectionId:"recipes",sectionSlug:"recipes",sectionName:"Рецепты",
    topic:"Рецепт лазаньи",reason:"Текст про приготовление",
    tags:["лазанья","рецепты"],excerptTruncated:false,
  });
  mockParams={incoming:[{shareType:"text",value:"Приготовим лазанью на ужин с томатами"}]};
  const alert=jest.spyOn(Alert,"alert").mockImplementation(()=>{});
  const ui=render(<MemoryImportScreen/>);
  await waitFor(()=>expect(ui.getByText(/Коллекция: Входящие/)).toBeTruthy());
  fireEvent.press(ui.getByLabelText("Сохранить сведения в память"));
  expect(alert).toHaveBeenCalledWith("Автоматические теги и раздел",
    expect.stringContaining("Оригиналы"),expect.any(Array));
  expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
  const approve=(alert as jest.Mock).mock.calls[0][2][1];
  await act(async()=>{approve.onPress();});
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith("guest",expect.objectContaining({
    tags:["лазанья","рецепты"],collectionId:"recipes",body:"Приготовим лазанью на ужин с томатами",
  }),expect.anything()));
  expect(classifyImportCollectionWithAgent).toHaveBeenCalledTimes(1);
  expect(classifyImportCollectionWithAgent).toHaveBeenCalledWith(expect.objectContaining({
    explicitConsent:true,sensitivity:"standard",body:"Приготовим лазанью на ужин с томатами",
  }));
  alert.mockRestore();
});

test("IMPORT-AUTO: an unrecognized photo remains savable; AI action explains missing text",async()=>{
  const ui=render(<MemoryImportScreen/>);
  fireEvent.press(ui.getByLabelText("Выбрать файл для памяти"));
  await waitFor(()=>expect(ui.getByLabelText("Определить раздел с ИИ")).toBeTruthy());
  expect(ui.getByLabelText("Определить раздел с ИИ").props.accessibilityState.disabled).toBe(false);
  fireEvent.press(ui.getByLabelText("Определить раздел с ИИ"));
  expect(ui.getByText(/добавьте подпись или распознайте текст/)).toBeTruthy();
  expect(classifyImportCollectionWithAgent).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Сохранить сведения в память"));
  await waitFor(()=>expect(saveMediaNote).toHaveBeenCalledWith("guest",
    expect.objectContaining({tags:[]}),expect.anything()));
});
