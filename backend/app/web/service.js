fetch('/v1/service/info').then(response=>response.json()).then(info=>{
 const box=document.getElementById('info');box.replaceChildren();
 const p=document.createElement('p');p.textContent=`${info.name}, версия ${info.version}. Оператор: ${info.operator || 'не указан — уточните у владельца установки'}. Срок хранения резервных копий: ${info.backup_retention_days} дней.`;box.append(p);
 for(const [label,value] of [['Поддержка',info.support_email ? 'mailto:'+info.support_email : ''],['Политика обработки данных',info.privacy_url],['Условия использования',info.terms_url]]){
  if(!value)continue;const url=new URL(value,location.href);if(!['https:','mailto:'].includes(url.protocol))continue;
  const link=document.createElement('a');link.textContent=label;link.href=url.href;const row=document.createElement('p');row.append(link);box.append(row);
 }
}).catch(()=>{document.getElementById('info').textContent='Не удалось загрузить сведения. Проверьте соединение.';});
