import {mountNotesLibrary} from './notes-library.js';
import {createViewTransition} from './view-transition.js';
import {mountDocumentTree} from './document-tree.js';

const navigationGroups = [
  ['执行', ['day', 'projects', 'planner', 'reminders', 'focus', 'task-templates']],
  ['资料与业务', ['notes', 'commodity-incidents']],
  ['Agent', ['agent', 'jobs']],
  ['工具', ['search', 'toolbox', 'diagnostics']],
];

/** Keep both views mounted so switching tabs preserves drafts and filters. */
export function mountWorkbenchShell(container, {mountDay, dayOptions, notesOptions, documentTree, views = []}) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const ids = new Set(['day', 'notes']);
  for (const view of views) {
    if (!/^[a-z][a-z0-9-]*$/.test(view.id) || ids.has(view.id) || typeof view.mount !== 'function') throw new Error('工作台视图配置无效');
    ids.add(view.id);
  }
  const labels = new Map([['day','今日工作'], ['notes','笔记与文档'], ...views.map(({id,label})=>[id,label])]);
  const pageHeaders = new Map(views.map(view=>[view.id,view]));
  pageHeaders.set('notes',{description:'在这里整理，在思源中继续写。'});
  const grouped = new Set(navigationGroups.flatMap(([, group])=>group));
  const groups = [...navigationGroups, ['其他', [...labels.keys()].filter(id=>!grouped.has(id))]];
  const tabMarkup = id=>`<button type="button" role="tab" aria-selected="${id==='day'}" tabindex="${id==='day'?0:-1}" data-workbench-view="${id}">${escape(labels.get(id))}</button>`;
  container.innerHTML = `<div class="swb-shell"><div class="swb-shell__layout">
    <button type="button" class="swb-shell__toggle" aria-expanded="false">工作台导航</button>
    <nav class="swb-shell__tabs" aria-label="工作台导航"><div role="tablist" aria-label="工作台视图" aria-orientation="vertical">${groups.map(([name,group])=>{
      const tabs=group.filter(id=>labels.has(id));
      return tabs.length?`<div class="swb-shell__group" role="group" aria-label="${name}"><div aria-hidden="true">${name}</div>${tabs.map(tabMarkup).join('')}</div>`:'';
    }).join('')}</div>${documentTree?'<div class="swb-tree" aria-label="当前笔记本文档"></div>':''}</nav>
    <div class="swb-shell__main">
      <header class="swb-shell__bar"><strong>今日工作</strong><p hidden></p></header>
      <p class="swb-shell__feedback" role="status" hidden></p>
      <section class="swb-shell__day" role="tabpanel" aria-label="今日工作"></section>
      <section class="swb-shell__notes" role="tabpanel" aria-label="笔记与文档" hidden></section>
      ${views.map(view=>`<section data-workbench-panel="${view.id}" role="tabpanel" aria-label="${escape(view.label)}" hidden></section>`).join('')}
    </div></div></div>`;
  const layout = container.querySelector('.swb-shell__layout');
  const toggle = container.querySelector('.swb-shell__toggle');
  const location = container.querySelector('.swb-shell__bar strong');
  const description = container.querySelector('.swb-shell__bar p');
  const feedback = container.querySelector('.swb-shell__feedback');
  const day = container.querySelector('.swb-shell__day');
  const notes = container.querySelector('.swb-shell__notes');
  const tabs = [...container.querySelectorAll('[data-workbench-view]')];
  let disposed = false;
  let library = null;
  let selected = 'day';
  const controllers = new Map();
  const motion=createViewTransition(container.ownerDocument.defaultView);
  const safely=operation=>Promise.resolve().then(operation).catch(()=>{});
  let creatingNote=null;
  const createNote=dayOptions.onCreateNote?()=>{
    if(disposed)return Promise.resolve();
    if(creatingNote)return creatingNote;
    creatingNote=Promise.resolve().then(()=>dayOptions.onCreateNote()).then(result=>{
      if(!disposed&&result)void safely(()=>library?.refresh());return result;
    }).finally(()=>{creatingNote=null;});
    return creatingNote;
  }:undefined;
  const cleanupDay = mountDay(day, {...dayOptions,onCreateNote:createNote});
  const cleanupTree = documentTree && mountDocumentTree(container.querySelector('.swb-tree'), {...documentTree,onOpen:()=>setNavigation(false)});

  function select(view) {
    if (disposed || !ids.has(view)) return false;
    // A tab change must not hide an unfinished daily-work form.
    if (selected === 'day' && view !== 'day' && day.querySelector('.swb__modal-host form')) return false;
    const changed = selected !== view;
    if(changed&&controllers.get(selected)?.canHide?.()===false)return false;
    if(changed)controllers.get(selected)?.onHide?.();
    selected = view;
    const header = pageHeaders.get(view);
    location.textContent = header?.heading || labels.get(view);
    description.textContent = header?.description || '';
    description.hidden = !description.textContent;
    feedback.hidden = true;
    day.hidden = view !== 'day';
    notes.hidden = view !== 'notes';
    for (const panel of container.querySelectorAll('[data-workbench-panel]')) panel.hidden = panel.dataset.workbenchPanel !== view;
    tabs.forEach(tab => {
      const active = tab.dataset.workbenchView === view;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    if (view === 'notes' && !library) {
      library = mountNotesLibrary(notes, {...notesOptions, onCreateNote:createNote});
    } else if (view === 'notes' && changed) void safely(()=>library?.refresh());
    const extra = views.find(item => item.id === view);
    if (extra) {
      if (!controllers.has(view)) controllers.set(view, extra.mount(container.querySelector(`[data-workbench-panel="${view}"]`)));
      else if (changed && extra.autoRefresh!==false) void safely(()=>controllers.get(view)?.refresh?.());
    }
    if (view === 'day' && changed) void safely(()=>cleanupDay.refresh?.());
    if(changed){
      const scrollHost=container.closest('.swb-host');
      if(scrollHost)scrollHost.scrollTop=0;
      motion.show(view==='day'?day:view==='notes'?notes:container.querySelector(`[data-workbench-panel="${view}"]`));
    }
    if(changed&&controllers.get(view)?.onShow)void safely(()=>controllers.get(view).onShow());
    return true;
  }
  function setNavigation(open) {
    layout.classList.toggle('swb-shell__layout--nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  function finishNavigation() {
    if (layout.classList.contains('swb-shell__layout--nav-open')) {
      setNavigation(false);
      if (toggle.getClientRects?.().length) toggle.focus();
    }
  }
  function showBlocked() {
    feedback.textContent = '请先保存或取消正在编辑的内容。';
    feedback.hidden = false;
  }
  function onClick(event) {
    if (event.target.closest('.swb-shell__toggle') === toggle) {
      setNavigation(toggle.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const tab = event.target.closest('[data-workbench-view]');
    if (tab && tabs.includes(tab)) {
      if (select(tab.dataset.workbenchView)) finishNavigation();
      else showBlocked();
    }
  }
  function onKey(event) {
    if(event.defaultPrevented)return;
    const tab = event.target.closest('[data-workbench-view]');
    if (event.key === 'Escape' && !event.target.closest('dialog') && event.target.closest('.swb-shell__tabs,.swb-shell__toggle') && layout.classList.contains('swb-shell__layout--nav-open')) {
      event.preventDefault();
      finishNavigation();
      return;
    }
    if (!tab || !tabs.includes(tab)) return;
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    if (select(tabs[index].dataset.workbenchView)) tabs[index].focus();
  }
  container.addEventListener('click', onClick);
  container.addEventListener('keydown', onKey);
  function dismissNavigation(event) {
    if (layout.classList.contains('swb-shell__layout--nav-open') && !event.target.closest?.('.swb-shell__tabs,.swb-shell__toggle')) setNavigation(false);
  }
  container.ownerDocument.addEventListener('pointerdown',dismissNavigation);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    motion.dispose();
    container.removeEventListener('click', onClick);
    container.removeEventListener('keydown', onKey);
    container.ownerDocument.removeEventListener('pointerdown',dismissNavigation);
    library?.dispose();
    cleanupTree?.();
    for (const controller of controllers.values()) {
      if(typeof controller==='function')controller();
      else controller?.dispose?.();
    }
    cleanupDay();
    container.innerHTML = '';
  };
  cleanup.select = select;
  cleanup.mountTaskEditor=(...args)=>cleanupDay.mountTaskEditor(...args);
  cleanup.openNewProject=async()=>select('projects')&&(await controllers.get('projects')?.openCreate?.() ?? false);
  cleanup.selectDocument = id => cleanupTree?.select(id);
  cleanup.openNewTask = draft => {
    if(disposed||day.querySelector('.swb__modal-host form'))return false;
    if(!select('day'))return false;
    return Boolean(cleanupDay.openNewTask?.(draft));
  };
  cleanup.selectPlannerView = (view,options) => select('planner') && (controllers.get('planner')?.setView?.(view,options) ?? false);
  cleanup.createAgentJob = task => select('jobs') && controllers.get('jobs')?.createFromTask?.(task);
  cleanup.selectAgentJobsState = state => select('jobs') && controllers.get('jobs')?.selectState?.(state);
  cleanup.refreshViews = () => {
    if (disposed) return Promise.resolve([]);
    const operations=[()=>cleanupDay.refresh?.(),()=>library?.refresh()];
    for (const [id,controller] of controllers) if(views.find(view=>view.id===id)?.autoRefresh!==false)operations.push(()=>controller?.refresh?.());
    return Promise.allSettled(operations.map(operation=>Promise.resolve().then(()=>disposed?undefined:operation())));
  };
  cleanup.refreshClock=()=>{
    if(disposed)return Promise.resolve([]);
    const operations=[()=>cleanupDay.refreshClock?.(),...[...controllers].filter(([id])=>views.find(view=>view.id===id)?.autoRefresh!==false).map(([,controller])=>()=>controller?.refreshClock?.())];
    return Promise.allSettled(operations.map(operation=>Promise.resolve().then(()=>disposed?undefined:operation())));
  };
  return cleanup;
}
