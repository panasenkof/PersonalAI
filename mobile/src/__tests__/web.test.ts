/** @jest-environment node */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const web = path.resolve(__dirname, '../../../backend/app/web');
let dom: any, win: any, fetchMock: any;
const ok = (body: any) => ({ok:true,status:200,json:async()=>body});
beforeEach(() => {
  dom = new JSDOM(fs.readFileSync(path.join(web,'index.html'),'utf8'), {url:'https://pia.example.com/app/',runScripts:'outside-only'});
  win=dom.window;
  fetchMock=jest.fn(async(url:string)=>ok(url==='/v1/conversations'?[]:url==='/v1/facts'?{facts:[]}:{}));
  win.fetch=fetchMock; win.eval(fs.readFileSync(path.join(web,'app.js'),'utf8')); fetchMock.mockClear();
});
afterEach(()=>dom.window.close());
const el=(id:string)=>win.document.getElementById(id);
const fields=()=>{el('email').value='user@example.com';el('password').value='12345678';};
test('invalid credentials do not contact server',async()=>{await win.loginOrRegister(true);expect(fetchMock).not.toHaveBeenCalled();expect(el('authErr').textContent).toContain('email');});
test('duplicate email stays in auth with a useful message',async()=>{fields();fetchMock.mockResolvedValueOnce({ok:false,status:409,json:async()=>({detail:'email_taken'})});await win.loginOrRegister(true);expect(el('authErr').textContent).toContain('Войти');expect(el('btnLogin').disabled).toBe(false);expect(el('authView').classList.contains('hidden')).toBe(false);});
test('double submit prevented; successful login clears password',async()=>{fields();let finish:any;fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const pending=win.loginOrRegister(false);await win.loginOrRegister(false);expect(fetchMock).toHaveBeenCalledTimes(1);finish(ok({access_token:'test',refresh_token:'refresh'}));await pending;expect(el('password').value).toBe('');expect(el('welcome')).not.toBe(null);});
test('mobile menu and examples fill draft without sending',()=>{el('btnChats').click();expect(el('btnChats').getAttribute('aria-expanded')).toBe('true');win.newChat();expect(el('btnChats').getAttribute('aria-expanded')).toBe('false');el('welcome').querySelector('button').click();expect(el('input').value).toBe('Что ты умеешь?');expect(fetchMock.mock.calls.some((call:any[])=>call[0]==='/v1/messages')).toBe(false);});
test('failed send preserves draft without optimistic duplicate',async()=>{el('input').value='моя заметка';fetchMock.mockResolvedValueOnce({ok:false,status:429,json:async()=>({detail:'rate_limited'})});await win.send();expect(el('input').value).toBe('моя заметка');expect(win.document.querySelectorAll('.msg.user')).toHaveLength(0);expect(el('btnSend').disabled).toBe(false);});
test('file upload is multipart; message contains web attachment',async()=>{Object.defineProperty(el('fileInput'),'files',{value:[new win.File(['hello'],'note.txt',{type:'text/plain'})]});fetchMock.mockResolvedValueOnce(ok({storage_key:'owned-file',mime:'text/plain'}));await el('fileInput').onchange();expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(win.FormData);fetchMock.mockResolvedValueOnce(ok({conversation_id:'c',assistant_text:'Готово',pending_facts:[]}));await win.send();const send=fetchMock.mock.calls.find((call:any[])=>call[0]==='/v1/messages');expect(JSON.parse(send[1].body)).toMatchObject({channel:'web',attachments:[{storage_key:'owned-file',filename:'note.txt'}]});});
test('logout removes visible private data and tokens',()=>{win.localStorage.setItem('pia_token','test');win.localStorage.setItem('pia_refresh','test');win.addMsg('assistant','PRIVATE');win.showAttachment({filename:'private.txt'});win.logout();expect(el('msgs').textContent).toBe('');expect(win.localStorage.getItem('pia_token')).toBe(null);expect(el('attachmentBar').classList.contains('hidden')).toBe(true);});
test('worker does not intercept API or POST requests',()=>{const handlers:Record<string,any>={};require('vm').runInNewContext(fs.readFileSync(path.join(web,'sw.js'),'utf8'),{self:{addEventListener:(event:string,fn:any)=>{handlers[event]=fn;}},URL});const respondWith=jest.fn();handlers.fetch({request:{method:'GET',mode:'navigate',url:'https://pia.example.com/v1/auth/me'},respondWith});handlers.fetch({request:{method:'POST',mode:'navigate',url:'https://pia.example.com/app/'},respondWith});expect(respondWith).not.toHaveBeenCalled();});

test('wrong current password leaves the existing session intact', async()=>{win.localStorage.setItem('pia_token','existing');el('currentPass').value='wrong';el('newPass').value='new-password';fetchMock.mockResolvedValueOnce({ok:false,status:401,json:async()=>({detail:'invalid_credentials'})});await el('btnChangePassword').onclick();expect(win.localStorage.getItem('pia_token')).toBe('existing');expect(el('setMsg').textContent).toContain('Неверный');expect(fetchMock).toHaveBeenCalledTimes(1);});
 test('successful password change rotates local credentials and clears fields',async()=>{el('currentPass').value='current';el('newPass').value='new-password';fetchMock.mockResolvedValueOnce(ok({access_token:'new-token',refresh_token:'new-refresh'}));await el('btnChangePassword').onclick();expect(win.localStorage.getItem('pia_token')).toBe('new-token');expect(el('newPass').value).toBe('');});
