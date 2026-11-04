/** Mount a document library without replacing search controls or editing drafts on refresh. */
export function mountNotesLibrary(container, options = {}) {
  let notes = [], disposed = false, generation = 0, loading = false, loaded = false;
  let creating=false;
  let editingID = null, saving = false, editingTagsText = '', editingTags = [];
  container.innerHTML = `<section class="swb-notes" aria-label="笔记与文档整理">
    <header class="swb-notes__head"><div data-workbench-page-intro><h2>笔记与文档</h2><p>在这里整理，在思源中继续写。</p></div><div class="swb-notes__actions"><button type="button" data-notes-action="refresh">刷新</button><button type="button" class="swb-notes__primary" data-notes-action="create" ${options.onCreateNote ? '' : 'disabled'}>＋ 新建笔记</button></div></header>
    <div class="swb-notes__tools"><label class="swb-notes__search"><span>搜索</span><input type="search" aria-label="搜索笔记标题或正文" placeholder="搜索标题或正文" autocomplete="off"></label><label><span>分类</span><select aria-label="筛选笔记分类" data-notes-filter="category"><option value="">全部分类</option></select></label><label><span>标签</span><select aria-label="筛选笔记标签" data-notes-filter="tag"><option value="">全部标签</option></select></label></div>
    <div class="swb-notes__summary" role="status" aria-live="polite"></div><p class="swb-notes__error" role="alert" hidden></p>
    <div class="swb-notes__editor"></div><div class="swb-notes__list"></div>
  </section>`;
  const section = container.querySelector('.swb-notes');
  const search = section.querySelector('input[type="search"]');
  const category = section.querySelector('[data-notes-filter="category"]');
  const tag = section.querySelector('[data-notes-filter="tag"]');
  const summary = section.querySelector('.swb-notes__summary');
  const error = section.querySelector('.swb-notes__error');
  const editor = section.querySelector('.swb-notes__editor');
  const list = section.querySelector('.swb-notes__list');

  function showError(message = '') { error.textContent = message; error.hidden = !message; }
  function updateFilters() {
    const previousCategory = category.value, previousTag = tag.value;
    const categories = new Set(notes.map(note => note.category).filter(Boolean));
    const tags = new Set(notes.flatMap(note => note.tags || []));
    if (previousCategory.startsWith('category:')) categories.add(previousCategory.slice(9));
    if (previousTag.startsWith('tag:')) tags.add(previousTag.slice(4));
    category.innerHTML = '<option value="">全部分类</option><option value="none">未分类</option>' + [...categories].sort().map(value => `<option value="${escapeHTML('category:'+value)}">${escapeHTML(value)}</option>`).join('');
    tag.innerHTML = '<option value="">全部标签</option>' + [...tags].sort().map(value => `<option value="${escapeHTML('tag:'+value)}">${escapeHTML(value)}</option>`).join('');
    category.value = previousCategory; tag.value = previousTag;
  }
  function renderList() {
    if (disposed) return;
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = notes.filter(note => (!query || `${note.title}\n${note.searchText || ''}`.toLocaleLowerCase().includes(query))
      && (!category.value || (category.value === 'none' ? !note.category : note.category === category.value.slice(9)))
      && (!tag.value || (note.tags || []).includes(tag.value.slice(4))));
    summary.textContent = loading ? '正在读取笔记…' : `显示 ${filtered.length} / ${notes.length} 篇笔记`;
    section.setAttribute('aria-busy', String(loading));
    list.innerHTML = filtered.length ? filtered.map(note => `<article class="swb-notes__item"><div class="swb-notes__document"><button type="button" class="swb-notes__title" data-notes-action="open" data-note-id="${escapeHTML(note.id)}">${escapeHTML(note.title)}</button><p class="swb-notes__excerpt">${escapeHTML(note.excerpt || '暂无正文')}</p><div class="swb-notes__meta"><span class="swb-notes__category">${escapeHTML(note.category || '未分类')}</span>${(note.tags || []).map(value => `<span class="swb-notes__tag">#${escapeHTML(value)}</span>`).join('')}<time datetime="${escapeHTML(note.updatedAt || '')}">${escapeHTML(formatTime(note.updatedAt))}</time></div></div><div class="swb-notes__item-actions"><button type="button" data-notes-action="open" data-note-id="${escapeHTML(note.id)}" aria-label="在思源中打开：${escapeHTML(note.title)}">打开文档 ↗</button><button type="button" data-notes-action="edit" data-note-id="${escapeHTML(note.id)}" aria-label="整理笔记：${escapeHTML(note.title)}">整理</button></div></article>`).join('')
      : `<div class="swb-notes__empty"><strong>${loading ? '正在读取笔记' : !loaded ? '笔记暂未加载' : notes.length ? '没有符合条件的笔记' : '还没有工作台笔记'}</strong><p>${notes.length ? '调整关键词、分类或标签，再试一次。' : '从“新建笔记”开始，已有工作台笔记也会显示在这里。'}</p>${notes.length ? '<button type="button" data-notes-action="clear">清除筛选</button>' : ''}</div>`;
  }
  async function refresh() {
    if (disposed) return;
    const request = ++generation;
    loading = true; showError(); renderList();
    try {
      const result = await options.listNotes();
      if (disposed || request !== generation) return;
      if (!Array.isArray(result)) throw new Error('笔记列表响应无效');
      notes = result; loaded = true; updateFilters();
    } catch (failure) {
      if (!disposed && request === generation) showError(`读取笔记失败：${failure?.message || '请重试'}。可点击“刷新”重试。`);
    } finally {
      if (!disposed && request === generation) {loading = false; renderList();}
    }
  }
  function edit(note) {
    if (saving) return;
    editingID = note.id;
    editingTags = [...(note.tags || [])];
    editingTagsText = editingTags.join(', ');
    editor.innerHTML = `<form class="swb-notes__form" aria-label="整理笔记"><div class="swb-notes__edit-heading"><strong>${escapeHTML(note.title)}</strong><span>分类与标签</span></div><div class="swb-notes__fields"><label>笔记分类<input name="category" maxlength="100" value="${escapeHTML(note.category || '')}" placeholder="例如：会议记录"></label><label>笔记标签<input name="tags" value="${escapeHTML((note.tags || []).join(', '))}" placeholder="多个标签用逗号分隔"></label></div><p class="swb-notes__form-error" role="alert" hidden></p><div class="swb-notes__edit-actions"><button type="button" data-notes-action="cancel">取消</button><button type="submit" class="swb-notes__primary">保存分类与标签</button></div></form>`;
    editor.querySelector('[name="category"]').focus();
  }
  async function submit(event) {
    if (!event.target.matches('.swb-notes__form')) return;
    event.preventDefault();
    if (disposed || saving || !editingID) return;
    const form = event.target, formError = form.querySelector('[role="alert"]');
    const categoryValue = form.querySelector('[name="category"]').value.trim();
    const tagInput = form.querySelector('[name="tags"]').value;
    // Category-only edits must not silently split existing native tags containing commas.
    const tags = tagInput === editingTagsText ? [...editingTags]
      : [...new Set(tagInput.split(/[,，]/).map(value => value.trim()).filter(Boolean))];
    formError.hidden = true;
    if (categoryValue.length > 100 || tags.length > 20 || tags.some(value => value.length > 50)) {
      formError.textContent = '分类最多 100 字；最多 20 个标签，每个最多 50 字。'; formError.hidden = false; return;
    }
    const id = editingID;
    saving = true;
    for (const control of form.querySelectorAll('input,button')) control.disabled = true;
    try {
      const saved = await options.updateMetadata(id, {category: categoryValue, tags});
      if (disposed) return;
      ++generation; loading = false;
      notes = notes.map(note => note.id === id ? {...note, ...saved} : note);
      editingID = null; editor.innerHTML = ''; updateFilters(); renderList(); showError();
    } catch (failure) {
      if (!disposed) {formError.textContent = `保存失败：${failure?.message || '请重试'}`; formError.hidden = false;}
    } finally {
      saving = false;
      if (!disposed) for (const control of form.querySelectorAll('input,button')) control.disabled = false;
    }
  }
  async function click(event) {
    const button = event.target.closest('[data-notes-action]');
    if (!button || !section.contains(button) || disposed || button.disabled) return;
    const action = button.dataset.notesAction;
    if (action === 'refresh') return refresh();
    if (action === 'clear') {search.value = ''; category.value = ''; tag.value = ''; renderList(); return;}
    if (action === 'cancel' && !saving) {editingID = null; editor.innerHTML = ''; return;}
    if (action === 'edit') {const note = notes.find(item => item.id === button.dataset.noteId); if (note) edit(note); return;}
    if (action === 'open' || action === 'create') {
      try {
        if (action === 'create') {
          if(creating)return;creating=true;button.disabled=true;button.textContent='正在打开笔记…';
          try{const result=await options.onCreateNote?.();if(!result)throw new Error('未确认笔记已打开，请刷新核查。');}
          finally{creating=false;if(!disposed){button.disabled=!options.onCreateNote;button.textContent='＋ 新建笔记';}}
        }
        else if (options.onOpenNote) await options.onOpenNote(button.dataset.noteId);
        else throw new Error('打开文档功能尚未配置');
      } catch (failure) {if (!disposed) showError(`${action === 'open' ? '打开文档' : '新建笔记'}失败：${failure?.message || '请重试'}`);}
    }
  }
  // A search blur emits change between a pointer's down and click events.
  // Redrawing the list there detaches the pressed button and loses its click.
  function onInput(event) { if (event.target === search) renderList(); }
  function onChange(event) { if (event.target === category || event.target === tag) renderList(); }
  section.addEventListener('input', onInput);
  section.addEventListener('change', onChange);
  section.addEventListener('click', click);
  section.addEventListener('submit', submit);
  void refresh();
  return {refresh, dispose() {
    disposed = true; ++generation;
    section.removeEventListener('input', onInput); section.removeEventListener('change', onChange);
    section.removeEventListener('click', click); section.removeEventListener('submit', submit);
  }};
}
function escapeHTML(value) {return String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function formatTime(value) {
  // SiYuan blocks.updated is a local YYYYMMDDHHmmss value, not an ISO timestamp.
  if (typeof value === 'string' && /^\d{14}$/.test(value)) return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)} ${value.slice(8,10)}:${value.slice(10,12)}`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}
