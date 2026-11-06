import {mountTaskReschedule} from './task-reschedule.js';
import {mountCalendarEventEditor} from './calendar-event-editor.js';
import {recordsForDay,weekDays} from '../src/domain/planner.js';
import {createViewTransition} from './view-transition.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateText=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseDate=value=>{const d=new Date(`${value}T12:00:00`);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(d.getTime())||dateText(d)!==value)throw new Error('日期无效');return d;};
const time=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
/** A full-page native-tab calendar with stable event editing. */
export function mountCalendarWorkspace(container,options={}) {
  const now=()=>new Date(typeof options.now==='function'?options.now():options.now??Date.now());
  let selected=options.initialDate||dateText(now()),anchor=selected,mode='month',tasks=[],events=[],disposed=false,generation=0,loaded=false,loading=false;
  let editor=null,dragTask=null,undoToken=null,undoBusy=false,moveUncertain=false,agendaMode='selected';
  let clockDay=dateText(now());
  parseDate(selected);
  const motion=createViewTransition(container.ownerDocument.defaultView);
  container.innerHTML=`<section class="swcal" aria-label="大日历"><header class="swcal__header"><div><h1>日历</h1><p>任务与日程，在同一张时间表里。</p></div><div class="swcal__actions"><button type="button" data-calendar-action="refresh">刷新</button><button type="button" data-calendar-mode="month" aria-pressed="true">月视图</button><button type="button" data-calendar-mode="week" aria-pressed="false">周视图</button></div></header><div class="swcal__navigation"><div><button type="button" data-calendar-action="previous" aria-label="上一月或周">‹</button><strong data-calendar-period></strong><button type="button" data-calendar-action="next" aria-label="下一月或周">›</button><button type="button" data-calendar-action="today">今天</button></div><label>定位日期<input type="date" aria-label="日历定位日期" value="${selected}"></label></div><p class="swcal__legend">● 任务　◆ 日程　✓ 已完成 <span>提醒为记录中的安排时间，不表示已送达。</span></p><p class="swcal__status" role="status"></p><p class="swcal__error" role="alert" hidden></p><div class="swcal__undo" role="status"></div><div class="swcal__editor"></div><div class="swcal__layout"><aside class="swcal__sidebar" aria-label="日程卡片"><label class="swcal__range-label">日程范围<select aria-label="日程范围"><option value="selected">选中日期</option><option value="recent">最近日程 · 未来7天</option></select></label><section class="swcal__agenda" aria-label="当日完整安排"></section><details class="swcal__backlog" aria-label="待安排任务"></details></aside><div class="swcal__content"></div></div></section>`;
  const root=container.firstElementChild,content=root.querySelector('.swcal__content'),agenda=root.querySelector('.swcal__agenda'),backlog=root.querySelector('.swcal__backlog'),error=root.querySelector('[role="alert"]'),picker=root.querySelector('input');
  const fail=message=>{error.textContent=message;error.hidden=!message;};
  const records=()=>[...tasks,...events];
  function item(record,compact=false){
    const task=record.kind==='task',done=task&&record.status==='done';
    return `<article class="swcal__record ${task?'is-task':'is-event'} ${done?'is-complete':''}" data-calendar-record="${escape(record.id)}" ${task&&options.moveTask?'draggable="true"':''}><button type="button" data-calendar-open="${escape(record.id)}"><span>${done?'✓':task?'● 任务':'◆ 日程'}</span> ${escape(record.title)}</button>${!compact?`<p>${escape([time(record.startAt),record.endAt?'至 '+time(record.endAt):'',task?({todo:'待办',in_progress:'进行中',done:'已完成'}[record.status]||''):'' ,record.priority?({urgent:'紧急',high:'高优先级',normal:'普通',low:'低优先级'}[record.priority]||''):''].filter(Boolean).join(' · '))}</p>${record.reminderAt?`<small>提醒 ${escape(time(record.reminderAt))}</small>`:''}`:''}${task&&options.moveTask?`<button type="button" data-calendar-move="${escape(record.id)}">改期</button>`:''}</article>`;
  }
  function syncAgendaMode(){const select=root.querySelector('[aria-label="日程范围"]');select.querySelectorAll('option').forEach(option=>{option.selected=false;});select.querySelector('[value="'+agendaMode+'"]').selected=true;}
  function render(){
    if(disposed)return;
    clockDay=dateText(now());
    const d=parseDate(anchor);let days;
    if(mode==='week')days=weekDays(anchor);else{const first=new Date(d.getFullYear(),d.getMonth(),1,12);first.setDate(first.getDate()-(first.getDay()+6)%7);days=Array.from({length:42},(_,i)=>{const x=new Date(first);x.setDate(first.getDate()+i);return dateText(x);});}
    root.querySelector('[data-calendar-period]').textContent=mode==='month'?`${d.getFullYear()}年${d.getMonth()+1}月`:`${days[0]} — ${days[6]}`;
    root.querySelectorAll('[data-calendar-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.calendarMode===mode)));
    root.querySelector('.swcal__status').textContent=loading?'正在读取日历…':loaded?`${tasks.length} 项任务 · ${events.length} 项日程`:'日历暂未加载';
    content.innerHTML=`<div class="swcal__grid is-${mode}">${'一二三四五六日'.split('').map(day=>`<div class="swcal__weekday">周${day}</div>`).join('')}${days.map(day=>{const dayRecords=recordsForDay(records(),day).sort((a,b)=>(a.startAt||a.endAt||'').localeCompare(b.startAt||b.endAt||'')||a.id.localeCompare(b.id));const shown=mode==='month'?dayRecords.slice(0,3):dayRecords;return `<section class="swcal__day ${day===selected?'is-selected':''} ${day===dateText(now())?'is-today':''} ${day.slice(0,7)!==anchor.slice(0,7)&&mode==='month'?'is-outside':''}" aria-label="${day}"><button type="button" class="swcal__date" data-calendar-date="${day}" aria-pressed="${day===selected}">${mode==='week'?day.slice(5):Number(day.slice(8))}</button>${shown.map(record=>item(record,true)).join('')}${shown.length<dayRecords.length?`<button type="button" class="swcal__more" data-calendar-more="${day}">还有 ${dayRecords.length-shown.length} 项</button>`:''}</section>`;}).join('')}</div>`;
    const recentStart=dateText(now());
    const end=parseDate(recentStart);end.setDate(end.getDate()+6);
    const recentEnd=dateText(end);
    const recentDays=Array.from({length:7},(_,index)=>{const day=parseDate(recentStart);day.setDate(day.getDate()+index);return dateText(day);});
    const daily=recordsForDay(records(),selected);
    const shown=agendaMode==='recent'
      ? events.filter(record=>recentDays.some(day=>recordsForDay([record],day).length)).sort((a,b)=>(a.startAt||a.endAt||'').localeCompare(b.startAt||b.endAt||'')||a.id.localeCompare(b.id))
      : daily;
    const heading=agendaMode==='recent'?'最近日程 · 未来7天':selected+' · 完整安排';
    const empty=agendaMode==='recent'?'未来7天暂无已排期日程':'当天没有已排期的任务或日程';
    agenda.setAttribute('aria-label',agendaMode==='recent'?'最近日程':'当日完整安排');
    agenda.innerHTML=`<h2>${heading} <span>${loaded?shown.length:'—'}</span></h2>${agendaMode==='recent'?`<p class="swcal__range">${recentStart} 至 ${recentEnd}</p>`:''}${options.createEvent?'<button type="button" data-calendar-action="create-event">新建日程</button>':''}${shown.length?shown.map(record=>item(record)).join(''):`<p>${loaded?empty:'等待日历数据'}</p>`}`;
    syncAgendaMode();
    const pending=tasks.filter(task=>task.status!=='done'&&!task.startAt&&!task.endAt);const unscheduled=events.filter(event=>!event.startAt&&!event.endAt);backlog.innerHTML=`<summary>待安排 <span>${loaded?pending.length+unscheduled.length:'—'} 项</span></summary><div class="swcal__backlog-content"><h2>待安排 <span>${loaded?pending.length:'—'}</span></h2><p>没有排期的未完成任务集中放在这里。</p>${pending.map(record=>item(record)).join('')||`<p>${loaded?'暂无待安排任务':'等待日历数据'}</p>`}<h2>未排期日程</h2>${unscheduled.map(event=>item(event)).join('')||'<p>暂无未排期日程</p>'}</div>`;
  }
  async function refresh(){if(disposed||editor||undoBusy)return false;const request=++generation;loading=true;fail('');render();try{const result=await Promise.all([options.listTasks(),options.listEvents()]);if(disposed||request!==generation)return;if(!result.every(Array.isArray))throw new Error('日历数据响应无效');const unique=list=>[...new Map(list.map(record=>[record.id,record])).values()];tasks=unique(result[0]);events=unique(result[1]);loaded=true;moveUncertain=false;return true;}catch(failure){if(!disposed&&request===generation)fail(`读取失败：${failure.message||'请重试'}。${loaded?'保留上次读取结果。':'未显示空库统计。'}`);}finally{if(!disposed&&request===generation){loading=false;render();}}}
  function blocked(){if(!editor&&!undoBusy)return false;fail('请先完成或取消当前编辑，再切换日期或查看其他记录。');return true;}
  function closeEditor(){editor?.dispose();editor=null;root.querySelector('.swcal__editor').innerHTML='';}
  function editEvent(record){
    if(blocked())return;
    const host=root.querySelector('.swcal__editor');
    editor=mountCalendarEventEditor(host,{record,date:selected,...options,
      reconcile:async()=>{
        const request=++generation;const result=await Promise.all([options.listTasks(),options.listEvents()]);
        if(disposed||request!==generation)throw new Error('核查已过期，请重新核查');
        if(!result.every(Array.isArray))throw new Error('核查列表响应无效');tasks=result[0];events=result[1];loaded=true;render();return events;
      },
      onSaved:(record,{reopen=false}={})=>{if(disposed)return;closeEditor();++generation;loading=false;events=[...events.filter(event=>event.id!==record.id),record];render();if(reopen)editEvent(record);},
      onDeleted:id=>{if(disposed)return;closeEditor();++generation;loading=false;events=events.filter(event=>event.id!==id);render();},onClose:closeEditor});
    host.scrollIntoView?.({block:'nearest',behavior:'auto'});
  }
  function editMove(task,date){
    if(blocked()||!task||!options.moveTask)return;if(moveUncertain){fail('上次改期结果需先刷新核查。');return;}
    const host=root.querySelector('.swcal__editor');editor=mountTaskReschedule(host,{task,date,moveTask:options.moveTask,onClose:closeEditor,onUncertain:()=>{moveUncertain=true;},onSaved:result=>{if(disposed)return;closeEditor();++generation;loading=false;tasks=tasks.map(row=>row.id===result.record.id?result.record:row);undoToken=result.undoToken;root.querySelector('.swcal__undo').innerHTML='<span>任务已改期。</span> <button type="button" data-calendar-action="undo-move">撤销本次改期</button>';fail('');render();}});host.scrollIntoView?.({block:'nearest'});
  }
  const dragstart=event=>{const row=event.target.closest('[data-calendar-record]');if(!row||!options.moveTask||editor||undoBusy||moveUncertain)return;const task=tasks.find(task=>task.id===row.dataset.calendarRecord);if(!task)return;dragTask=task.id;event.dataTransfer?.setData('application/x-siyuan-workbench-task',task.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';};
  const dragover=event=>{const day=event.target.closest('.swcal__day');if(dragTask&&day&&!editor&&!undoBusy){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';}};
  const drop=event=>{const day=event.target.closest('.swcal__day');if(!dragTask||!day)return;event.preventDefault();const task=tasks.find(task=>task.id===dragTask);dragTask=null;editMove(task,day.getAttribute('aria-label'));};
  const dragend=()=>{dragTask=null;};
  function selectDay(day){if(blocked())return;selected=day;agendaMode='selected';picker.value=day;render();}
  async function click(event){if(disposed||event.target.closest('.swcal__editor'))return;const button=event.target.closest('button');if(button?.disabled)return;
    if(!button){const day=event.target.closest('.swcal__day');if(day&&!event.target.closest('.swcal__record'))selectDay(day.getAttribute('aria-label'));return;}
    if(!root.contains(button))return;try{
    if(button.dataset.calendarMove){editMove(tasks.find(task=>task.id===button.dataset.calendarMove),selected);return;}
    if(button.dataset.calendarOpen){const record=records().find(record=>record.id===button.dataset.calendarOpen);if(record?.kind==='event'&&(options.updateEvent||options.deleteEvent)){editEvent(record);return;}if(blocked())return;if(!options.onOpenRecord)throw new Error('尚未配置原生文档打开');await options.onOpenRecord(button.dataset.calendarOpen);return;}
    if(button.dataset.calendarMore){selectDay(button.dataset.calendarMore);return;}
    if(button.dataset.calendarDate){selectDay(button.dataset.calendarDate);return;}
    if(button.dataset.calendarMode){if(blocked())return;mode=button.dataset.calendarMode;anchor=selected;render();motion.show(content);return;}
    const action=button.dataset.calendarAction;if(action==='refresh')return refresh();
    if(blocked())return;
    if(action==='undo-move'&&undoToken&&options.undoTaskMove){const token=undoToken;undoBusy=true;button.disabled=true;try{const record=await options.undoTaskMove(token);if(disposed)return;if(!record?.id)throw Error('撤销结果未确认。');tasks=tasks.map(task=>task.id===record.id?record:task);undoToken=null;root.querySelector('.swcal__undo').textContent='本次改期已撤销。';++generation;render();}catch(failure){if(!disposed){undoToken=null;root.querySelector('.swcal__undo').textContent='撤销未确认，请刷新核查；未重复提交。';fail(failure.message||'无法撤销，任务可能已修改。');}}finally{undoBusy=false;}return;}
    if(action==='create-event'){editEvent();return;}
    if(action==='today'){selected=anchor=dateText(now());agendaMode='selected';picker.value=selected;}
    else if(action==='previous'||action==='next'){const d=parseDate(anchor),offset=action==='next'?1:-1;if(mode==='month')d.setDate(1),d.setMonth(d.getMonth()+offset);else d.setDate(d.getDate()+7*offset);anchor=dateText(d);selected=anchor;agendaMode='selected';picker.value=selected;}
    else return;render();motion.show(content);
  }catch(failure){if(!disposed)fail(failure.message||'操作失败');}}
  const agendaChange=event=>{if(event.target.getAttribute('aria-label')!=='日程范围')return;if(blocked()){syncAgendaMode();return;}agendaMode=event.target.value==='recent'?'recent':'selected';render();};
  const change=()=>{if(blocked()){picker.value=selected;return;}try{parseDate(picker.value);selected=anchor=picker.value;agendaMode='selected';render();motion.show(content);}catch(failure){fail(failure.message);}};
  root.addEventListener('dragstart',dragstart);root.addEventListener('dragover',dragover);root.addEventListener('drop',drop);root.addEventListener('dragend',dragend);root.addEventListener('click',click);picker.addEventListener('change',change);root.addEventListener('change',agendaChange);void refresh();
  return {refresh,refreshClock(){if(disposed)return;const today=dateText(now());if(agendaMode==='recent'&&today!==clockDay&&!editor&&!undoBusy){render();return;}root.querySelectorAll('.swcal__day').forEach(day=>day.classList.toggle('is-today',day.getAttribute('aria-label')===today));},selectDate(value){if(disposed)return;if(blocked())return false;parseDate(value);selected=anchor=value;agendaMode='selected';picker.value=value;render();motion.show(content);},dispose(){disposed=true;editor?.dispose();++generation;motion.dispose();root.removeEventListener('dragstart',dragstart);root.removeEventListener('dragover',dragover);root.removeEventListener('drop',drop);root.removeEventListener('dragend',dragend);root.removeEventListener('click',click);picker.removeEventListener('change',change);root.removeEventListener('change',agendaChange);}};
}
