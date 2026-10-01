const get=id=>document.getElementById(id);
const fragment=new URLSearchParams(location.hash.slice(1));
for(const purpose of ['reset','verify']) if(fragment.has(purpose)){get('purpose').value=purpose;get('code').value=fragment.get(purpose);}
history.replaceState(null,'',location.pathname); // remove bearer capability from browser history
async function action(path,body,button){
  if(button.disabled)return;button.disabled=true;get('status').textContent='Подождите…';
  try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();
    if(!response.ok)throw new Error(data.detail||'request_failed');get('status').textContent=data.message;return true;
  }catch(error){const message=String(error.message);get('status').textContent=message.includes('invalid_or_expired')?'Код недействителен или истёк. Запросите новое письмо.':message.includes('invalid_otp')?'Проверьте код 2FA или используйте резервный код.':message.includes('email_service_unavailable')?'Почтовый сервис ещё не настроен. Обратитесь к владельцу сервера.':'Не удалось выполнить запрос. Проверьте данные и соединение.';}
  finally{button.disabled=false;}
}
get('requestForm').onsubmit=async event=>{event.preventDefault();await action(get('purpose').value==='reset'?'/v1/auth/password/request':'/v1/auth/email/request',{email:get('email').value.trim()},get('requestButton'));};
get('finishForm').onsubmit=async event=>{event.preventDefault();const reset=get('purpose').value==='reset';if(reset&&get('newPassword').value.length<8){get('status').textContent='Введите новый пароль от 8 символов.';return;}
  const ok=await action(reset?'/v1/auth/password/reset':'/v1/auth/email/verify',{token:get('code').value.trim(),...(reset?{new_password:get('newPassword').value,otp:get('otp').value||undefined}:{})},get('finishButton'));
  if(ok){get('code').value=get('newPassword').value=get('otp').value='';}
};
