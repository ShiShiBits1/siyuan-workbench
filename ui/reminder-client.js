const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

export function formatReminderMessage(reminder) {
  const due = new Date(reminder.reminderAt);
  if (Number.isNaN(due.getTime())) throw new Error('提醒时间无效');
  const kind = reminder.kind === 'task' ? '任务提醒' : '日程提醒';
  return `${kind}：${escapeHTML(reminder.title)}<br>到期时间：${escapeHTML(due.toLocaleString('zh-CN', {hour12: false}))}`;
}

export function createReminderClient({clientId, claim, ack, show, getNotebookId,
  schedule = setInterval, cancel = clearInterval, intervalMs = 10000}) {
  let timer = null;
  let enabled = false;
  let stopped = false;
  let polling = false;
  let generation = 0;
  const presented = new Set();

  async function poll() {
    if (!enabled || stopped || polling) return;
    polling = true;
    const current = generation;
    const active = () => enabled && !stopped && current === generation;
    try {
      const batch = await claim({clientId});
      if (!active() || !batch?.notebookId || batch.notebookId !== getNotebookId()) return;
      if (!Array.isArray(batch.reminders)) throw new Error('提醒响应无效');
      for (const reminder of batch.reminders) {
        if (!active()) return;
        if (!reminder?.key || !reminder.leaseToken || !['task', 'event'].includes(reminder.kind)) continue;
        try {
          if (!presented.has(reminder.key)) {
            await show(formatReminderMessage(reminder));
            if (!active()) return;
            presented.add(reminder.key);
            if (presented.size > 2000) presented.delete(presented.values().next().value);
          }
          if (!active()) return;
          await ack({clientId, key: reminder.key, leaseToken: reminder.leaseToken});
        } catch {
          // Failed presentation is not acknowledged. A failed acknowledgement
          // can retry under a fresh lease without displaying twice this session.
        }
      }
    } catch {
      // Kernel unavailable: leave reminders unacknowledged for a later poll.
    } finally {
      polling = false;
    }
  }

  return {
    poll,
    setEnabled(value) {
      if (stopped) return;
      generation += 1;
      enabled = Boolean(value);
      if (timer !== null) cancel(timer);
      timer = enabled ? schedule(() => { void poll(); }, intervalMs) : null;
      if (enabled) void poll();
    },
    stop() {
      stopped = true; enabled = false; generation += 1;
      if (timer !== null) cancel(timer);
      timer = null;
      presented.clear();
    },
  };
}
