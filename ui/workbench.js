import {mountCategoryPicker} from './category-picker.js';
import {mountTaskChecklist,checklistSummary} from './task-checklist.js';
import { hasCalendarMark } from './calendar-mark.js';
import {mountCalendarDayPreview} from './calendar-day-preview.js';
import {createLatestRequest} from './latest-request.js';
import {getWorkbenchOverview} from '../src/domain/planner.js';
import {overviewCardsHTML} from './overview-cards.js';

/**
 * 思源工作台视图层。数据由插件入口传入，所有持久化通过 callbacks 回到插件数据适配层。
 * mountWorkbench(container, { tasks, events, onSave, onComplete, onDateChange }) => cleanup
 */
const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const localDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const overlapsLocalDay = (startAt, endAt, dateText) => {
  const [year, month, day] = dateText.split('-').map(Number);
  const dayStart = new Date(year, month - 1, day).getTime();
  const nextDay = new Date(year, month - 1, day + 1).getTime();
  let start = startAt ? Date.parse(startAt) : null;
  let end = endAt ? Date.parse(endAt) : null;
  if (start === null && end === null) return true;
  if (start === null) start = end;
  if (end === null) end = start;
  return start < nextDay && end >= dayStart;
};
const statusLabels = { todo: "待办", in_progress: "进行中", done: "已完成", 待办: "待办", 进行中: "进行中", 已完成: "已完成" };
const statusValues = { 待办: "todo", 进行中: "in_progress", 已完成: "done" };
const statusLabel = status => statusLabels[status] || "待办";
const priorityLabels = { low: "低", normal: "普通", high: "高", urgent: "紧急", "低": "低", "普通": "普通", "中": "普通", "高": "高", "紧急": "紧急" };
const priorityValues = { "低": "low", "普通": "normal", "中": "normal", "高": "high", "紧急": "urgent" };
const normalizePriority = value => {
  if (value === "" || value === null || value === undefined) return null;
  const normalized = Object.prototype.hasOwnProperty.call(priorityValues, value) ? priorityValues[value] : value;
  if (!["low", "normal", "high", "urgent"].includes(normalized)) throw new Error("任务优先级无效，请重新选择");
  return normalized;
};
const inputDateTime = value => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${localDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
const isoDateTime = value => value ? new Date(value).toISOString() : null;
const upsertRecord = (records, persisted) => {
  const index = records.findIndex(record => record.id === persisted.id);
  if (index < 0) return [persisted, ...records];
  const result = records.filter(record => record.id !== persisted.id);
  result.splice(index, 0, persisted);
  return result;
};

const timeLabel = (value) => {
  if (!value) return "时间未定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未定";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
};

// One clock per module, so closing the dialog only detaches its view and never leaks an interval.
const pomodoro = { phase: "focus", status: "idle", deadline: 0, remainingMs: 25 * 60_000, interval: null, listeners: new Set(), notifiedRun: 0, run: 0 };
let pomodoroSettings = {focusMinutes:25,breakMinutes:5,target:null};
const phaseDuration = phase => (phase === "focus" ? pomodoroSettings.focusMinutes : pomodoroSettings.breakMinutes) * 60_000;
function validatePomodoroSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || Object.keys(settings).some(key => !['focusMinutes','breakMinutes','target'].includes(key))
    || !Number.isInteger(settings.focusMinutes) || settings.focusMinutes < 1 || settings.focusMinutes > 180
    || !Number.isInteger(settings.breakMinutes) || settings.breakMinutes < 1 || settings.breakMinutes > 60) throw new Error('专注为 1–180 分钟，休息为 1–60 分钟，均需整数');
  const target=settings.target;
  if (target!==null && (!target || typeof target!=='object' || Array.isArray(target)
    || Object.keys(target).some(key=>!['notebookId','id','title'].includes(key))
    || typeof target.notebookId!=='string' || typeof target.id!=='string'
    || !/^\d{14}-[a-z0-9]{7}$/.test(target.notebookId) || !/^\d{14}-[a-z0-9]{7}$/.test(target.id)
    || typeof target.title!=='string' || !target.title.trim() || target.title.length>200)) throw new Error('专注目标无效');
  return {focusMinutes:settings.focusMinutes,breakMinutes:settings.breakMinutes,target:target?{notebookId:target.notebookId,id:target.id,title:target.title}:null};
}
export function getPomodoroConfiguration() { return {...pomodoroSettings,target:pomodoroSettings.target?{...pomodoroSettings.target}:null}; }
export function detachPomodoroTask(notebookId,id) {
  if (!pomodoroSettings.target || pomodoroSettings.target.notebookId!==notebookId || pomodoroSettings.target?.id!==id) return false;
  pomodoroSettings={...pomodoroSettings,target:null};emitClock();return true;
}
export function configurePomodoro(settings) {
  const validated=validatePomodoroSettings(settings);
  if (pomodoro.status==='running') throw new Error('计时正在运行，请先暂停，再应用设置并重置本轮');
  stopClockLoop();pomodoroSettings=validated;pomodoro.status='idle';pomodoro.deadline=0;
  pomodoro.remainingMs=phaseDuration(pomodoro.phase);pomodoro.run+=1;pomodoro.notifiedRun=-1;emitClock();
  return getPomodoroState();
}
export function controlPomodoro(action) {
  if (!['start','resume','pause','reset','focus','break'].includes(action)) throw new Error('计时操作无效');
  if ((action==='start'||action==='resume') && pomodoro.status==='running') return getPomodoroState();
  clockAction(action);return getPomodoroState();
}
export function setPomodoroNotifier(notify){
  if(notify!==null&&typeof notify!=='function')throw new Error('计时提醒回调无效');
  pomodoro.notify=notify;
}
export function subscribePomodoro(listener) {
  if (typeof listener!=='function') throw new Error('计时监听器无效');
  pomodoro.listeners.add(listener);listener(clockSnapshot());return ()=>pomodoro.listeners.delete(listener);
}
const clockSnapshot = () => {
  const remainingMs = pomodoro.status === "running" ? Math.max(0, pomodoro.deadline - Date.now()) : pomodoro.remainingMs;
  return { phase: pomodoro.phase, status: pomodoro.status, remainingMs, run: pomodoro.run };
};
const emitClock = () => pomodoro.listeners.forEach(listener => listener(clockSnapshot()));
const stopClockLoop = () => { if (pomodoro.interval) clearInterval(pomodoro.interval); pomodoro.interval = null; };
export function suspendPomodoro() {
  if (pomodoro.status === "running") {
    pomodoro.remainingMs = Math.max(0, pomodoro.deadline - Date.now());
    pomodoro.status = "paused";
  }
  stopClockLoop();
  pomodoro.notify = null;
  pomodoro.listeners.clear();
}
export function getPomodoroState() {
  const {phase, status, remainingMs} = clockSnapshot();
  const snapshot={phase, status, remainingMs};
  if (pomodoroSettings.focusMinutes!==25 || pomodoroSettings.breakMinutes!==5 || pomodoroSettings.target) snapshot.settings=getPomodoroConfiguration();
  return snapshot;
}

