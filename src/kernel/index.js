import {createWorkbenchAgentService} from './workbench-agent.js';
import {createWorkbenchReminderService} from './workbench-reminders.js';

const kernel = globalThis.siyuan;
const service = createWorkbenchAgentService(kernel);
const reminders = createWorkbenchReminderService(kernel, service.getNotebookId);

kernel.plugin.lifecycle.onload = async () => {
    try { await service.onload(); await reminders.onload(); }
    catch (error) {
        await Promise.allSettled([reminders.onunload(), service.onunload()]);
        throw error;
    }
};
kernel.plugin.lifecycle.onunload = async () => {
    const results = await Promise.allSettled([reminders.onunload(), service.onunload()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
};
