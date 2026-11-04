export function mountDocumentTree(host, {notebookId, list, open, create, onOpen}) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const storageKey = 'siyuan-workbench:document-tree:' + notebookId;
  let expanded = new Set();
  try {
    const saved = JSON.parse(win.localStorage.getItem(storageKey));
    if (Array.isArray(saved)) expanded = new Set(saved);
  } catch { /* The tree still works without persistent browser storage. */ }
  let active = '';
  let disposed = false;
  let anchor;
  let context;
  let busy = false;
  let draft = null;

  host.innerHTML = `<button type="button" class="swb-tree__root" aria-expanded="false">文档树</button>
    <div class="swb-tree__branch" hidden></div>
    <div class="swb-tree__menu" popover="auto" aria-label="文档操作">
      <button type="button" data-command="open">打开</button>
      <button type="button" data-command="copy">复制块链接</button>
      <button type="button" data-command="create">新建子文档</button>
    </div>
    <p class="swb-tree__feedback" role="status"></p>
    <dialog class="swb-tree__dialog" aria-label="新建子文档">
      <form><h3>新建子文档</h3><label>文档标题<input name="title" required maxlength="100" autofocus></label>
      <p role="alert" hidden></p><footer><button type="button" data-cancel>取消</button><button type="submit">创建文档</button></footer></form>
    </dialog>`;
  const root = host.querySelector('.swb-tree__root');
  const rootBranch = host.querySelector('.swb-tree__branch');
  const menu = host.querySelector('.swb-tree__menu');
  const dialog = host.querySelector('dialog');
  const form = dialog.querySelector('form');
  const title = form.querySelector('input');
  const error = form.querySelector('[role="alert"]');
  const feedback = host.querySelector('.swb-tree__feedback');

  function persist(id, isOpen) {
    if (isOpen) expanded.add(id);
    else expanded.delete(id);
    try { win.localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* Local preference only. */ }
  }

  function select(id) {
    active = id;
    for (const button of host.querySelectorAll('[data-doc-id]')) {
      if (button.dataset.docId === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  async function openDocument(id) {
    await open(id);
    if (!disposed) {
      select(id);
      onOpen?.();
    }
  }

  async function load(branch, path) {
    if (branch.dataset.loading === 'true') return;
    branch.dataset.loading = 'true';
    branch.textContent = '正在加载…';
    try {
      const children = await list(path);
      if (disposed || !branch.isConnected) return;
      branch.replaceChildren(...children.map(item => renderNode(item, branch, path)));
      branch.dataset.loaded = 'true';
      if (!children.length) branch.textContent = '没有子文档';
    } catch (failure) {
      if (disposed) return;
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.textContent = '加载失败，重试';
      retry.title = failure?.message || '';
      retry.onclick = () => void load(branch, path);
      branch.replaceChildren(retry);
    } finally {
      delete branch.dataset.loading;
    }
  }

  function toggle(button, branch, id, path) {
    const next = branch.hidden;
    button.setAttribute('aria-expanded', String(next));
    branch.hidden = !next;
    persist(id, next);
    if (next && !branch.dataset.loaded) void load(branch, path);
  }

  function openMenu(button, item, branch, path) {
    if (menu.matches(':popover-open')) menu.hidePopover();
    anchor = button;
    context = {item, branch, path};
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    const maxHeight = Math.max(rect.top, win.innerHeight - rect.bottom) - 14;
    menu.style.maxHeight = Math.max(64, maxHeight) + 'px';
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8)) + 'px';
    menu.style.top = (rect.bottom + height + 8 <= win.innerHeight
      ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)) + 'px';
    menu.querySelector('button').focus();
  }

  function renderNode(item, parent, parentPath) {
    const node = doc.createElement('div');
    node.className = 'swb-tree__node';
    node.innerHTML = `<div class="swb-tree__row"><button type="button" class="swb-tree__expand" aria-label="展开或收起子文档">▸</button>
      <button type="button" class="swb-tree__title"></button><button type="button" class="swb-tree__more" aria-label="更多文档操作" aria-haspopup="true">…</button></div>
      <div class="swb-tree__branch" hidden></div>`;
    const branch = node.querySelector('.swb-tree__branch');
    const button = node.querySelector('.swb-tree__title');
    const disclosure = node.querySelector('.swb-tree__expand');
    const more = node.querySelector('.swb-tree__more');
    button.textContent = item.title;
    button.title = item.title;
    button.dataset.docId = item.id;
    if (active === item.id) button.setAttribute('aria-current', 'page');
    disclosure.disabled = !item.hasChildren;
    disclosure.setAttribute('aria-expanded', 'false');
    disclosure.onclick = () => toggle(disclosure, branch, item.id, item.path);
    button.onclick = () => void openDocument(item.id).catch(failure => { feedback.textContent = failure.message; });
    more.onclick = () => openMenu(more, item, parent, parentPath);
    if (item.hasChildren && expanded.has(item.id)) toggle(disclosure, branch, item.id, item.path);
    return node;
  }

  root.onclick = () => toggle(root, rootBranch, '/', '/');
  if (expanded.has('/')) root.onclick();
  menu.onkeydown = event => {
    const items = [...menu.querySelectorAll('button')];
    const index = items.indexOf(doc.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index + items.length + (event.key === 'ArrowDown' ? 1 : -1)) % items.length].focus();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      menu.hidePopover();
      anchor?.focus();
    }
  };
  menu.onclick = async event => {
    const command = event.target.closest('[data-command]')?.dataset.command;
    if (!command || !context) return;
    const {item} = context;
    menu.hidePopover();
    anchor?.focus();
    feedback.textContent = '';
    try {
      if (command === 'open') await openDocument(item.id);
      if (command === 'copy') {
        await win.navigator.clipboard.writeText('siyuan://blocks/' + item.id);
        feedback.textContent = '已复制块链接';
      }
      if (command === 'create') {
        draft = null;
        form.reset();
        error.hidden = true;
        dialog.showModal();
        title.focus();
      }
    } catch (failure) { feedback.textContent = failure.message; }
  };
  function cancel(event) {
    event.preventDefault();
    if (busy || (title.value.trim() && !win.confirm('放弃正在输入的文档标题？'))) return;
    dialog.close();
  }
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', () => anchor?.focus());
  form.querySelector('[data-cancel]').onclick = cancel;
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !context) return;
    const text = title.value.trim();
    if (!text) {
      error.textContent = '请输入文档标题';
      error.hidden = false;
      return;
    }
    const {item, branch, path} = context;
    busy = true;
    title.readOnly = true;
    host.dataset.treeDraft = 'true';
    error.hidden = true;
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      if (!draft?.id) draft = {title: text};
      const id = await create(item.id, draft);
      if (disposed) return;
      dialog.close();
      title.readOnly = false;
      persist(item.id, true);
      await load(branch, path);
      await openDocument(id);
    } catch (failure) {
      (dialog.open ? error : feedback).textContent = failure.message;
      error.hidden = !dialog.open;
      title.readOnly = Boolean(draft?.id);
    } finally {
      busy = false;
      delete host.dataset.treeDraft;
      for (const button of form.querySelectorAll('button')) button.disabled = false;
    }
  };
  title.addEventListener('input', () => { host.dataset.treeDraft = String(Boolean(title.value.trim())); });
  dialog.addEventListener('close', () => { delete host.dataset.treeDraft; title.readOnly = false; });
  const dispose = () => { disposed = true; if (dialog.open) dialog.close(); host.replaceChildren(); };
  dispose.select = select;
  return dispose;
}