export function restorePomodoroState(state) {
  let settings;
  try {settings=Object.hasOwn(state||{},'settings')?validatePomodoroSettings(state.settings):{focusMinutes:25,breakMinutes:5,target:null};} catch{return false;}
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !['focus', 'break'].includes(state.phase)
    || !['idle', 'paused', 'running', 'finished'].includes(state.status)
    || typeof state.remainingMs !== 'number' || !Number.isFinite(state.remainingMs)
    || state.remainingMs < 0 || state.remainingMs > (state.phase==='focus'?settings.focusMinutes:settings.breakMinutes)*60_000) return false;
  suspendPomodoro();
  pomodoroSettings=settings;
  pomodoro.phase = state.phase;
  const paused = ['running', 'paused'].includes(state.status) && state.remainingMs > 0;
  pomodoro.status = paused ? 'paused' : 'idle';
  pomodoro.remainingMs = paused ? state.remainingMs : phaseDuration(state.phase);
  pomodoro.deadline = 0;
  pomodoro.run += 1;
  pomodoro.notifiedRun = -1;
  return true;
}
const startClockLoop = () => {
  stopClockLoop();
  pomodoro.interval = setInterval(() => {
    const remaining = Math.max(0, pomodoro.deadline - Date.now());
    pomodoro.remainingMs = remaining;
    if (remaining === 0) {
      stopClockLoop(); pomodoro.status = "finished"; emitClock();
      if (pomodoro.notifiedRun !== pomodoro.run) {
        pomodoro.notifiedRun = pomodoro.run;
        const message=pomodoro.phase === "focus" ? "专注时间结束，休息一下。" : "休息结束，准备开始下一轮。";
        let delivered=false;
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try{new Notification("番茄钟完成",{body:message});delivered=true;}catch{/* Fall back to the plugin notifier if native notification creation fails. */}
        }
        if(!delivered)pomodoro.notify?.(message);
      }
    } else emitClock();
  }, 250);
};
const clockAction = action => {
  if (action === "start" || action === "resume") {
    if (pomodoro.status === "idle" || pomodoro.status === "finished") { pomodoro.remainingMs = phaseDuration(pomodoro.phase); pomodoro.run += 1; }
    pomodoro.deadline = Date.now() + pomodoro.remainingMs; pomodoro.status = "running"; startClockLoop();
  } else if (action === "pause" && pomodoro.status === "running") {
    pomodoro.remainingMs = Math.max(0, pomodoro.deadline - Date.now()); pomodoro.status = "paused"; stopClockLoop();
  } else if (action === "reset") {
    stopClockLoop(); pomodoro.status = "idle"; pomodoro.remainingMs = phaseDuration(pomodoro.phase);
  } else if (action === "break" || action === "focus") {
    stopClockLoop(); pomodoro.phase = action; pomodoro.status = "idle"; pomodoro.remainingMs = phaseDuration(action);
  }
  emitClock();
};
const renderClock = root => {
  const snapshot = clockSnapshot();
  const seconds = Math.ceil(snapshot.remainingMs / 1000);
  const label = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const time = root.querySelector("[data-clock-time]");
  if (!time) return;
  time.textContent = label;
  const status = root.querySelector("[data-clock-status]");
  if (status) status.textContent = snapshot.status === "running" ? (snapshot.phase==='focus'?"正在专注":"正在休息") : snapshot.status === "paused" ? "已暂停" : snapshot.status === "finished" ? "本轮完成" : snapshot.phase === "focus" ? "准备专注" : "准备休息";
  const start = root.querySelector('[data-clock-action="start"], [data-clock-action="pause"], [data-clock-action="resume"]');
  if (start) start.textContent = snapshot.status === "paused" ? "继续" : snapshot.status === "running" ? "暂停" : "开始";
  if (start) start.dataset.clockAction = snapshot.status === "running" ? "pause" : snapshot.status === "paused" ? "resume" : "start";
  root.querySelectorAll("[data-clock-phase]").forEach(button => {button.classList.toggle("is-active", button.dataset.clockPhase === snapshot.phase);button.textContent=button.dataset.clockPhase==='focus'?`专注 ${pomodoroSettings.focusMinutes}`:`休息 ${pomodoroSettings.breakMinutes}`;});
};

