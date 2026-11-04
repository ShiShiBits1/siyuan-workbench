let pickerId = 0;

export function mountCategoryPicker(input, loadCategories) {
  if (!input || typeof loadCategories !== 'function') return;
  const doc = input.ownerDocument;
  const control = doc.createElement('div');
  const toggle = doc.createElement('button');
  const popup = doc.createElement('div');
  const list = doc.createElement('ul');
  const status = doc.createElement('div');
  const id = `swb-category-list-${++pickerId}`;
  control.className = 'swb-category-picker';
  toggle.type = 'button';
  toggle.textContent = '▾';
  toggle.setAttribute('aria-label', '展开已有分类');
  toggle.setAttribute('aria-controls', id);
  toggle.setAttribute('aria-expanded', 'false');
  popup.className = 'swb-category-picker__popup';
  popup.hidden = true;
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '已有分类');
  status.setAttribute('role', 'status');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'none');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  const label = input.parentElement;
  if (label.tagName === 'LABEL') {
    const field = doc.createElement('div');
    field.className = `swb-category-picker-field ${label.className}`;
    input.id ||= `${id}-input`;
    label.htmlFor = input.id;
    label.before(field);
    field.append(label, control);
  } else input.before(control);
  control.append(input, toggle, popup);
  popup.append(list, status);
  let generation = 0;
  let active = -1;

  function setActive(index) {
    active = index;
    for (const [i, option] of [...list.children].entries()) {
      option.setAttribute('aria-selected', String(i === active));
    }
    const option = list.children[active];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }

  function setOpen(open) {
    popup.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起已有分类' : '展开已有分类');
  }

  function close() {
    generation++;
    setOpen(false);
    setActive(-1);
  }

  async function open(direction = 0) {
    if (input.disabled || input.readOnly) return;
    const request = ++generation;
    setOpen(true);
    list.replaceChildren();
    status.textContent = '正在读取分类…';
    try {
      const values = await loadCategories();
      if (request !== generation || !control.isConnected || input.disabled) return;
      for (const [i, value] of values.entries()) {
        const option = doc.createElement('li');
        option.id = `${id}-${i}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.textContent = value;
        list.append(option);
      }
      status.textContent = values.length ? '' : '暂无已有分类，可直接输入新分类';
      if (direction && values.length) setActive(direction > 0 ? 0 : values.length - 1);
    } catch {
      if (request === generation) status.textContent = '分类读取失败，可直接输入或重新展开';
    }
  }

  function choose(option) {
    if (input.disabled || input.readOnly) return;
    input.value = option.textContent;
    close();
    input.focus();
    input.dispatchEvent(new doc.defaultView.Event('input', {bubbles: true}));
    input.dispatchEvent(new doc.defaultView.Event('change', {bubbles: true}));
  }

  toggle.addEventListener('click', event => {
    event.preventDefault();
    if (input.disabled || input.readOnly) return;
    input.focus();
    if (popup.hidden) void open();
    else close();
  });
  control.addEventListener('focusout', event => {
    if (!control.contains(event.relatedTarget)) close();
  });
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option) {
      event.preventDefault();
      choose(option);
    }
  });
  input.addEventListener('input', () => setActive(-1));
  input.form?.addEventListener('submit', close);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const count = list.children.length;
      if (popup.hidden) void open(direction);
      else if (count) setActive(active < 0 ? (direction > 0 ? 0 : count - 1) : (active + direction + count) % count);
    } else if (!popup.hidden && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (!popup.hidden && event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(list.children[active]);
    }
  });
  return {syncDisabled() { toggle.disabled = input.disabled || input.readOnly; }};
}
