import {mountAgentWorkspace} from './agent-workspace.js';

let nextBarID = 0;

/** Keep a native chat mounted independently of the workbench's business pages. */
export function mountPersistentAgentBar(host, agentOptions = {}) {
  const doc = host.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'swb-ai-bar';
  root.setAttribute('aria-label', '常驻 AI 助手');
  host.replaceChildren(root);

  let disposed = false;
  let expanded = false;
  let log, templates, hint, toggle, input, header;

  function setExpanded(value) {
    if (disposed) return;
    expanded = value;
    root.dataset.expanded = String(value);
    if (log) log.hidden = !value;
    if (templates) templates.hidden = !value;
    if (hint) hint.hidden = !value;
    if (header) header.hidden = !value;
    if (toggle) {
      toggle.textContent = value ? '收起' : '对话';
      toggle.setAttribute('aria-label', value ? '收起对话' : '展开对话');
      toggle.title = value ? '收起对话' : '展开对话';
      toggle.setAttribute('aria-expanded', String(value));
    }
  }

  const options = {
    ...agentOptions,
    onBusyChange(busy) {
      if (busy) setExpanded(true);
      agentOptions.onBusyChange?.(busy);
    },
  };
  if (typeof agentOptions.chat === 'function') {
    options.chat = (request, callbacks = {}) => agentOptions.chat(request, {
      ...callbacks,
      onEvent(event) {
        if (['question', 'confirm', 'error', 'interrupted'].includes(event.event)) setExpanded(true);
        return callbacks.onEvent?.(event);
      },
    });
  }

  const chat = mountAgentWorkspace(root, options);
  log = root.querySelector('.swa__transcript');
  templates = root.querySelector('.swa__templates');
  hint = root.querySelector('.swa__hint');
  input = root.querySelector('textarea');
  input.placeholder = '想让 AI 做什么？';
  input.setAttribute('aria-label', '常驻 AI 消息');
  log.id = 'swb-ai-history-' + (++nextBarID);

  header = root.querySelector('.swa__head');
  const title = header.querySelector('div');
  title.replaceChildren();
  const name = doc.createElement('strong');
  name.textContent = 'AI 助手';
  title.append(name);
  const notebook = doc.createElement('span');
  notebook.className = 'swb-ai-bar__context';
  notebook.textContent = agentOptions.notebookName || '当前笔记本';
  title.append(notebook);
  const status = root.querySelector('.swa__status');
  status.classList.add('swb-ai-bar__status');
  title.append(status);
  toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', log.id);
  const toggleHistory = () => setExpanded(!expanded);
  toggle.addEventListener('click', toggleHistory);
  toggle.className = 'swb-ai-bar__toggle';
  root.querySelector('.swa__composer').prepend(toggle);
  setExpanded(false);

  return {
    reveal() { setExpanded(true); },
    collapse() { setExpanded(false); },
    focus() { if (!disposed) input.focus(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      toggle.removeEventListener('click', toggleHistory);
      chat.dispose();
      root.remove();
    },
  };
}