export function mountWorkbench(container, options = {}) {
  let disposed = false;
  const dayRequest = createLatestRequest();
  const monthRequest = createLatestRequest();
  let selectedDate = options.date || localDate(new Date());
  let visibleMonth = new Date(`${selectedDate.slice(0, 7)}-01T12:00:00`);
  let tasks = [...(options.tasks || [])];
  let events = [...(options.events || [])];
  let monthTasks = [...tasks];
  let monthEvents = [...events];
  let monthPreviewStatus = '当天没有日程';
  const calendarPreview = mountCalendarDayPreview(container, date => monthEvents
    .filter(event => hasCalendarMark(event,date))
    .sort((a,b) => (Date.parse(a.startAt||a.endAt)||0)-(Date.parse(b.startAt||b.endAt)||0)), () => monthPreviewStatus);
  let filter = "all";
  let loadError = "";
  let savingRecord=false, deletingTask=false, deleteNeedsReconcile=false, noteCreating=false, projectCreating=false, taskRevision=0;
  let overviewState={data:null,error:'',includeJobs:Boolean(options.showReviewOverview)},overviewGeneration=0,overviewInputs=null,overviewReadAt=null;
  const overviewNow=()=>new Date(typeof options.now==='function'?options.now():options.now??Date.now());
  function recomputeOverview(){if(!overviewInputs)return;const data=getWorkbenchOverview(overviewInputs.tasks,overviewInputs.events,overviewNow());if(options.showReviewOverview){data.awaitingReviewJobs=Array.isArray(overviewInputs.jobs)?overviewInputs.jobs.filter(job=>job.state==='awaiting_review'):null;data.reviewError=overviewInputs.reviewError||'';}overviewState={...overviewState,data,error:''};}
  function updateOverviewDOM(){if(!overviewState.data||overviewState.error)return;for(const [key,value] of Object.entries(overviewState.data)){const number=container.querySelector(`[data-overview="${key}"] strong`);if(number&&Array.isArray(value))number.textContent=String(value.length);}const hint=container.querySelector('[data-overview="todayTasks"] small');if(hint){const date=localDate(overviewNow()),read=overviewReadAt?.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})||'未知';hint.textContent=`本地今日 ${date} · 数据读取 ${overviewReadAt?localDate(overviewReadAt).slice(5)+' ':''}${read}`;hint.title='今日待办为本地今日内已排期且未完成的任务；数字按已读取记录随时间重算。';}}
  async function refreshOverview(){
    if(!options.loadOverview||disposed)return;const request=++overviewGeneration;
    try{const value=await options.loadOverview();if(disposed||request!==overviewGeneration||savingRecord)return;if(!Array.isArray(value?.tasks)||!Array.isArray(value?.events))throw new Error('概览数据响应无效');overviewInputs=value;overviewReadAt=overviewNow();recomputeOverview();}
    catch(error){if(disposed||request!==overviewGeneration||savingRecord)return;overviewInputs=null;overviewState={...overviewState,data:null,error:error?.message||'请重试'};}
    render();
  }
  function applySavedRecord(record,isTask){
    // Reads launched before the save receipt cannot replace this confirmed local state.
    ++taskRevision;++overviewGeneration;
    if(isTask){tasks=upsertRecord(tasks,record);monthTasks=upsertRecord(monthTasks,record);}
    else{events=upsertRecord(events,record);monthEvents=upsertRecord(monthEvents,record);}
    if(overviewInputs){const key=isTask?'tasks':'events';overviewInputs={...overviewInputs,[key]:upsertRecord(overviewInputs[key],record)};recomputeOverview();}
  }
  if(typeof options.onNotify==='function')setPomodoroNotifier(options.onNotify);

  const render = () => {
    if (disposed) return;
    calendarPreview.close();
    const activeModal = container.querySelector('.swb__modal-host');
    const dayTasks = tasks.filter(item => overlapsLocalDay(item.startAt, item.endAt, selectedDate));
    const dayEvents = events.filter(item => overlapsLocalDay(item.startAt, item.endAt, selectedDate));
    const visibleTasks = dayTasks.filter(item => filter === "all" || statusLabel(item.status) === filter);
    const completed = dayTasks.filter(item => statusLabel(item.status) === "已完成").length;
    const date = new Date(`${selectedDate}T12:00:00`);
    const dateHeading = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(date);
    const monthCells = calendarCells(visibleMonth, selectedDate, monthTasks, monthEvents);

    container.innerHTML = `
      <main class="swb" aria-label="思源工作台">
        <header class="swb__topbar">
          <div data-workbench-page-intro class="swb__brand"><span class="swb__mark">日</span><span>工作台</span></div>
          <div class="swb__top-actions">
            <button class="swb__quiet" data-action="prev-day" aria-label="前一天">‹</button>
            <button class="swb__date" data-action="pick-date">${escapeHTML(selectedDate)}</button>
            <button class="swb__quiet" data-action="next-day" aria-label="后一天">›</button>
            <button class="swb__today" data-action="today">今天</button>
          </div>
        </header>

        <section class="swb__welcome">
          <div><p class="swb__eyebrow">${escapeHTML(selectedDate)}</p><h1>${escapeHTML(dateHeading)}</h1>
          <p class="swb__subline">完成 ${completed} / ${dayTasks.length} 项任务</p></div>
          <div class="swb__progress" aria-label="今日完成进度"><span style="--progress:${dayTasks.length ? Math.round(completed / dayTasks.length * 100) : 0}%"></span></div>
        </section>

        ${options.loadOverview?overviewCardsHTML(overviewState,escapeHTML):''}
        <div class="swb__overview">
        <section class="swb__calendar" aria-label="月历">
          <header class="swb__calendar-head"><h2>${visibleMonth.getFullYear()}年${visibleMonth.getMonth() + 1}月</h2><div>${options.onOpenCalendar?'<button class="swb__text-button" data-action="open-calendar">展开日历</button>':''}<button class="swb__quiet" data-action="prev-month" aria-label="上个月">‹</button><button class="swb__quiet" data-action="next-month" aria-label="下个月">›</button></div></header>
          <div class="swb__calendar-grid"><div class="swb__weekday">一</div><div class="swb__weekday">二</div><div class="swb__weekday">三</div><div class="swb__weekday">四</div><div class="swb__weekday">五</div><div class="swb__weekday">六</div><div class="swb__weekday">日</div>${monthCells}</div>
        </section>
        <section class="swb__pomodoro" aria-label="番茄计时器"><div><p class="swb__eyebrow">专注时间</p><strong data-clock-time>25:00</strong><span data-clock-status>准备专注</span></div><div class="swb__pom-controls"><div><button data-clock-phase="focus" class="is-active">专注 25</button><button data-clock-phase="break">休息 5</button></div><button class="swb__save" data-clock-action="start">开始</button><button class="swb__cancel" data-clock-action="reset">重置</button></div></section>
        </div>
      ${loadError ? `<p class="swb__error" role="alert">${escapeHTML(loadError)}</p>` : ""}

        <section class="swb__quick" aria-label="快速新增">
          <button class="swb__quick-task" data-action="new-task"><span class="swb__plus">＋</span><span>记一件要做的事</span><kbd>N</kbd></button>
          <button class="swb__quick-event" data-action="new-event"><span>＋</span>安排日程</button>
          ${options.onCreateProject?`<button class="swb__quick-project" data-action="new-project" ${projectCreating?'disabled':''}><span aria-hidden="true">＋</span>${projectCreating?'正在打开项目…':'新建项目'}</button>`:''}
          <button class="swb__quick-note" data-action="new-note" ${options.onCreateNote && !noteCreating ? "" : "disabled"}><span>▤</span>${noteCreating?"正在打开笔记…":"新建笔记"}</button>
        </section>

        <div class="swb__columns">
          <section class="swb__section swb__tasks">
            <div class="swb__section-head"><div><span class="swb__section-icon swb__section-icon--task">✓</span><h2>任务</h2><span class="swb__count">${dayTasks.length}</span></div>
              <select class="swb__filter" aria-label="筛选任务"><option value="all">全部</option><option value="待办">待办</option><option value="进行中">进行中</option><option value="已完成">已完成</option></select>
            </div>
            <div class="swb__list" data-list="tasks">${visibleTasks.length ? visibleTasks.map(taskCard).join("") : `<div class="swb__empty"><span>◇</span><strong>${dayTasks.length ? "这个筛选下没有任务" : "今天还没有任务"}</strong><small>先记下来，之后再安排时间也可以。</small><button data-action="new-task">＋ 新建任务</button></div>`}</div>
          </section>

          <section class="swb__section swb__events">
            <div class="swb__section-head"><div><span class="swb__section-icon swb__section-icon--event">◷</span><h2>日程</h2><span class="swb__count">${dayEvents.length}</span></div><button class="swb__text-button" data-action="new-event">＋ 添加</button></div>
            <div class="swb__timeline" data-list="events">${dayEvents.length ? dayEvents.map(eventCard).join("") : `<div class="swb__empty swb__empty--event"><span>◷</span><strong>日程留白</strong><small>安排一个会议或专注时段。</small><button data-action="new-event">＋ 新建日程</button></div>`}</div>
          </section>
        </div>
        <footer class="swb__footer"><span>内容保存在思源工作空间</span><span>计时在本次插件运行期间持续；关闭思源后不保证提醒</span></footer>
        <div class="swb__modal-host"></div>
      </main>`;
    if (activeModal?.firstChild) container.querySelector('.swb__modal-host').replaceWith(activeModal);
    container.querySelector(".swb__filter").value = filter;
    renderClock(container);updateOverviewDOM();
  };

  function calendarCells(month, selected, dayTasks, dayEvents) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(first.getDate() - offset);
    const today = localDate(new Date());
    return Array.from({ length: 42 }, (_, index) => {
      const current = new Date(start); current.setDate(start.getDate() + index);
      const key = localDate(current);
      const inMonth = current.getMonth() === month.getMonth();
      const hasTask = dayTasks.some(item => hasCalendarMark(item, key));
      const hasEvent = dayEvents.some(item => hasCalendarMark(item, key));
      return `<button class="swb__day ${inMonth ? "" : "is-outside"} ${key === selected ? "is-selected" : ""} ${key === today ? "is-today" : ""}" data-calendar-date="${key}" aria-label="${key}${hasTask ? " 有任务" : ""}${hasEvent ? " 有日程" : ""}"><span>${current.getDate()}</span><i>${hasTask ? `<b></b>` : ""}${hasEvent ? `<em></em>` : ""}</i></button>`;
    }).join("");
  }

  function taskCard(item) {
    const done = statusLabel(item.status) === "已完成";
    const priorityText = priorityLabels[item.priority] || item.priority;
    const priority = priorityText ? `<span class="swb__priority swb__priority--${escapeHTML(priorityText)}">${escapeHTML(priorityText)}</span>` : "";
    const tags = (item.tags || []).slice(0, 3).map(tag => `<span class="swb__tag">${escapeHTML(tag)}</span>`).join("");
    const clock = item.startAt || item.endAt ? `<span>◷ ${timeLabel(item.startAt)}${item.endAt ? `–${timeLabel(item.endAt)}` : ""}</span>` : "";
    return `<article class="swb__task ${done ? "is-done" : ""}"><button class="swb__check" data-complete="${escapeHTML(item.id)}" aria-label="${done ? "标记未完成" : "完成任务"}">${done ? "✓" : ""}</button><button class="swb__task-body" data-edit-task="${escapeHTML(item.id)}"><strong>${escapeHTML(item.title || "未命名任务")}</strong><span class="swb__meta">${item.category ? `<span>${escapeHTML(item.category)}</span>` : ""}${clock}${priority}${tags}</span>${checklistSummary(item)?`<span class="swb__meta">${escapeHTML(checklistSummary(item))}</span>`:''}</button>${options.onOpenTask?`<button type="button" class="swb__text-button" data-edit-task-properties="${escapeHTML(item.id)}">编辑属性</button>`:""}${options.onDelegateTask&&!done?`<button type="button" class="swb__text-button" data-delegate-task="${escapeHTML(item.id)}">交给 Agent</button>`:''}${options.onDeleteTask?`<button type="button" class="swb__text-button swb__danger" data-delete-task="${escapeHTML(item.id)}" aria-label="删除任务：${escapeHTML(item.title||'未命名任务')}" ${deletingTask||deleteNeedsReconcile?'disabled':''}>删除</button>`:''}</article>`;
  }

  function eventCard(item) {
    return `<article class="swb__event"><div class="swb__event-time">${timeLabel(item.startAt)}${item.endAt ? `<small>${timeLabel(item.endAt)}</small>` : ""}</div><button class="swb__event-card" data-edit-event="${escapeHTML(item.id)}"><strong>${escapeHTML(item.title || "未命名日程")}</strong><span>${item.category ? escapeHTML(item.category) : "日程"}${item.reminderAt ? " · 有提醒" : ""}</span></button></article>`;
  }

  function showForm(type, item = {}, inline = null) {
    if(savingRecord||deletingTask||container.querySelector(".swb__modal-host form"))return;
    const isTask = type === "task";
    if(isTask&&deleteNeedsReconcile){loadError="请刷新核查删除结果后再编辑任务。";render();return;}
    const title = isTask ? "任务" : "日程";
    const dateVal = selectedDate;
    let pendingCreateID = item._pendingCreate ? item.id : "";
    let commitStateUnknown = false;
    let saveInProgress = false;
    let uploadInProgress=false;
    const attachmentNames=new Map();
    let attachmentPaths = Array.isArray(item.attachmentPaths) ? [...item.attachmentPaths] : [];
    const field = (label, key, kind = "text", value = "", extra = "") => `<label class="swb__field"><span>${label}</span><input name="${key}" type="${kind}" value="${escapeHTML(value || "")}" ${extra}></label>`;
    const timeField = (label, key, defaultValue = "") => field(label, key, "datetime-local", inputDateTime(item[key]) || (item.id ? "" : defaultValue));
    const modal = inline?.host || container.querySelector(".swb__modal-host");
    modal.innerHTML = `<div class="swb__scrim" data-action="close"><form class="swb__dialog" role="dialog" aria-modal="true" aria-labelledby="swb-form-title"><header><div><p>${isTask ? "把想法变成下一步" : "留出时间给重要的事"}</p><h2 id="swb-form-title">${item.id ? "编辑" : "新建"}${title}</h2></div><button type="button" class="swb__close" data-action="close" aria-label="关闭">×</button></header>
      <div class="swb__form-grid">${field("标题", "title", "text", item.title, "required autofocus")}${field("分类", "category", "text", item.category, 'placeholder="例如：项目、生活"')}
      ${isTask ? `<label class="swb__field"><span>优先级</span><select name="priority"><option value="">不设置</option>${[["high", "高"], ["normal", "普通"], ["low", "低"], ["urgent", "紧急"]].map(([value, label]) => `<option value="${value}" ${(priorityValues[item.priority] || item.priority) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="swb__field"><span>状态</span><select name="status">${["待办", "进行中", "已完成"].map(x => `<option ${statusLabel(item.status) === x || (!item.status && x === "待办") ? "selected" : ""}>${x}</option>`).join("")}</select></label><label class="swb__field swb__field--wide"><span>标签 <small>用逗号分隔</small></span><input name="tags" value="${escapeHTML((item.tags || []).join(", "))}" placeholder="写作, 本周"></label>` : ""}
      ${timeField("开始时间", "startAt", `${dateVal}T09:00`)}${timeField("结束时间", "endAt")}${field("提醒时间", "reminderAt", "datetime-local", inputDateTime(item.reminderAt))}
      ${isTask ? `<div class="swb__field swb__field--wide swb__attachment-drop" tabindex="0" role="group" aria-label="任务附件上传区域"><span>附件 <small>选择文件，或在这里粘贴、拖入图片</small></span><div class="swb__attachments"><input name="attachmentPaths" type="hidden" value="${escapeHTML(attachmentPaths.join("；"))}"><input class="swb__attachment-files" type="file" multiple hidden aria-label="选择本地任务附件"><button type="button" class="swb__upload-attachments" ${options.onUploadAttachments?'':'disabled'}>上传附件</button><button type="button" class="swb__clear-assets" ${attachmentPaths.length ? "" : "disabled"}>清空关联</button></div><ul class="swb__attachment-list" aria-label="已关联附件"></ul><p class="swb__attachment-status" role="status" aria-live="polite"></p><small>移除、清空或取消任务仅解除关联，不删除已上传资源。</small></div>` : ""}
      ${isTask?'<div class="swb__field swb__field--wide" data-task-checklist></div>':''}<label class="swb__field swb__field--wide"><span>详细内容${item.id?' <small>此处更新记录详情，原生正文独立保留。</small>':''}</span><textarea name="detail" rows="3" placeholder="补充说明…">${escapeHTML(item.detail || "")}</textarea></label></div>
      <p class="swb__form-error" role="alert" hidden></p>
      <footer><button type="button" class="swb__cancel" data-action="close">取消</button><button type="submit" class="swb__save">保存${title}</button></footer></form></div>`;
    const form = modal.querySelector("form");
    if(inline){
      form.classList.add('swb__inline-task-form');
      form.removeAttribute('role');form.removeAttribute('aria-modal');form.removeAttribute('aria-labelledby');
      form.setAttribute('aria-label','编辑任务属性');
      form.querySelector('header').remove();
      modal.replaceChildren(form);
    }
    if (options.listCategories) mountCategoryPicker(form.querySelector('[name="category"]'), () => options.listCategories(isTask ? 'task' : 'event'));
    const checklist=isTask?mountTaskChecklist(form.querySelector('[data-task-checklist]'),item.checklist):null;
    let formDisposed=false;
    const currentForm=()=>!disposed&&!formDisposed&&modal.querySelector('form')===form&&form.isConnected!==false;
    const snapshot=()=>JSON.stringify({fields:Array.from(new FormData(form)),checklist:checklist?.getValue(),attachments:attachmentPaths,newStep:form.querySelector('[data-step-new]')?.value||''});
    let baseline=inline?snapshot():'';
    let cancelRequested=false;
    const saveStatus=inline?document.createElement('p'):null;
    if(saveStatus){
      saveStatus.className='swb__inline-save-status';saveStatus.setAttribute('role','status');form.append(saveStatus);
      const clearSaved=()=>{saveStatus.textContent='';};
      form.addEventListener('input',clearSaved);form.addEventListener('change',clearSaved);
      form.addEventListener('click',event=>{if(event.target.closest('[data-step-action],[data-remove-attachment],.swb__clear-assets'))clearSaved();});
    }
    if(inline)form.querySelector('[data-action="close"]').addEventListener('click',async event=>{
      event.preventDefault();event.stopPropagation();
      if(uploadInProgress||saveInProgress)return;
      const previous=baseline;baseline=snapshot();cancelRequested=true;
      if(await inline.onCancel?.()===false&&currentForm()){baseline=previous;cancelRequested=false;}
    });
    const attachmentLabel=path=>{if(attachmentNames.has(path))return attachmentNames.get(path);const last=String(path).split('/').pop()||path;try{return decodeURIComponent(last);}catch{return last;}};
    const renderAttachments = () => {
      const input=form.querySelector('[name="attachmentPaths"]'),clear=form.querySelector('.swb__clear-assets'),list=form.querySelector('.swb__attachment-list');
      const blocked=uploadInProgress||saveInProgress||commitStateUnknown;
      if(input)input.value=attachmentPaths.join('；');
      if(clear)clear.disabled=blocked||attachmentPaths.length===0;
      if(list)list.innerHTML=attachmentPaths.map(path=>`<li><button type="button" class="swb__open-attachment" data-open-attachment="${escapeHTML(path)}" title="${escapeHTML(path)}" ${!options.onOpenAttachment?'disabled':''}>${escapeHTML(attachmentLabel(path))}</button><button type="button" data-remove-attachment="${escapeHTML(path)}" ${blocked?'disabled':''} aria-label="移除关联：${escapeHTML(attachmentLabel(path))}">移除</button></li>`).join('');
      const upload=form.querySelector('.swb__upload-attachments'),files=form.querySelector('.swb__attachment-files');
      if(upload)upload.disabled=blocked||!options.onUploadAttachments;
      if(files)files.disabled=blocked||!options.onUploadAttachments;
    };
    form.querySelector('.swb__clear-assets')?.addEventListener('click',()=>{if(uploadInProgress||saveInProgress||commitStateUnknown)return;attachmentPaths=[];renderAttachments();});
    let attachmentOpenSequence=0,attachmentOpenError='';
    form.querySelector('.swb__attachment-list')?.addEventListener('click',async event=>{
      const open=event.target.closest('[data-open-attachment]');
      if(open&&!open.disabled&&currentForm()){
        const sequence=++attachmentOpenSequence,status=form.querySelector('.swb__attachment-status'),message=form.querySelector('.swb__form-error');
        try{
          const result=await options.onOpenAttachment?.(open.dataset.openAttachment);if(!currentForm()||sequence!==attachmentOpenSequence)return;
          if(attachmentOpenError&&message.textContent===attachmentOpenError){message.textContent='';message.hidden=true;}attachmentOpenError='';
          if(result?.mode==='download')status.textContent='已发起附件下载，请在下载列表查看。';
          else if(status.textContent==='已发起附件下载，请在下载列表查看。')status.textContent='';
        }catch{
          if(currentForm()&&sequence===attachmentOpenSequence){
            const text='附件暂时无法打开或下载，请稍后重试。草稿和附件关联已保留。';
            if(message.hidden||message.textContent===attachmentOpenError){message.textContent=text;message.hidden=false;attachmentOpenError=text;}else status.textContent=text;
          }
        }
        return;
      }
      const button=event.target.closest('[data-remove-attachment]');if(!button||button.disabled||uploadInProgress||saveInProgress||commitStateUnknown)return;attachmentPaths=attachmentPaths.filter(path=>path!==button.dataset.removeAttachment);renderAttachments();
    });
    const fileInput=form.querySelector('.swb__attachment-files');
    form.querySelector('.swb__upload-attachments')?.addEventListener('click',()=>{if(!currentForm()||uploadInProgress||saveInProgress||commitStateUnknown||!options.onUploadAttachments)return;fileInput.value='';fileInput.click();});
    const uploadFiles=async files=>{
      if(!files.length||!currentForm()||uploadInProgress||saveInProgress||commitStateUnknown||!options.onUploadAttachments)return;
      const status=form.querySelector('.swb__attachment-status'),submit=form.querySelector('[type="submit"]'),wasSubmitDisabled=submit.disabled;
      uploadInProgress=true;submit.disabled=true;status.textContent=`正在上传 ${files.length} 个文件：${files.map(file=>file.name).join('、')}。可继续编辑，完成后再保存任务。`;renderAttachments();
      try{
        const result=await options.onUploadAttachments(files);if(!currentForm())return;
        if(!Array.isArray(result?.uploaded)||!Array.isArray(result?.failed))throw new Error('未确认上传结果，请核查思源资源后手动重选，未自动重试。');
        for(const uploaded of result.uploaded){if(typeof uploaded?.path!=='string'||!uploaded.path)throw new Error('上传返回的资源路径无效，请核查。');if(!attachmentPaths.includes(uploaded.path))attachmentPaths.push(uploaded.path);if(!attachmentNames.has(uploaded.path))attachmentNames.set(uploaded.path,uploaded.name||attachmentLabel(uploaded.path));}
        status.textContent=`上传成功 ${result.uploaded.length} 个${result.failed.length?'；失败 '+result.failed.length+' 个：'+result.failed.map(file=>(file.name||'文件')+'（'+(file.message||'请重选重试')+'）').join('、'):''}。成功附件已保留${result.failed.length?'，失败文件可重新选择上传':''}。`;
      }catch(error){if(currentForm())status.textContent=`上传未全部确认：${error?.message||'请手动重选重试'}。已有附件与其他输入已保留，不会自动重试。`;}
      finally{uploadInProgress=false;if(currentForm()){submit.disabled=wasSubmitDisabled||commitStateUnknown;renderAttachments();}}
    };
    fileInput?.addEventListener('change',()=>{const files=Array.from(fileInput.files||[]);fileInput.value='';void uploadFiles(files);});

    const area=form.querySelector('.swb__attachment-drop');
    const isImage=file=>file&&(/^image\//i.test(file.type||'')||(!file.type&&/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name||'')));
    form.addEventListener('paste',event=>{
      if(!area||!currentForm())return;
      const data=event.clipboardData;if(!data)return;
      const editable=event.target.closest('input:not([type="file"]),textarea,[contenteditable="true"]');
      if(editable&&Array.from(data.types||[]).some(type=>type==='text/plain'||type==='text/html'))return;
      const images=Array.from(data.items||[]).filter(item=>item.kind==='file').map(item=>item.getAsFile?.()).filter(isImage);
      if(!images.length)return;event.preventDefault();
      if(uploadInProgress||saveInProgress||commitStateUnknown){form.querySelector('.swb__attachment-status').textContent='正在上传或保存，请完成后再粘贴图片。';return;}
      void uploadFiles(images);
    });
    const hasFiles=data=>Array.from(data?.items||[]).some(item=>item.kind==='file')||Array.from(data?.files||[]).length>0;
    let dragDepth=0;
    area?.addEventListener('dragenter',event=>{if(!hasFiles(event.dataTransfer))return;event.preventDefault();dragDepth++;area.classList.add('is-dragging');});
    area?.addEventListener('dragover',event=>{if(!hasFiles(event.dataTransfer))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=uploadInProgress||saveInProgress||commitStateUnknown?'none':'copy';});
    area?.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)area.classList.remove('is-dragging');});
    area?.addEventListener('drop',event=>{
      if(!hasFiles(event.dataTransfer))return;event.preventDefault();dragDepth=0;area.classList.remove('is-dragging');if(!currentForm())return;
      const status=form.querySelector('.swb__attachment-status');
      if(uploadInProgress||saveInProgress||commitStateUnknown){status.textContent='正在上传或保存，请完成后再拖入图片。';return;}
      const data=event.dataTransfer,entries=Array.from(data.items||[]).filter(item=>item.kind==='file');
      const files=entries.length?entries.filter(item=>!item.webkitGetAsEntry?.()?.isDirectory).map(item=>item.getAsFile?.()).filter(Boolean):Array.from(data.files||[]);
      const images=files.filter(isImage);
      if(!images.length){status.textContent='拖拽仅处理图片；其它文件请点击上传附件，文件夹不会导入。';return;}
      void uploadFiles(images);if(images.length<files.length)status.textContent+=' 本次仅上传图片，其它文件未导入。';
    });
    renderAttachments();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!currentForm() || commitStateUnknown || uploadInProgress || saveInProgress || savingRecord) return;
      if(inline&&form.querySelector('[data-step-new]')?.value.trim()){
        const error=form.querySelector('.swb__form-error');error.textContent='还有未添加的步骤，请点击 ＋ 添加，或清空输入后再保存。';error.hidden=false;return;
      }
      const submittedSnapshot=inline?snapshot():'';
      const values = Object.fromEntries(new FormData(form));
      // Native minute inputs must not truncate untouched seconds, milliseconds or timezone text.
      const submittedDateTime = key => values[key] === inputDateTime(item[key]) ? item[key] || null : isoDateTime(values[key]);
      const record = { ...item, title: values.title, category: values.category || null, startAt: submittedDateTime('startAt'), endAt: submittedDateTime('endAt'), reminderAt: submittedDateTime('reminderAt'), detail: values.detail || "", kind: isTask ? "task" : "event" };
      if (isTask) {
        record.status = statusValues[values.status] || "todo";
        record.tags = values.tags.split(",").map(x => x.trim()).filter(Boolean);
        record.attachmentPaths = [...attachmentPaths];
        if(checklist?.changed||(!item.id&&item.checklist))record.checklist=checklist.getValue();
      }
      const button = form.querySelector('[type="submit"]');
      const error = form.querySelector('.swb__form-error');
      const disabledBeforeSave=new Map(Array.from(form.querySelectorAll('input,textarea,select,button'),control=>[control,control.disabled]));
      saveInProgress = true;savingRecord=true;form.setAttribute('aria-busy','true');
      form.querySelectorAll('input,textarea,select,button').forEach(control=>{control.disabled=true;});
      try {
        if (isTask) record.priority = normalizePriority(values.priority);
        // Capture an existing retry ID before handing this draft to the repository.
        if (pendingCreateID) record.id = pendingCreateID;
        const saved = await options.onSave?.(record);
        if(disposed)return;
        const persisted = saved || record;
        applySavedRecord(persisted,isTask);
        if(inline){
          if(!currentForm())return;
          item={...persisted};baseline=submittedSnapshot;
          form.querySelector('.swb__form-error').hidden=true;
          saveStatus.textContent='任务已保存';
          inline.onSaved?.(persisted);
        }else if (modal.querySelector('form') === form) modal.innerHTML = '';
        render();void refreshOverview();
      } catch (saveError) {
        if(disposed)return;
        const attemptedID = record.id || pendingCreateID;
        if (!item.id && attemptedID) {
          pendingCreateID = attemptedID;
          item.id = attemptedID;
          item.docId = record.docId || attemptedID;
          item._pendingCreate = true;
        }
        const commit=saveError?.commitState??saveError?.data?.commitState;
        if (commit === 'unknown'||commit==='committed') {
          commitStateUnknown = true;
          form.dataset.needsReconcile='true';
          const uncertainID = saveError.documentID || attemptedID;
          error.textContent = `${commit==='committed'?'记录已提交，但后续同步或校验失败':'思源无法确认文档是否已提交'}（待核查 ID：${uncertainID || '未知'}；本条记录 ID：${attemptedID || '未知'}）。已锁定此草稿，保留输入；请取消并刷新核查后再修改。`;
        } else {
          error.textContent = saveError?.message || '保存失败，请检查思源连接后重试。可安全重试时会沿用同一记录 ID。';
        }
        error.hidden = false;
        button.disabled = commitStateUnknown;
      } finally {
        saveInProgress = false;savingRecord=false;
        if(!disposed){
          form.setAttribute('aria-busy','false');
          disabledBeforeSave.forEach((disabled,control)=>{control.disabled=disabled;});
          button.disabled=disabledBeforeSave.get(button)||commitStateUnknown;renderAttachments();
        }
      }
    });
    if(!inline)modal.querySelector("input[autofocus]")?.focus();
    if(inline)return {
      focus:()=>form.querySelector('[name="title"]')?.focus({preventScroll:true}),
      isUploading:()=>uploadInProgress,
      flush(){
        if(uploadInProgress)throw new Error('任务附件正在上传，请完成后再关闭。');
        if(saveInProgress)throw new Error('任务正在保存，请完成后再关闭。');
        if(commitStateUnknown&&!cancelRequested)throw new Error('任务提交结果待核查，请点击取消后刷新核查原任务。');
        if(snapshot()!==baseline)throw new Error('任务有未保存的修改，请先保存任务或点击取消。');
      },
      dispose(){formDisposed=true;modal.replaceChildren();},
    };
  }

  async function createNativeNote() {
    if(disposed||noteCreating)return;
    if(!options.onCreateNote){loadError='笔记创建接口尚未配置。';render();return;}
    noteCreating=true;loadError='';render();
    try {const created=await options.onCreateNote();if(!created)throw new Error('未确认笔记已打开，请刷新核查后重试。');}
    catch(error){if(!disposed){loadError=`新建笔记失败：${error?.message||'请重试'}`;}}
    finally{noteCreating=false;if(!disposed)render();}
  }
  async function createProject() {
    if(disposed||projectCreating)return;
    projectCreating=true;loadError='';render();
    try{if(!await options.onCreateProject?.())throw new Error('请先保存或取消正在编辑的内容，再新建项目。');}
    catch(error){if(!disposed)loadError=error?.message||'项目暂时无法打开，请重试。';}
    finally{projectCreating=false;if(!disposed)render();}
  }
  function confirmTaskDelete(task) {
    if(!task||deletingTask||deleteNeedsReconcile)return;
    const modal=container.querySelector('.swb__modal-host');
    if(modal.querySelector('form')){loadError='请先保存或取消正在编辑的内容，再删除任务。';render();return;}
    modal.innerHTML=`<div class="swb__scrim" data-action="close"><form class="swb__dialog swb__delete-dialog" role="dialog" aria-modal="true" aria-label="删除任务确认"><header><h2>删除任务</h2></header><strong class="swb__delete-title">${escapeHTML(task.title||'未命名任务')}</strong><p>将删除这条任务及其文档正文，附件文件和已有 Agent 成果保留。请确认无需保留。</p><p class="swb__form-error" role="alert" hidden></p><footer><button type="button" class="swb__cancel" data-action="close">取消</button><button type="submit" class="swb__save swb__danger">确认删除</button></footer></form></div>`;
    const form=modal.querySelector('form');form.querySelector('[data-action="close"]').focus();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(disposed||deletingTask||deleteNeedsReconcile)return;
      deletingTask=true;++taskRevision;form.setAttribute('aria-busy','true');form.querySelector('[type="submit"]').textContent='正在删除…';
      form.querySelectorAll('button').forEach(button=>{button.disabled=true;});render();
      try{
        const result=await options.onDeleteTask(task);
        if(disposed)return;
        if(result?.id!==task.id||result.deleted!==true)throw new Error('未确认任务已删除');
        tasks=tasks.filter(value=>value.id!==task.id);monthTasks=monthTasks.filter(value=>value.id!==task.id);
        if(modal.querySelector('form')===form)modal.innerHTML='';loadError='';void refreshOverview();
      }catch(failure){if(!disposed){
        const commit=failure?.commitState??failure?.data?.commitState;
        deleteNeedsReconcile=commit!=='none';
        const error=form.querySelector('[role="alert"]');error.hidden=false;
        error.textContent=deleteNeedsReconcile?`删除结果需核查：${failure?.message||'结果未知'}。请取消并刷新核查后再操作。`:`删除失败：${failure?.message||'请重试'}`;
        form.dataset.needsReconcile=String(deleteNeedsReconcile);
      }}finally{deletingTask=false;if(!disposed){form.setAttribute('aria-busy','false');form.querySelector('[type="submit"]').textContent='确认删除';form.querySelectorAll('button').forEach(button=>{button.disabled=button.type==='submit'&&deleteNeedsReconcile;});render();}}
    });
  }

  const requestMonth = monthKey => { const revision=taskRevision;if(options.onMonthChange)monthPreviewStatus='正在读取日程…';return monthRequest.run(
    () => options.onMonthChange?.(monthKey),
    data => {
      monthPreviewStatus='当天没有日程';
      if(revision!==taskRevision||savingRecord)return;
      if (data) { monthTasks = [...(data.tasks || [])]; monthEvents = [...(data.events || [])]; }
      render();
    },
    error => {monthPreviewStatus='日程读取失败';if(revision!==taskRevision||savingRecord)return; loadError = error?.message || '读取月历记录失败'; render(); },
  );};

  const changeDate = date => {
    const previousMonth=`${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth()+1).padStart(2,'0')}`;
    selectedDate = date;
    visibleMonth = new Date(`${date.slice(0, 7)}-01T12:00:00`);
    loadError = '';
    if(previousMonth!==date.slice(0,7)){monthTasks=[];monthEvents=[];}
    render();
    void requestMonth(date.slice(0, 7));
    const revision=taskRevision;return dayRequest.run(
      () => options.onDateChange?.(date),
      data => {
        if(revision!==taskRevision||savingRecord)return;
        if (data) { if(!Array.isArray(data.tasks)||!Array.isArray(data.events))throw new Error('任务或日程列表响应无效');tasks = [...data.tasks]; events = [...data.events]; deleteNeedsReconcile=false; }
        render();
      },
      error => {if(revision!==taskRevision||savingRecord)return; loadError = error?.message || '读取该日期记录失败'; render(); },
    );
  };

  const onClick = async event => {
    const target = event.target.closest("button");
    if (!target || target.disabled || disposed) return;
    if((savingRecord||deletingTask)&&!target.dataset.clockAction&&!target.dataset.clockPhase)return;
    if(target.dataset.overview){options.onOverviewSelect?.(target.dataset.overview);return;}
    if(target.dataset.action==='refresh-overview'){void refreshOverview();return;}
    if(target.dataset.action==='open-calendar'){options.onOpenCalendar?.(selectedDate);return;}
    if(target.dataset.delegateTask){void options.onDelegateTask?.(tasks.find(task=>task.id===target.dataset.delegateTask));return;}
    if (target.dataset.action === "new-task") showForm("task");
    if (target.dataset.action === "new-event") showForm("event");
    if(target.dataset.deleteTask){confirmTaskDelete(tasks.find(task=>task.id===target.dataset.deleteTask));return;}
    if (target.dataset.action === "new-note") return createNativeNote();
    if (target.dataset.action === "new-project") return createProject();
    if (target.dataset.calendarDate) { changeDate(target.dataset.calendarDate); return; }
    if (target.dataset.action === "prev-month" || target.dataset.action === "next-month") {
      visibleMonth.setMonth(visibleMonth.getMonth() + (target.dataset.action === "prev-month" ? -1 : 1));
      const monthKey = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}`;
      loadError = '';
      monthTasks = []; monthEvents = [];
      render();
      await requestMonth(monthKey);
      return;
    }
    if (target.dataset.action === "today") { changeDate(localDate(new Date())); }
    if (target.dataset.action === "prev-day" || target.dataset.action === "next-day") {
      const date = new Date(`${selectedDate}T12:00:00`); date.setDate(date.getDate() + (target.dataset.action === "prev-day" ? -1 : 1));
      changeDate(localDate(date));
    }
    if (target.dataset.action === "pick-date") {
      const picker = document.createElement("input"); picker.type = "date"; picker.value = selectedDate;
      picker.onchange = () => { if (picker.value) changeDate(picker.value); }; picker.click();
    }
    if (target.dataset.action === "close" && !deletingTask) {const modal=container.querySelector('.swb__modal-host'),reconcile=Boolean(modal.querySelector('[data-needs-reconcile="true"]'));modal.innerHTML='';if(reconcile)void changeDate(selectedDate);}
    if (target.dataset.editTask) {
      if(options.onOpenTask) {
        try { await options.onOpenTask(target.dataset.editTask); }
        catch(error){ options.onNotify?.(error?.message||'无法打开任务详情'); }
      } else showForm("task", tasks.find(x => x.id === target.dataset.editTask) || {});
    }
    if (target.dataset.editTaskProperties) showForm("task", tasks.find(x => x.id === target.dataset.editTaskProperties) || {});
    if (target.dataset.editEvent) showForm("event", events.find(x => x.id === target.dataset.editEvent) || {});
    if (target.dataset.complete && !deletingTask && !deleteNeedsReconcile) {
      const task = tasks.find(x => x.id === target.dataset.complete);
      if (task) {
        const updated = { ...task, status: statusLabel(task.status) === "已完成" ? "todo" : "done" };
        try { const saved = options.onPatchTask ? await options.onPatchTask(task.id, {status:updated.status}) : await options.onSave?.(updated); if(disposed)return;applySavedRecord(saved||updated,true);render();void refreshOverview(); }
        catch (error) { loadError = error?.message || '更新任务失败'; render(); }
      }
    }
    if (target.dataset.clockAction) clockAction(target.dataset.clockAction);
    if (target.dataset.clockPhase) clockAction(target.dataset.clockPhase);
  };
  const onChange = event => { if (event.target.matches(".swb__filter")) { filter = event.target.value; render(); } };
  const onKey = event => { if ((event.key === "n" || event.key === "N") && !event.target.closest('input,textarea,select,[contenteditable="true"]')) showForm("task"); };
  const clockListener = () => renderClock(container);
  pomodoro.listeners.add(clockListener);
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("keydown", onKey);
  render();
  void refreshOverview();
  void requestMonth(`${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, "0")}`);
  const cleanup = () => { disposed = true; calendarPreview.dispose(); dayRequest.dispose(); monthRequest.dispose(); pomodoro.listeners.delete(clockListener); container.removeEventListener("click", onClick); container.removeEventListener("change", onChange); container.removeEventListener("keydown", onKey); container.innerHTML = ""; };
  cleanup.refreshClock = () => {if(disposed)return;recomputeOverview();updateOverviewDOM();};
  cleanup.refresh = () => disposed ? undefined : Promise.all([changeDate(selectedDate),refreshOverview()]);
  cleanup.mountTaskEditor=(host,record,callbacks={})=>{
    const item=structuredClone(record);delete item.bodyId;
    const editor=showForm('task',item,{host,...callbacks});
    if(!editor)throw new Error('请先保存或取消其他任务编辑，再打开任务详情。');
    return editor;
  };
  cleanup.openNewTask = fields => {
    if(disposed||savingRecord||deletingTask||deleteNeedsReconcile||container.querySelector('.swb__modal-host form'))return false;
    const draft=Object.fromEntries(['title','category','tags','priority','detail','checklist'].filter(key=>Object.hasOwn(fields||{},key)).map(key=>[key,structuredClone(fields[key])]));
    showForm('task',draft);return Boolean(container.querySelector('.swb__modal-host form'));
  };
  return cleanup;
}
