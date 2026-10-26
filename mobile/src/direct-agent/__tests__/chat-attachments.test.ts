import { checkedChatAttachments, chatContent, type ChatAttachment } from '../chat-attachments';
import { parseConversation } from '../conversations';
const image: ChatAttachment = {id:'image',name:'test.png',mime:'image/png',kind:'image',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVz8AAAAASUVORK5CYII=',size:68};
const text: ChatAttachment = {id:'text',name:'recipe.txt',mime:'text/plain',kind:'text',data:'Индейка, чеснок',size:32};
test('validates byte limits, type signatures and text without silently truncating',()=>{
  expect(checkedChatAttachments([image,text])).toHaveLength(2);
  for(const files of [[{...image,mime:'image/jpeg'}],[{...image,data:'a'.repeat(3000000)}],[{...image,data:'http://example.org/file'}],[{...text,data:'x'.repeat(24001)}],[{...text,data:'bad\0text'}],Array(4).fill(image)])expect(()=>checkedChatAttachments(files)).toThrow();
});
test.each(['responses','chat','anthropic'] as const)('encodes real image bytes and untrusted text for %s',protocol=>{
  const content=chatContent('Сравни',[image,text],protocol) as any[];
  const part=content.find(x=>['input_image','image','image_url'].includes(x.type));
  if(protocol==='anthropic')expect(part.source).toEqual({type:'base64',media_type:'image/png',data:image.data});
  else expect(JSON.stringify(part)).toContain('data:image/png;base64,'+image.data);
  expect(JSON.stringify(content)).toContain('Индейка');
  expect(content.at(-1).text).toBe('Сравни');
  expect(chatContent('Обычный вопрос',[],protocol)).toBe('Обычный вопрос');
});
test('encrypted conversation JSON round-trips attachments; corrupt file cannot silently disappear',()=>{
  const value={id:'chat',createdAt:'now',updatedAt:'now',question:'',drafts:[],attachments:[text],rows:[{id:'row',role:'user',text:'Фото',attachments:[image]}]};
  const restored=parseConversation(JSON.stringify(value))!;
  expect(restored.attachments?.[0].data).toBe(text.data);
  expect(restored.rows[0].attachments?.[0].data).toBe(image.data);
  value.rows[0].attachments[0]={...image,data:'corrupt'};
  expect(parseConversation(JSON.stringify(value))).toBeNull();
});
