const formatTime = new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

export function mountRecordDock(element,{kind,getNotebookId,listTasks,listEvents,onOpenRecord,onOpenWorkbench}) {
    const tasksOnly=kind==='task';
    const title=tasksOnly?'未完成任务':'提醒中心';
    element.innerHTML=`<section class="swrd" aria-label="${title}侧栏">
        <header><h2>${title}</h2><button type="button" data-record-dock-refresh>刷新</button></header>
        <p role="status"></p><p role="alert" hidden></p>
        <ul class="swrd__list"></ul>
        <footer><button type="button" data-record-dock-full>${tasksOnly?'打开任务与周计划':'打开完整提醒中心'}</button></footer>
    </section>`;
    const root=element.firstElementChild, doc=element.ownerDocument;
    const list=root.querySelector('ul'), status=root.querySelector('[role="status"]');
    const alert=root.querySelector('[role="alert"]'), reload=root.querySelector('[data-record-dock-refresh]');
    let disposed=false, generation=0;
    const error=message=>{alert.textContent=message;alert.hidden=!message;};
    const time=record=>Date.parse(tasksOnly?record.endAt:record.reminderAt);
    const sortableTime=record=>Number.isFinite(time(record))?time(record):Infinity;

    function render(records,notebookId) {
        const now=Date.now();
        for (const record of records) {
            const row=doc.createElement('li'), button=doc.createElement('button'), detail=doc.createElement('p');
            button.type='button';
            button.className='swrd__title';
            button.textContent=record.title;
            button.addEventListener('click',()=>open(()=>{
                if(getNotebookId()!==notebookId) throw new Error('数据笔记本已切换，请先刷新。');
                return onOpenRecord(record.id);
            }));
            const date=time(record);
            if (tasksOnly) {
                const state=record.status==='in_progress'?'进行中':'待办';
                detail.textContent=Number.isFinite(date)?`${state} · 截止 ${formatTime.format(date)}`:state;
            } else {
                const name=record.kind==='task'?'任务':'日程';
                const state=record.kind==='task'&&record.status==='done'?'已完成':date<=now?'已到期':'即将提醒';
                detail.textContent=`${name} · ${formatTime.format(date)} · ${state}`;
            }
            row.append(button,detail);list.append(row);
        }
    }

    async function refresh() {
        if (disposed) return;
        const request=++generation, notebookId=getNotebookId();
        list.replaceChildren();error('');
        if (!notebookId) {
            status.textContent='请先在工作台设置中选择数据笔记本。';
            reload.disabled=false;return;
        }
        status.textContent='正在读取…';reload.disabled=true;
        const current=()=>!disposed&&generation===request&&getNotebookId()===notebookId;
        try {
            const [tasks,events]=await Promise.all([listTasks(notebookId),tasksOnly?[]:listEvents(notebookId)]);
            if (!current()) return;
            const records=[...tasks.filter(task=>!tasksOnly||task.status!=='done'),...events]
                .filter(record=>tasksOnly||Number.isFinite(time(record)))
                .sort((a,b)=>Number(a.status==='done')-Number(b.status==='done')
                    || sortableTime(a)-sortableTime(b)
                    || a.title.localeCompare(b.title,'zh-CN'));
            status.textContent=records.length?`共 ${records.length} 项`:tasksOnly?'当前没有未完成任务。':'当前没有提醒安排。';
            render(records,notebookId);
        } catch(failure) {
            if (current()) {status.textContent='';error(failure?.message||'读取失败，请刷新重试。');}
        } finally {if (!disposed&&generation===request) reload.disabled=false;}
    }

    async function open(action) {
        error('');
        try {await action();}
        catch(failure) {if(!disposed) error(failure?.message||'无法打开，请重试。');}
    }

    reload.addEventListener('click',refresh);
    root.querySelector('[data-record-dock-full]').addEventListener('click',()=>open(onOpenWorkbench));
    void refresh();
    return {refresh,dispose(){disposed=true;element.replaceChildren();}};
}
