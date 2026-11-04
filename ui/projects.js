const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const projectFields = [
  ['status', '状态'], ['priority', '优先级'], ['owner', '负责人'],
  ['startDate', '开始日期'], ['endDate', '结束日期'],
];
const projectLayouts = [['table', '表格'], ['board', '看板'], ['list', '列表']];
const sortFields = [['title', '名称'], ['priority', '优先级'], ['startDate', '开始日期'], ['endDate', '结束日期']];
const initialPreferences = () => ({layout: 'table', filters: {}, sort: '', descending: false});
const emptyStatus = '未设置';

export function mountProjects(container, {loadBinding, saveBinding, createDatabase, list, create, onOpenDocument, onOpenProject, notebookId, updateProject, storage}) {
  container.innerHTML = `<section class="swb-projects" aria-label="项目管理">
    <div class="swb-projects__toolbar">
      <span data-project-source></span>
      <div class="swb-projects__actions">
        <button type="button" data-project-action="refresh">刷新</button>
        <button type="button" data-project-action="source" hidden>打开原生数据库</button>
        <button type="button" data-project-action="binding" hidden>更换数据库</button>
        <button type="button" class="swb-projects__primary" data-project-action="new" hidden>新建项目</button>
      </div>
    </div>
    <p class="swb-projects__feedback" role="alert" hidden></p>
    <p class="swb-projects__status" role="status"></p>
    <form class="swb-projects__editor" data-project-form="binding" hidden>
      ${createDatabase ? '<p>在当前笔记本创建项目总表，自动配置状态、优先级、负责人和起止日期。</p><button type="button" class="swb-projects__primary" data-project-action="create-database">创建项目数据库</button>' : ''}
      <details class="swb-projects__connect-existing"${createDatabase ? '' : ' open'}><summary>接入已有数据库</summary>
        <label>数据库块链接 <input name="source" required autocomplete="off" placeholder="粘贴思源数据库块链接"></label>
        <p>在现有项目表格的块菜单复制块链接。</p>
        <button type="submit">连接数据库</button>
      </details><div class="swb-projects__actions">
        <button type="button" data-project-action="cancel" hidden>取消</button>
      </div>
    </form>
    <form class="swb-projects__editor" data-project-form="create" hidden>
      <label>项目名称 <input name="title" required maxlength="100" autocomplete="off"></label>
      <label>项目介绍 <textarea name="description" rows="3" maxlength="4000" placeholder="填写目标或背景（选填）"></textarea></label>
      <div class="swb-projects__actions">
        <button type="submit" class="swb-projects__primary">创建项目</button>
        <button type="button" data-project-action="recovery" hidden>打开已创建的文档</button>
        <button type="button" data-project-action="cancel">取消</button>
      </div>
    </form>
    <div class="swb-projects__views" hidden>
      <div class="swb-projects__switches" role="group" aria-label="项目视图"></div>
      <details class="swb-projects__options">
        <summary>筛选与排序</summary>
        <div class="swb-projects__filters"></div>
      </details>
      <label class="swb-projects__lane" hidden>查看看板列 <select data-project-option="lane"></select></label>
      <p class="swb-projects__readonly" hidden></p>
    </div>
    <div class="swb-projects__list"></div>
    <dialog class="swb-projects__dialog" aria-label="编辑项目属性">
      <form class="swb-projects__field-form" data-project-form="field">
        <h3 data-project-edit-title>编辑项目属性</h3>
        <label data-project-edit-label></label>
        <p role="alert" data-project-edit-error hidden></p>
        <div class="swb-projects__actions">
          <button type="submit" class="swb-projects__primary">保存</button>
          <button type="button" data-project-action="close-field">取消</button>
        </div>
      </form>
    </dialog>
  </section>`;
  const root = container.querySelector('.swb-projects');
  const $ = selector => root.querySelector(selector);
  const bindingForm = $('[data-project-form="binding"]');
  const createForm = $('[data-project-form="create"]');
  const editForm = $('[data-project-form="field"]');
  const dialog = $('.swb-projects__dialog');
  const source = bindingForm.querySelector('[name="source"]');
  const title = createForm.querySelector('[name="title"]');
  const description = createForm.querySelector('[name="description"]');
  const submit = createForm.querySelector('[type="submit"]');
  const action = name => $(`[data-project-action="${name}"]`);
  let binding = null, snapshot = null, editor = '', recoveryId = '';
  let busy = false, disposed = false, loaded = false;
  let preferences = initialPreferences(), selectedLane = '', dragProject = null, fieldDraft = null;
  const locale = new Intl.Collator('zh-CN', {numeric:true});

  function alert(message = '') {
    const feedback = $('.swb-projects__feedback');
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function setEditor(next) {
    editor = next;
    bindingForm.hidden = editor !== 'binding';
    createForm.hidden = editor !== 'create';
    bindingForm.querySelector('[data-project-action="cancel"]').hidden = !binding;
    if (editor === 'binding') source.value = '';
    if (editor === 'create') {
      title.value = '';
      description.value = '';
      recoveryId = '';
      title.readOnly = false;
      description.readOnly = false;
      submit.textContent = '创建项目';
      action('recovery').hidden = true;
    }
    updateControls();
  }

  function updateControls() {
    root.dataset.projectsDraft = String(busy || !!fieldDraft || editor === 'create' || (editor === 'binding' && (!!binding || !!source.value.trim())));
    action('source').hidden = !(snapshot?.sourceDocId || binding?.documentId);
    action('binding').hidden = !binding;
    action('new').hidden = !snapshot;
    for (const name of ['refresh', 'binding', 'new']) action(name).disabled = busy || !!editor;
    for (const button of root.querySelectorAll('form button')) button.disabled = busy;
    source.disabled = busy;
    title.disabled = busy;
    description.disabled = busy;
    const fieldInput = $('[name="project-field-value"]');
    if (fieldInput) fieldInput.disabled = busy;
  }

  function getPreferenceStorage() {
    try { return storage || container.ownerDocument.defaultView?.localStorage; } catch { return null; }
  }

  function preferenceKey() {
    return notebookId && binding?.avId ? `swb-projects-views:${notebookId}:${binding.avId}` : '';
  }

  function readPreferences() {
    preferences = initialPreferences();
    selectedLane = '';
    try {
      const key = preferenceKey();
      if (!key) return;
      const value = JSON.parse(getPreferenceStorage()?.getItem(key) || '{}');
      if (projectLayouts.some(([id]) => id === value.layout)) preferences.layout = value.layout;
      if (sortFields.some(([id]) => id === value.sort)) preferences.sort = value.sort;
      preferences.descending = value.descending === true;
      for (const id of ['status', 'priority', 'owner', 'from', 'to']) {
        if (typeof value.filters?.[id] === 'string') preferences.filters[id] = value.filters[id];
      }
    } catch { /* Preferences are optional when storage is unavailable. */ }
  }

  function savePreferences() {
    try {
      const key = preferenceKey();
      if (key) getPreferenceStorage()?.setItem(key, JSON.stringify(preferences));
    } catch { /* Keep the current selection for this session. */ }
  }

  function optionsFor(field) {
    const values = [...(snapshot.fields?.[field]?.options || [])];
    for (const project of snapshot.projects) {
      for (const value of filterValues(project, field)) {
        if (value && !values.includes(value)) values.push(value);
      }
    }
    return values;
  }

  function filterValues(project, field) {
    const raw = project.editValues?.[field];
    return Array.isArray(raw) ? raw : [project[field]];
  }

  function getVisibleProjects() {
    const {filters, sort, descending} = preferences;
    const rows = snapshot.projects.filter(project => {
      const date = project.endDate;
      return ['status','priority','owner'].every(key => !filters[key] || filterValues(project, key).includes(filters[key]))
        && (!filters.from || (date && date >= filters.from))
        && (!filters.to || (date && date <= filters.to));
    });
    if (!sort) return rows;
    const order = sort === 'priority' ? snapshot.fields?.priority?.options || [] : [];
    const rank = value => order.includes(value) ? order.indexOf(value) : order.length;
    return rows.sort((a, b) => {
      if (!a[sort] || !b[sort]) return Number(!a[sort]) - Number(!b[sort]);
      const compared = (rank(a[sort]) - rank(b[sort])) || locale.compare(a[sort], b[sort]);
      return descending ? -compared : compared;
    });
  }

  function option(value, label, current) {
    return `<option value="${escape(value)}"${current === value ? ' selected' : ''}>${escape(label)}</option>`;
  }

  function renderViewControls(lanes) {
    $('.swb-projects__switches').innerHTML = projectLayouts.map(([id, label]) => `<button type="button" data-project-action="layout" data-project-layout="${id}" aria-pressed="${preferences.layout === id}">${label}</button>`).join('');
    const {filters, sort, descending} = preferences;
    $('.swb-projects__filters').innerHTML = `
      ${projectFields.slice(0, 3).map(([field, label]) => {
        const values = optionsFor(field);
        if (filters[field] && !values.includes(filters[field])) values.push(filters[field]);
        return `<label>${label}<select data-project-option="${field}">${option('', '全部', filters[field] || '')}${values.map(value => option(value, value, filters[field])).join('')}</select></label>`;
      }).join('')}
      <label>截止日从<input type="date" data-project-option="from" value="${escape(filters.from)}"></label>
      <label>截止日到<input type="date" data-project-option="to" value="${escape(filters.to)}"></label>
      <label>排序<select data-project-option="sort">${option('', '原有顺序', sort)}${sortFields.map(([id, label]) => option(id, label, sort)).join('')}</select></label>
      <label>方向<select data-project-option="direction"${sort ? '' : ' disabled'}>${option('asc', '升序', descending ? 'desc' : 'asc')}${option('desc', '降序', descending ? 'desc' : 'asc')}</select></label>
      <button type="button" data-project-action="clear-filters">清除筛选</button>`;
    const lane = $('.swb-projects__lane');
    lane.hidden = preferences.layout !== 'board';
    lane.querySelector('select').innerHTML = option('', '全部状态', selectedLane) + lanes.map((value, index) => option(String(index + 1), value || emptyStatus, selectedLane)).join('');
    const readonly = $('.swb-projects__readonly');
    readonly.hidden = !!updateProject && !snapshot.readonly && Object.values(snapshot.fields || {}).some(field => field.editable);
    readonly.textContent = snapshot.readonlyReason || '当前字段仅供查看。可在原生数据库检查字段类型与编辑权限。';
  }

  function projectTitle(project) {
    const label = escape(project.title || '未命名项目');
    return project.documentId ? `<button type="button" class="swb-projects__title" data-project-action="open" data-project-document="${escape(project.documentId)}">${label}</button>`
      : `${label} <small>未关联文档</small>`;
  }

  function canEdit(project, field) {
    return !!(updateProject && !snapshot.readonly && snapshot.fields?.[field]?.editable && project.editable?.[field] !== false && typeof project.revision?.[field] === 'string');
  }

  function property(project, field, label) {
    const value = escape(project[field] || '—');
    return canEdit(project, field) ? `<button type="button" class="swb-projects__property" aria-label="${escape(`编辑 ${project.title} 的${label}`)}" data-project-action="edit" data-project-id="${escape(project.id)}" data-project-field="${field}">${value}</button>` : value;
  }

  function renderTable(projects) {
    return `<table>
      <thead><tr>${['项目名称', ...projectFields.map(([,label]) => label)].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead>
      <tbody>${projects.map(project => `<tr><th scope="row">${projectTitle(project)}</th>${projectFields.map(([field, label]) => `<td>${property(project, field, label)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  function renderCompact(project, board = false) {
    const extra = projectFields.filter(([field]) => canEdit(project, field));
    return `<li class="swb-projects__card"${board && canEdit(project, 'status') && snapshot.fields?.status?.type === 'select' ? ` draggable="true" data-project-card="${escape(project.id)}"` : ''}>
      <div>${projectTitle(project)}</div>
      <div class="swb-projects__metadata">${property(project, 'status', '状态')}<span>截止 ${property(project, 'endDate', '结束日期')}</span></div>
      ${extra.length ? `<details class="swb-projects__card-actions"><summary>编辑属性</summary><div>${extra.map(([field, label]) =>
        `<button type="button" data-project-action="edit" data-project-id="${escape(project.id)}" data-project-field="${field}">${label}</button>`
      ).join('')}</div></details>` : ''}
    </li>`;
  }

  function renderBoard(projects, lanes) {
    return `<div class="swb-projects__board">${lanes.map((status, index) => {
      if (selectedLane && Number(selectedLane) !== index + 1) return '';
      const cards = projects.filter(project => (project.status || '') === status);
      return `<section class="swb-projects__column" data-project-lane="${escape(status)}">
        <h3>${escape(status || emptyStatus)} <small>${cards.length}</small></h3>
        ${cards.length ? `<ul>${cards.map(card => renderCompact(card, true)).join('')}</ul>` : '<p>暂无项目</p>'}
      </section>`;
    }).join('')}</div>`;
  }

  function renderList() {
    $('[data-project-source]').textContent = snapshot?.name || binding?.name || '';
    const host = $('.swb-projects__list');
    const status = $('.swb-projects__status');
    $('.swb-projects__views').hidden = !snapshot;
    if (!snapshot) {
      host.innerHTML = '';
      status.textContent = '';
      return;
    }
    const lanes = [...optionsFor('status'), ''];
    renderViewControls(lanes);
    const projects = getVisibleProjects();
    const total = snapshot.projects.length;
    status.textContent = total ? `显示 ${projects.length} / ${total} 个项目` : '暂无项目，可以创建第一个项目。';
    if (total && !projects.length) {
      host.innerHTML = '<p>没有符合筛选条件的项目。 <button type="button" data-project-action="clear-filters">清除筛选</button></p>';
    } else if (preferences.layout === 'board') {
      const scrollLeft = host.querySelector('.swb-projects__board')?.scrollLeft || 0;
      host.innerHTML = renderBoard(projects, lanes);
      host.querySelector('.swb-projects__board').scrollLeft = scrollLeft;
    } else if (preferences.layout === 'list') {
      host.innerHTML = `<ul class="swb-projects__compact">${projects.map(project => renderCompact(project)).join('')}</ul>`;
    } else {
      host.innerHTML = projects.length ? renderTable(projects) : '';
    }
  }
  async function run(operation) {
    if (busy || disposed) return;
    busy = true;
    alert();
    updateControls();
    if (!snapshot && !editor) $('.swb-projects__status').textContent = '正在读取项目…';
    try {
      await operation();
    } catch (error) {
      if (!disposed) alert(error?.message || '项目操作失败，请重试。');
    } finally {
      if (!disposed) {
        if (!snapshot) $('.swb-projects__status').textContent = '';
        busy = false;
        updateControls();
      }
    }
  }

  async function loadList() {
    const result = await list(binding);
    if (disposed) return;
    snapshot = result;
    renderList();
  }

  function refresh() {
    if (editor || fieldDraft) return;
    return run(async () => {
      if (!loaded) {
        const result = await loadBinding();
        if (disposed) return;
        binding = result;
        readPreferences();
        loaded = true;
      }
      if (binding) await loadList();
      else setEditor('binding');
    });
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (event.target === editForm && fieldDraft) return saveField();
    if (event.target === bindingForm && editor === 'binding') {
      const input = source.value.trim();
      if (!input) return alert('请填写数据库块链接。');
      await run(async () => {
        const saved = await saveBinding(input);
        if (disposed) return;
        binding = saved;
        readPreferences();
        snapshot = null;
        renderList();
        setEditor('');
        await loadList();
      });
    }
    if (event.target === createForm && editor === 'create') {
      const draft = {title: title.value.trim(), description: description.value.trim()};
      if (!draft.title) return alert('请填写项目名称。');
      if (recoveryId) draft.documentId = recoveryId;
      await run(async () => {
        try {
          await create(binding, draft);
        } catch (error) {
          if (!disposed && error?.documentId) {
            recoveryId = error.documentId;
            title.readOnly = true;
            description.readOnly = true;
            submit.textContent = '重试关联';
            action('recovery').hidden = false;
          }
          throw error;
        }
        if (disposed) return;
        setEditor('');
        try {
          await loadList();
        } catch {
          throw new Error('项目已创建，列表刷新失败，请点击刷新。');
        }
      });
    }
  }

  function open(id, {project = false, trigger} = {}) {
    const callback = project && onOpenProject ? onOpenProject : onOpenDocument;
    if (id) void Promise.resolve().then(() => callback(id, {trigger})).catch(error => {
      if (!disposed) alert(error?.message || '打开文档失败。');
    });
  }

  function editError(message = '') {
    const error = $('[data-project-edit-error]');
    error.textContent = message;
    error.hidden = !message;
  }

  function showField(project, field, trigger, nextValue) {
    if (editor || fieldDraft || !canEdit(project, field)) return false;
    const definition = snapshot.fields[field];
    const label = definition.label || projectFields.find(([id]) => id === field)?.[1];
    const original = project.editValues?.[field] ?? project[field] ?? '';
    const current = nextValue ?? original;
    fieldDraft = {project, field, original, trigger};
    $('[data-project-edit-title]').textContent = project.title || '未命名项目';
    const host = $('[data-project-edit-label]');
    const multi = definition.type === 'mSelect';
    if (definition.type === 'select' || multi) {
      const selected = multi ? (Array.isArray(current) ? current : []) : [current];
      const values = [...new Set([...definition.options, ...selected.filter(Boolean)])];
      host.innerHTML = `${escape(label)} <select name="project-field-value"${multi ? ' multiple' : ''}>
        ${multi ? '' : option('', '未设置', current)}${values.map(value => option(value, value, selected.includes(value) ? value : null)).join('')}
      </select>`;
    } else {
      host.innerHTML = `${escape(label)} <input name="project-field-value" type="${definition.type === 'date' ? 'date' : 'text'}" value="${escape(current)}">`;
    }
    editError();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    updateControls();
    $('[name="project-field-value"]').focus();
    return true;
  }

  function readFieldValue() {
    const input = $('[name="project-field-value"]');
    return input.multiple ? [...input.options].filter(item => item.selected).map(item => item.value) : input.value;
  }

  function closeField({discard = false} = {}) {
    if (!fieldDraft || busy) return;
    const {trigger, original, project, field} = fieldDraft;
    if (!discard && JSON.stringify(readFieldValue()) !== JSON.stringify(original)
      && !container.ownerDocument.defaultView?.confirm?.('放弃未保存的属性修改？')) return;
    fieldDraft = null;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    updateControls();
    const replacement = [...root.querySelectorAll('[data-project-action="edit"]')].find(button =>
      button.dataset.projectId === project.id && button.dataset.projectField === field
    );
    (trigger?.isConnected ? trigger : replacement || $('[data-project-layout][aria-pressed="true"]'))?.focus();
  }

  async function saveField() {
    if (busy || disposed || !fieldDraft) return;
    const {project, field, original} = fieldDraft;
    const value = readFieldValue();
    if (JSON.stringify(value) === JSON.stringify(original)) return closeField({discard:true});
    let saved = false;
    editError();
    await run(async () => {
      try {
        snapshot = await updateProject(binding, {id:project.id, field, value, expectedRevision:project.revision[field]});
        if (disposed) return;
        renderList();
        saved = true;
      } catch (error) {
        if (!disposed) editError(error?.message || '保存属性失败，请重试。');
      }
    });
    if (saved && !disposed) closeField({discard:true});
  }

  function onOptionChange(event) {
    const key = event.target.dataset.projectOption;
    if (!key || busy || !snapshot) return;
    const value = event.target.value;
    if (key === 'lane') selectedLane = value;
    else if (key === 'sort') preferences.sort = value;
    else if (key === 'direction') preferences.descending = value === 'desc';
    else preferences.filters[key] = value;
    savePreferences();
    renderList();
    $(`[data-project-option="${key}"]`)?.focus();
  }

  function onDragStart(event) {
    const card = event.target.closest('[data-project-card]');
    if (!card || !event.dataTransfer) return;
    if (busy || editor || fieldDraft) {
      event.preventDefault();
      return;
    }
    dragProject = snapshot.projects.find(project => project.id === card.dataset.projectCard);
    if (!dragProject) return;
    event.dataTransfer.setData('text/plain', dragProject.id);
    event.dataTransfer.effectAllowed = 'move';
  }

  function dropTarget(event) {
    const column = event.target.closest('[data-project-lane]');
    const status = column?.dataset.projectLane;
    if (!dragProject || !column || !canEdit(dragProject, 'status') || status === (dragProject.status || '')
      || (status && !snapshot.fields.status.options.includes(status))) return null;
    return column;
  }

  function onDragOver(event) {
    const target = dropTarget(event);
    for (const column of root.querySelectorAll('[data-project-lane]')) {
      column.classList.toggle('swb-projects__column--drop', column === target);
    }
    if (target) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function clearDrag() {
    dragProject = null;
    for (const column of root.querySelectorAll('.swb-projects__column--drop')) column.classList.remove('swb-projects__column--drop');
  }

  function onDrop(event) {
    const target = dropTarget(event);
    const project = dragProject;
    clearDrag();
    if (!target || !project || busy || editor || fieldDraft) return;
    event.preventDefault();
    const value = target.dataset.projectLane;
    void run(async () => {
      try {
        snapshot = await updateProject(binding, {id:project.id, field:'status', value, expectedRevision:project.revision.status});
        if (!disposed) renderList();
      } catch (error) {
        if (disposed) return;
        if (!showField(project, 'status', null, value)) throw error;
        editError(error?.message || '保存状态失败，请重试。');
      }
    });
  }

  function onDialogCancel(event) {
    event.preventDefault();
    closeField();
  }

  function onClick(event) {
    const button = event.target.closest('[data-project-action]');
    if (!button || !root.contains(button) || busy) return;
    const name = button.dataset.projectAction;
    if (name === 'create-database' && createDatabase) {
      void run(async () => {
        binding = await createDatabase();
        if (disposed) return;
        readPreferences();
        setEditor('');
        await loadList();
      });
      return;
    }
    if (name === 'refresh') void refresh();
    if (name === 'source') open(snapshot?.sourceDocId || binding?.documentId);
    if (name === 'open') open(button.dataset.projectDocument, {project: true, trigger: button});
    if (name === 'recovery') open(recoveryId);
    if (name === 'layout') {
      preferences.layout = button.dataset.projectLayout;
      savePreferences();
      renderList();
      $('[data-project-layout][aria-pressed="true"]')?.focus();
    }
    if (name === 'clear-filters') {
      preferences.filters = {};
      savePreferences();
      renderList();
      $('[data-project-layout][aria-pressed="true"]')?.focus();
    }
    if (name === 'edit') {
      const project = snapshot?.projects.find(row => row.id === button.dataset.projectId);
      if (project) showField(project, button.dataset.projectField, button);
    }
    if (name === 'close-field') closeField();
    if (name === 'binding' || name === 'new') {
      alert();
      setEditor(name === 'new' ? 'create' : 'binding');
      (editor === 'create' ? title : source).focus();
    }
    if (name === 'cancel') {
      alert(recoveryId && editor === 'create' ? '已创建的文档保留在项目数据库所在文档下。' : '');
      setEditor('');
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onOptionChange);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragend', clearDrag);
  dialog.addEventListener('cancel', onDialogCancel);
  source.addEventListener('input', updateControls);
  const initialLoad = Promise.resolve(refresh());
  return {
    refresh,
    async openCreate() {
      await initialLoad;
      if (disposed || busy || !loaded || fieldDraft || recoveryId || editor === 'create') return false;
      if (editor === 'binding' && source.value.trim()) return false;
      if (binding) {
        if (!snapshot) return false;
        setEditor('create');
        title.focus();
      } else {
        if (editor !== 'binding') setEditor('binding');
        (action('create-database') || bindingForm.querySelector('summary'))?.focus();
      }
      return true;
    },
    canHide: () => root.dataset.projectsDraft !== 'true',
    dispose() {
      disposed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('change', onOptionChange);
      root.removeEventListener('dragstart', onDragStart);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('dragend', clearDrag);
      dialog.removeEventListener('cancel', onDialogCancel);
      source.removeEventListener('input', updateControls);
      root.remove();
    },
  };
}
