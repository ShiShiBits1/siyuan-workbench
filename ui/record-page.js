/** A document side page. Native editor state and persistence stay with the caller. */
export function mountRecordPage(host, {
  loadRecord, createEditor, createPropertiesEditor, beforeClose, onOpenNative, onClosed,
  labels = {}, formatMetadata,
}) {
  const document = host.ownerDocument;
  const window = document.defaultView;
  const panel = document.createElement('aside');
  const frame = document.createElement('div');
  frame.className = 'swb-record-page-frame';
  frame.hidden = true;
  panel.className = 'swb-record-page';
  panel.setAttribute('aria-label', '任务详情页');
  panel.hidden = true;
  panel.innerHTML = `<header class="swb-record-page__bar">
    <span>任务详情</span><div>
      <button type="button" data-record-page="native">在原生标签页打开</button>
      <button type="button" data-record-page="close" aria-label="关闭任务详情页">关闭</button>
    </div></header>
    <div class="swb-record-page__intro"><h2></h2><p class="swb-record-page__metadata"></p></div>
    <p class="swb-record-page__status" role="status" hidden></p>
    <div class="swb-record-page__failure" hidden><p role="alert"></p><button type="button" data-record-page="retry">重试加载</button></div>
    <div class="swb-record-page__content">
      <div class="swb-record-page__properties swb" hidden></div>
      <section class="swb-record-page__body"><h3 hidden>原生正文</h3><p class="swb-record-page__body-hint" hidden>原生正文与上方详细内容分别保存，可继续编写文档和插入资源。</p><div class="swb-record-page__editor"></div></section>
    </div>`;
  frame.append(panel);
  host.append(frame);
  const title = panel.querySelector('h2');
  const metadata = panel.querySelector('.swb-record-page__metadata');
  const status = panel.querySelector('.swb-record-page__status');
  const failure = panel.querySelector('.swb-record-page__failure');
  const editorHost = panel.querySelector('.swb-record-page__editor');
  const propertiesHost = panel.querySelector('.swb-record-page__properties');
  const bodyHeading = panel.querySelector('.swb-record-page__body h3');
  const bodyHint = panel.querySelector('.swb-record-page__body-hint');
  const native = panel.querySelector('[data-record-page="native"]');
  const closeButton = panel.querySelector('[data-record-page="close"]');
  const copy = {
    page: '任务详情页', bar: '任务详情', close: '关闭任务详情页',
    loading: '正在打开任务…', unnamed: '未命名任务', loadError: '任务加载失败，请重试。',
    body: '原生正文', bodyHint: '原生正文与上方详细内容分别保存，可继续编写文档和插入资源。',
    ...labels,
  };
  panel.setAttribute('aria-label', copy.page);
  panel.querySelector('.swb-record-page__bar > span').textContent = copy.bar;
  closeButton.setAttribute('aria-label', copy.close);
  bodyHeading.textContent = copy.body;
  bodyHint.textContent = copy.bodyHint;
  let disposed = false;
  let visible = false;
  let intent = 0;
  let navigationRequest = 0;
  let current = null;
  let requestedId = '';
  let trigger = null;
  let checkingLeave = null;
  let timer = null;
  let resolveAnimation = null;
  let editorSize = '';
  const destroyed = new WeakSet();

  function showError(message, retry = false) {
    failure.querySelector('[role="alert"]').textContent = message || '';
    failure.hidden = !message;
    failure.querySelector('button').hidden = !retry;
  }

  function setStatus(message = '') {
    status.textContent = message;
    status.hidden = !message;
  }

  function showRecord(record) {
    title.textContent = record?.title || copy.unnamed;
    if (formatMetadata) {
      metadata.textContent = formatMetadata(record);
      return;
    }
    const statuses = {todo: '待办', in_progress: '进行中', done: '已完成'};
    const priorities = {urgent: '紧急', high: '高优先级', normal: '普通优先级', low: '低优先级'};
    const dateText = value => {
      const date = new Date(value);
      return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {hour12: false}) : '';
    };
    metadata.textContent = [
      statuses[record?.status], priorities[record?.priority], record?.category,
      record?.startAt ? '开始 ' + dateText(record.startAt) : '',
      record?.endAt ? '截止 ' + dateText(record.endAt) : '',
    ].filter(Boolean).join(' · ');
  }

  function destroyEditor(editor) {
    if (!editor || destroyed.has(editor)) return;
    destroyed.add(editor);
    if (typeof editor.dispose === 'function') editor.dispose();
    else editor.destroy?.();
  }

  function releaseCurrent() {
    destroyEditor(current?.editor);
    destroyEditor(current?.properties);
    current = null;
    editorSize = '';
    editorHost.replaceChildren();
    propertiesHost.replaceChildren();
    propertiesHost.hidden = true;
  }

  function position() {
    if (!visible || disposed) return;
    const rect = (host.querySelector('.swb-shell__body') || host).getBoundingClientRect();
    const viewportWidth = window?.innerWidth || 1024;
    const viewportHeight = window?.innerHeight || 768;
    const left = Math.max(0, rect.left || 0);
    const right = Math.min(viewportWidth, rect.right || viewportWidth);
    const boundary = host.closest('.swb-host')?.getBoundingClientRect();
    const top = Math.max(0, rect.top || 0, boundary?.top || 0);
    const bottom = Math.min(viewportHeight, rect.bottom || viewportHeight, boundary?.bottom || viewportHeight);
    const available = Math.max(0, right - left);
    const width = available <= 760 ? available : Math.min(720, Math.max(440, available * .66));
    Object.assign(frame.style, {
      top: top + 'px', left: (right - width) + 'px',
      width: width + 'px', height: Math.max(0, bottom - top) + 'px',
    });
    const size = width + ':' + Math.max(0, bottom - top);
    if (current?.editor && size !== editorSize) {
      editorSize = size;
      current.editor.resize?.();
    }
  }

  async function canLeave() {
    if (!current?.editor && !current?.properties) return true;
    if (checkingLeave) return checkingLeave;
    const entry = current;
    checkingLeave = Promise.resolve().then(async () => {
      setStatus('正在确认保存…');
      try {
        if (entry.editor?.isUploading?.() || entry.properties?.isUploading?.()) throw new Error('附件正在上传，请完成后再关闭。');
        const saved = await entry.properties?.flush?.();
        if (saved === false) return false;
        const allowed = entry.editor ? await beforeClose?.({id: entry.id, record: entry.record, editor: entry.editor}) : true;
        if (allowed === false) return false;
        return true;
      } catch (error) {
        if (!disposed) showError(error?.message || '保存未确认，请重试关闭。');
        return false;
      }
    }).finally(() => {
      checkingLeave = null;
      if (!disposed) setStatus();
    });
    return checkingLeave;
  }

  function stopAnimation() {
    if (timer) window.clearTimeout(timer);
    timer = null;
    resolveAnimation?.();
    resolveAnimation = null;
  }

  async function open(id, {trigger: origin} = {}) {
    if (disposed || !id) return false;
    if (visible && current?.id === id && current.editor && !checkingLeave && !panel.inert) {
      (current.properties || current.editor).focus?.();
      return true;
    }
    const request = ++navigationRequest;
    if (!await canLeave() || disposed || request !== navigationRequest) return false;
    const token = ++intent;
    stopAnimation();
    panel.classList.remove('swb-record-page--closing');
    panel.inert = false;
    releaseCurrent();
    requestedId = id;
    if (!visible) trigger = origin || document.activeElement;
    else if (origin) trigger = origin;
    visible = true;
    host.dataset.recordPageOpen = 'true';
    panel.hidden = false;
    frame.hidden = false;
    panel.classList.toggle('swb-record-page--properties', Boolean(createPropertiesEditor));
    bodyHeading.hidden = !createPropertiesEditor;
    bodyHint.hidden = !createPropertiesEditor;
    native.hidden = !onOpenNative;
    title.textContent = '';
    metadata.textContent = '';
    showError();
    setStatus(copy.loading);
    position();
    closeButton.focus({preventScroll: true});
    try {
      const record = await loadRecord(id);
      if (disposed || token !== intent) return false;
      const mount = document.createElement('div');
      mount.className = 'swb-record-page__editor-mount';
      editorHost.append(mount);
      const entry = {id, record, editor: null, mount, properties: null};
      current = entry;
      showRecord(record);
      if (createPropertiesEditor) {
        const propertiesMount = document.createElement('div');
        propertiesMount.className = 'swb-record-page__properties-mount';
        propertiesHost.append(propertiesMount);
        propertiesHost.hidden = false;
        const onSaved = saved => {
          if (disposed || current !== entry || saved?.id !== id) return;
          entry.record = {...entry.record, ...saved, bodyId: entry.record.bodyId};
          showRecord(entry.record);
          if(entry.editor)showError();
        };
        const properties = await createPropertiesEditor(propertiesMount, {id, record, onSaved});
        if (disposed || token !== intent) {
          destroyEditor(properties);
          propertiesMount.remove();
          return false;
        }
        entry.properties = properties;
      }
      const editor = await createEditor(mount, {id, record});
      if (disposed || token !== intent) {
        destroyEditor(editor);
        mount.remove();
        return false;
      }
      current.editor = editor;
      setStatus();
      position();
      // Preserve focus if the user already moved back to the main work area.
      if (document.activeElement === closeButton) (entry.properties || editor)?.focus?.();
      return true;
    } catch (error) {
      if (!disposed && token === intent) {
        // Keep the editable task form if the independent native body could not load.
        if (current?.properties) {
          destroyEditor(current.editor);
          current.editor = null;
          editorHost.replaceChildren();
        } else releaseCurrent();
        setStatus();
        showError(error?.message || copy.loadError, true);
      }
      return false;
    }
  }

  async function close() {
    if (disposed || !visible) return true;
    const request = ++navigationRequest;
    if (!await canLeave() || disposed || request !== navigationRequest) return false;
    const token = ++intent;
    panel.inert = true;
    panel.classList.add('swb-record-page--closing');
    await new Promise(resolve => {
      resolveAnimation = resolve;
      const reduced = window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      timer = window.setTimeout(() => { timer = null; resolveAnimation = null; resolve(); }, reduced ? 0 : 150);
    });
    if (disposed || token !== intent) return false;
    releaseCurrent();
    visible = false;
    panel.hidden = true;
    frame.hidden = true;
    panel.inert = false;
    panel.classList.remove('swb-record-page--closing');
    delete host.dataset.recordPageOpen;
    if (trigger?.isConnected) trigger.focus?.({preventScroll: true});
    onClosed?.();
    return true;
  }

  async function onClick(event) {
    const action = event.target.closest('[data-record-page]')?.dataset.recordPage;
    if (action === 'close') void close();
    if (action === 'retry') void open(requestedId);
    if (action === 'native') {
      try {
        const id = requestedId;
        if (await canLeave() && !disposed && visible && id === requestedId) await onOpenNative?.(id);
      } catch (error) { if (!disposed) showError(error?.message || '无法打开原生文档。'); }
    }
  }

  function onKey(event) {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || editorHost.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    void close();
  }

  panel.addEventListener('click', onClick);
  panel.addEventListener('keydown', onKey);
  window?.addEventListener('resize', position);
  window?.addEventListener('scroll', position, true);
  const observer = window?.ResizeObserver ? new window.ResizeObserver(position) : null;
  observer?.observe(host);
  const bodyBoundary=host.querySelector('.swb-shell__body');
  if(bodyBoundary)observer?.observe(bodyBoundary);
  return {
    open, close, isOpen: () => visible,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++intent;
      stopAnimation();
      releaseCurrent();
      observer?.disconnect();
      window?.removeEventListener('resize', position);
      window?.removeEventListener('scroll', position, true);
      panel.removeEventListener('click', onClick);
      panel.removeEventListener('keydown', onKey);
      frame.remove();
      delete host.dataset.recordPageOpen;
      visible = false;
    },
  };
}
