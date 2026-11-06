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
  let log, templates, hint, toggle, input;

  function setExpanded(value) {
    if (disposed) return;
    expanded = value;
    root.dataset.expanded = String(value);
    if (log) log.hidden = !value;
    if (templates) templates.hidden = !value;
    if (hint) hint.hidden = !value;
    if (toggle) {
      toggle.textContent = value ? '收起对话' : '展开对话';
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
  input.placeholder = '描述要完成的工作，或让助手创建任务…';
  input.setAttribute('aria-label', '常驻 AI 消息');
  log.id = 'swb-ai-history-' + (++nextBarID);

  const header = root.querySelector('.swa__head');
  const title = header.querySelector('div');
  title.replaceChildren();
  const name = doc.createElement('strong');
  name.textContent = 'AI 助手';
  title.append(name);
  const notebook = doc.createElement('span');
  notebook.className = 'swb-ai-bar__context';
  notebook.textContent = agentOptions.notebookName || '当前笔记本';
  title.append(notebook);
  toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', log.id);
  const toggleHistory = () => setExpanded(!expanded);
  toggle.addEventListener('click', toggleHistory);
  header.insertBefore(toggle, header.querySelector('[data-agent-action="new"]'));
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
