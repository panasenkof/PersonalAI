import React from 'react';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {ShareDestinationScreen} from '../ShareDestinationScreen';
import {prepareSharedMaterial} from '../../media/share-destination';
const mockNavigation={popTo:jest.fn(),replace:jest.fn(),goBack:jest.fn()};
const mockStore={sharedDraft:jest.fn(),appendSharedDraft:jest.fn()};
let mockLock:(value:boolean)=>void;let mockUnlocked=true;
const mockIncoming=[{shareType:'text',value:'Hello'}];
jest.mock('@react-navigation/native',()=>({useNavigation:()=>mockNavigation,useRoute:()=>({params:{incoming:mockIncoming}})}));
jest.mock('react-native-safe-area-context',()=>({useSafeAreaInsets:()=>({bottom:24})}));
jest.mock('../../direct-agent/ChatContext',()=>({useDirectChat:()=>({store:mockStore,active:{id:'chat',title:'Current'}})}));
jest.mock('../../profile/ProfileContext',()=>({useProfile:()=> 'guest'}));
jest.mock('../../local-memory/storage',()=>({localMemorySessionUnlocked:()=>mockUnlocked,onLocalMemorySessionChange:(fn:any)=>{mockLock=fn;return jest.fn();}}));
jest.mock('../../media/share-destination',()=>({prepareSharedMaterial:jest.fn()}));
jest.mock('../../media/ChatAttachmentList',()=>({ChatAttachmentList:()=>null}));
jest.mock('../../theme',()=>({useTheme:()=>({})}));
const prepared={text:'Hello',names:['Текст'],files:[],attachments:[],chatError:'',memoryError:''};
beforeEach(()=>{jest.clearAllMocks();mockUnlocked=true;mockStore.sharedDraft.mockImplementation(()=>({}));(prepareSharedMaterial as jest.Mock).mockResolvedValue(prepared);});
async function ready(s:any){await waitFor(()=>expect(s.queryByLabelText('Проверка входящих материалов')).toBeNull());}
test('chooser does not apply data until explicit chat choice, and repeated presses cannot duplicate',async()=>{const s=render(<ShareDestinationScreen/>);await ready(s);expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();fireEvent.press(s.getByLabelText('Добавить входящее в чат'));fireEvent.press(s.getByLabelText('Добавить входящее в чат'));expect(mockStore.appendSharedDraft).toHaveBeenCalledTimes(1);expect(mockStore.appendSharedDraft).toHaveBeenCalledWith('chat','Hello',[]);expect(mockNavigation.popTo).toHaveBeenCalledWith('Tabs',{screen:'Home'});});
test('memory opens the existing preview with original payloads and never modifies chat',async()=>{const s=render(<ShareDestinationScreen/>);await ready(s);fireEvent.press(s.getByLabelText('Добавить входящее в память'));expect(mockNavigation.replace).toHaveBeenCalledWith('MemoryImport',{incoming:mockIncoming});expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();});
test('unsupported chat format stays disabled and cancellation makes no mutation',async()=>{(prepareSharedMaterial as jest.Mock).mockResolvedValue({...prepared,chatError:'Аудио пока недоступно в чате'});const s=render(<ShareDestinationScreen/>);await ready(s);fireEvent.press(s.getByLabelText('Добавить входящее в чат'));expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();expect(s.getByText('Аудио пока недоступно в чате')).toBeTruthy();fireEvent.press(s.getByLabelText('Отменить приём материала'));expect(mockNavigation.goBack).toHaveBeenCalled();});
test('lock clears prepared data and disables both destinations',async()=>{const s=render(<ShareDestinationScreen/>);await ready(s);act(()=>{mockUnlocked=false;mockLock(false);});fireEvent.press(s.getByLabelText('Добавить входящее в чат'));fireEvent.press(s.getByLabelText('Добавить входящее в память'));expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();expect(mockNavigation.replace).not.toHaveBeenCalled();expect(s.queryByText('Hello')).toBeNull();});
test('unmount aborts outstanding preparation and ignores late completion',async()=>{let resolve:any;(prepareSharedMaterial as jest.Mock).mockReturnValue(new Promise(r=>{resolve=r;}));const s=render(<ShareDestinationScreen/>);const signal=(prepareSharedMaterial as jest.Mock).mock.calls[0][1];s.unmount();expect(signal.aborted).toBe(true);await act(async()=>resolve(prepared));expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();});

test('H3a: shows each ready and failed file, only ready attachment is added after explicit choice',async()=>{
  const accepted:any={id:'t1',name:'recipe.txt',kind:'text',mime:'text/plain',data:'Рецепт',size:12};
  (prepareSharedMaterial as jest.Mock).mockResolvedValue({
    ...prepared,text:'',files:[{name:'recipe.txt'},{name:'voice.mp3'}],
    attachments:[accepted],chatStatuses:[
      {name:'recipe.txt',state:'ready'},
      {name:'voice.mp3',state:'error',reason:'Формат файла не поддерживается в чате.'},
    ],
  });
  const s=render(<ShareDestinationScreen/>);await ready(s);
  expect(s.getByLabelText('Готово для чата: recipe.txt')).toBeTruthy();
  expect(s.getByLabelText('Не удалось подготовить: voice.mp3')).toBeTruthy();
  expect(s.getByText('Для чата готово: 1 из 2')).toBeTruthy();
  expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();
  fireEvent.press(s.getByLabelText('Добавить входящее в чат'));
  expect(mockStore.appendSharedDraft).toHaveBeenCalledWith('chat','',[accepted]);
  expect(mockStore.appendSharedDraft).toHaveBeenCalledTimes(1);
});

test('H3a: retry preparation is user-initiated and no chat or memory is created by retry',async()=>{
  (prepareSharedMaterial as jest.Mock).mockResolvedValue({...prepared,
    files:[{name:'broken.pdf'}],chatStatuses:[
      {name:'broken.pdf',state:'error',reason:'В PDF нет читаемого текстового слоя.'},
    ],chatError:'Нет готовых файлов для чата.',attachments:[],text:'',
  });
  const s=render(<ShareDestinationScreen/>);await ready(s);
  expect(prepareSharedMaterial).toHaveBeenCalledTimes(1);
  fireEvent.press(s.getByLabelText('Повторить подготовку файлов'));
  await waitFor(()=>expect(prepareSharedMaterial).toHaveBeenCalledTimes(2));
  expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();
  expect(mockNavigation.replace).not.toHaveBeenCalled();
});

test('H3a: failed file cannot enable Chat when there is no ready text or attachment',async()=>{
  (prepareSharedMaterial as jest.Mock).mockResolvedValue({...prepared,text:'',
    files:[{name:'broken.pdf'}],attachments:[],
    chatStatuses:[{name:'broken.pdf',state:'error',reason:'Не удалось прочитать файл.'}],
    chatError:'Нет готовых файлов для чата.',
  });
  const s=render(<ShareDestinationScreen/>);await ready(s);
  fireEvent.press(s.getByLabelText('Добавить входящее в чат'));
  expect(mockStore.appendSharedDraft).not.toHaveBeenCalled();
  fireEvent.press(s.getByLabelText('Добавить входящее в память'));
  expect(mockNavigation.replace).toHaveBeenCalledWith('MemoryImport',{incoming:mockIncoming});
});
