export const days=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
export function stamp(value,zone='Europe/Moscow'){return value?new Intl.DateTimeFormat('ru-RU',{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value*1000)):'Пока нет';}
export function queueHealth(count){return count>=50?{tone:'green',label:'Запас в порядке'}:count>=30?{tone:'yellow',label:'Пора пополнить запас'}:count>=10?{tone:'orange',label:'Запас заканчивается'}:{tone:'red',label:'Нужны новые товары'};}
export function searchState(schedule,status,now=Date.now()/1000){
  if(!schedule.search_enabled)return {tone:'muted',title:'Поиск на паузе'};
  if(status.search_retry_at>now)return {tone:'yellow',title:'WB ограничил запросы',detail:'Ожидание '+Math.ceil((status.search_retry_at-now)/60)+' мин. Поиск продолжится автоматически.'};
  if(status.last_scan_error)return {tone:'orange',title:'Поиск временно недоступен',detail:'Повторим автоматически. Посты продолжаются из очереди.'};
  return {tone:'green',title:'Поиск работает',detail:'Свежие товары добавляются в запас.'};
}
export function mainProblem(status){if(status.last_error||status.error)return 'Публикация требует проверки — подробности в диагностике.';if(!status.cron_active)return 'Планировщик давно не отвечал.';if(status.watchdog_overdue)return 'Публикация задержалась.';return '';}
export function insightText(i){const prefix={category:'Тема',price:'Цена',hour:'Время'}[i.scope]||'Наблюдение';return {title:prefix+': '+i.key,description:i.rate>=.65?'Чаще получала положительные реакции':i.rate<=.35?'Чаще получала отрицательные реакции':'Пока смешанные реакции',detail:i.positive+' положительных · '+i.negative+' отрицательных'};}

