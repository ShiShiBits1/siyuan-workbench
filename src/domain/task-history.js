/** Record only observed transitions. Existing done tasks never gain guessed completion dates. */
export function withTaskHistory(before,next,now=new Date()) {
  if(next.kind!=='task')return next;
  const at=new Date(now).toISOString();
  const result={...next,historyTrackingSince:before?.historyTrackingSince||at};
  if(!before&&next.status!=='done')result.completedAt=null;
  const prior=before||{status:null,endAt:null};
  const history=before?.workbenchHistory||[];
  if(!Array.isArray(history)||history.some(event=>!event||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at))))throw new Error('任务历史格式损坏，请在原生文档中核查');
  const additions=[];
  if(prior.status!==next.status){
    additions.push({type:'status',at,from:prior.status,to:next.status});
    if(next.status==='done')result.completedAt=at;
    else if(prior.status==='done')result.completedAt=null;
  }
  if((prior.endAt||null)!==(next.endAt||null))additions.push({type:'deadline',at,from:prior.endAt||null,to:next.endAt||null});
  result.workbenchHistory=[...history,...additions];
  return result;
}

/** A source-backed snapshot; period is [from,to), with no updatedAt inference. */
export function workReportSnapshot(tasks,events,{from,to,now=new Date()}={}) {
  const lower=Date.parse(from),upper=Date.parse(to),current=new Date(now).getTime();
  if(!Number.isFinite(lower)||!Number.isFinite(upper)||lower>=upper||!Number.isFinite(current))throw new Error('周报周期无效');
  const unique=items=>[...new Map(items.map(item=>[item.id,item])).values()];
  const selected=unique(tasks).filter(task=>task.kind==='task');
  for(const task of selected)if(task.workbenchHistory!=null&&!Array.isArray(task.workbenchHistory))throw new Error(`任务 ${task.id} 的历史格式无效，请核查原生文档`);
  const within=at=>Number.isFinite(Date.parse(at))&&Date.parse(at)>=lower&&Date.parse(at)<upper;
  const completed=selected.filter(task=>task.status==='done'&&within(task.completedAt));
  const reopened=selected.filter(task=>(task.workbenchHistory||[]).some(event=>event.type==='status'&&event.from==='done'&&event.to!=='done'&&within(event.at)));
  const rescheduled=selected.filter(task=>(task.workbenchHistory||[]).some(event=>event.type==='deadline'&&event.from&&event.to&&Date.parse(event.to)>Date.parse(event.from)&&within(event.at)));
  const overdue=selected.filter(task=>task.status!=='done'&&task.endAt&&Date.parse(task.endAt)<current);
  const unknownCompletion=selected.filter(task=>task.status==='done'&&!Number.isFinite(Date.parse(task.completedAt)));
  const limitedCoverage=selected.filter(task=>{const tracked=Date.parse(task.historyTrackingSince),created=Date.parse(task.createdAt);return !Number.isFinite(tracked)||tracked>Math.max(lower,Number.isFinite(created)?created:lower);});
  const scheduled=unique(events).filter(event=>{const start=Date.parse(event.startAt||event.endAt),end=Date.parse(event.endAt||event.startAt);return event.kind==='event'&&Number.isFinite(start)&&Number.isFinite(end)&&(start===end?start>=lower&&start<upper:start<upper&&end>lower);});
  return {from,to,asOf:new Date(current).toISOString(),completed,reopened,rescheduled,overdue,events:scheduled,unknownCompletion,limitedCoverage};
}

export function formatWorkReport(snapshot) {
  const safe=value=>String(value||'').replace(/[\[\]<>`\r\n]/g,' ');
  const items=rows=>rows.map(row=>`- [${safe(row.title)}](siyuan://blocks/${row.id})`).join('\n')||'- 本次可读取记录中无符合项。';
  return `# 工作周报事实底稿\n\n周期：${snapshot.from} 至 ${snapshot.to}（结束时间不含）。快照时间：${snapshot.asOf}。\n\n## 周期内完成且当前仍完成\n\n${items(snapshot.completed)}\n\n## 周期内曾撤回完成\n\n${items(snapshot.reopened)}\n\n## 周期内有截止时间延后记录\n\n${items(snapshot.rescheduled)}\n\n## 当前逾期未完成（快照，不代表历史期末状态）\n\n${items(snapshot.overdue)}\n\n## 周期内日程安排（不证明实际参加）\n\n${items(snapshot.events)}\n\n## 数据覆盖\n\n${snapshot.unknownCompletion.length} 项已完成任务没有可靠完成时间，未归入周期完成。${snapshot.limitedCoverage.length} 项任务的历史未覆盖整个周期。不能据此断言没有其他已完成或延期工作；来源删除、移动或未记录的实际结果不在本底稿中。投入工时与节约时间未记录，不作估算。\n`;
}
