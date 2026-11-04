import {TASK_QUADRANTS} from './workbench.js';

const dateText = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function localDay(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期无效');
  const [y,m,d]=value.split('-').map(Number), day=new Date(y,m-1,d);
  if(dateText(day)!==value) throw new Error('日期无效');
  return day;
}
export function weekStart(value) {
  const day=localDay(value); day.setDate(day.getDate()-(day.getDay()+6)%7); return dateText(day);
}
export function weekDays(anchor) {
  const day=localDay(weekStart(anchor));
  return Array.from({length:7},(_,i)=>{const next=new Date(day);next.setDate(next.getDate()+i);return dateText(next);});
}
function overlaps(record,from,to) {
  let start=record.startAt?Date.parse(record.startAt):null, end=record.endAt?Date.parse(record.endAt):null;
  if(start===null && end===null) return false;
  if(start===null) start=end;if(end===null) end=start;
  return Number.isFinite(start) && Number.isFinite(end) && (start===end ? start>=from && start<to : start<to && end>from);
}
export function recordsForDay(records,value) {
  const day=localDay(value),next=new Date(day);next.setDate(next.getDate()+1);
  return records.filter(record=>overlaps(record,day.getTime(),next.getTime()));
}
export function filterTasks(tasks,filters={},now=new Date()) {
  const current=new Date(now);if(!Number.isFinite(current.getTime())) throw new Error('当前时间无效');
  const today=new Date(current.getFullYear(),current.getMonth(),current.getDate()), tomorrow=new Date(today), next7=new Date(today);
  tomorrow.setDate(tomorrow.getDate()+1);next7.setDate(next7.getDate()+7);
  const view=filters.view||'all',query=(filters.query||'').trim().toLocaleLowerCase();
  if(!['all','today','overdue','next7','unscheduled','completed'].includes(view)) throw new Error('任务视图无效');
  return tasks.filter(task=>{
    if(task.kind!=='task') return false;
    if(view==='overdue' && !(task.status!=='done' && task.endAt && Date.parse(task.endAt)<current.getTime())) return false;
    if(view==='completed' && task.status!=='done') return false;
    if(view==='unscheduled' && (task.status==='done' || task.startAt || task.endAt)) return false;
    if(view==='today' && !overlaps(task,today.getTime(),tomorrow.getTime())) return false;
    if(view==='next7' && !overlaps(task,today.getTime(),next7.getTime())) return false;
    return (!query || `${task.title}\n${task.detail||''}`.toLocaleLowerCase().includes(query))
      && (!filters.category || task.category===filters.category)
      && (!filters.tag || (task.tags||[]).includes(filters.tag))
      && (!filters.priority || task.priority===filters.priority)
      && (!filters.status || task.status===filters.status);
  });
}

export function getTaskQuadrant(task,now=new Date()) {
  const timestamp=new Date(now).getTime();if(!Number.isFinite(timestamp))throw new Error('当前时间无效');
  if(TASK_QUADRANTS.includes(task.quadrantOverride))return task.quadrantOverride;
  const important=['high','urgent'].includes(task.priority);
  const urgent=task.priority==='urgent'||Boolean(task.endAt&&Number.isFinite(Date.parse(task.endAt))&&Date.parse(task.endAt)<=timestamp+24*60*60*1000);
  return important?(urgent?'important-urgent':'important-later'):(urgent?'urgent-only':'later');
}
export function getWorkbenchOverview(tasks,events,now=new Date()) {
  const current=new Date(now);if(!Number.isFinite(current.getTime()))throw new Error('当前时间无效');
  const unique=records=>[...new Map(records.map(record=>[record.id,record])).values()];
  const open=unique(tasks).filter(task=>task.kind==='task'&&task.status!=='done');
  const scheduled=unique(events).filter(event=>event.kind==='event');
  const today=dateText(current);
  return {
    todayTasks:recordsForDay(open,today),
    overdueTasks:open.filter(task=>task.endAt&&Date.parse(task.endAt)<current.getTime()),
    unscheduledTasks:open.filter(task=>!task.startAt&&!task.endAt),
    todayEvents:recordsForDay(scheduled,today),
  };
}
