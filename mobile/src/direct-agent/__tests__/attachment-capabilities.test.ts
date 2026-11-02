import { historyForImageCapability, imageCapability } from "../attachment-capabilities";
import type { ChatAttachment } from "../chat-attachments";
import { defaultDirectPreferences } from "../settings";

const img:ChatAttachment={id:"one",name:"bike.png",mime:"image/png",kind:"image",
  data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVz8AAAAASUVORK5CYII=",size:68};
const txt:ChatAttachment={id:"two",name:"notes.txt",mime:"text/plain",kind:"text",data:"Описание",size:24};
const deepseek=(model:string,baseUrl="https://api.deepseek.com")=>({
  ...defaultDirectPreferences,provider:"openai-compatible" as const,baseUrl,model,
});
test("H5: only documented DeepSeek Flash endpoint+model is verified for inline photos",()=>{
  expect(imageCapability(deepseek("deepseek-flash"),[img])).toBe("supported");
  expect(imageCapability(deepseek("deepseek-v4-flash"),[img])).toBe("supported");
  expect(imageCapability(deepseek("deepseek-v4-flash-vision-exp"),[img])).toBe("supported");
  expect(imageCapability(deepseek("deepseek-v4-pro"),[img])).toBe("unsupported");
  expect(imageCapability(deepseek("deepseek-chat"),[img])).toBe("unsupported");
  expect(imageCapability(deepseek("deepseek-reasoner"),[img])).toBe("unsupported");
  expect(imageCapability(deepseek("deepseek-flash","https://api.deepseek.com.evil.example"),[img])).toBe("unverified");
  expect(imageCapability(deepseek("deepseek-flash","http://127.0.0.1:11434"),[img])).toBe("unverified");
});
test("H5: images remain unverified for other custom models, not silently classified as supported",()=>{
  expect(imageCapability({...defaultDirectPreferences,model:"my-vision-model"},[img])).toBe("unverified");
  expect(imageCapability({...defaultDirectPreferences,model:"text-embedding-3-small"},[img])).toBe("unsupported");
  expect(imageCapability(deepseek("deepseek-v4-pro"),[txt])).toBe("no-images");
  expect(imageCapability({...defaultDirectPreferences,model:"unknown"},[])).toBe("no-images");
});
test("H5: incompatible historical images are omitted from outbound history without deleting chat rows",()=>{
  const history=[{role:"user",content:"Что на снимке?",attachments:[img,txt]},
    {role:"assistant",content:"В ответе нет файлов"}];
  const safe=historyForImageCapability(history,"unsupported");
  expect(safe[0].attachments).toEqual([txt]);
  expect(safe[0].content).toContain("не переданы");
  expect(JSON.stringify(safe)).not.toContain(img.data);
  expect(JSON.stringify(history)).toContain(img.data);
  expect(historyForImageCapability(history,"supported")).toEqual(history);
  expect(historyForImageCapability(history,"unverified")[0].attachments).toEqual([txt]);
  expect(JSON.stringify(historyForImageCapability(history,"unverified"))).not.toContain(img.data);
  expect(historyForImageCapability(history,"unverified")[0].content).toContain("не подтверждена");
});
