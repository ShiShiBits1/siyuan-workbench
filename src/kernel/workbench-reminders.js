import {isValidNodeID} from '../data/node-id.js';
import {parseWorkbenchRecordMarkdown} from '../domain/workbench-markdown.js';
import {assertWorkbenchLocation} from '../data/category-location.js';

export const CLAIM_REMINDERS_RPC = 'workbenchClaimReminders';
export const ACK_REMINDER_RPC = 'workbenchAckReminder';
export const REMINDER_STATE_FILE = 'workbench-reminder-acks.json';
const LEASE_MS = 30_000;
const BATCH_SIZE = 20;
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Delivery is at least once until acknowledged. Leases are process local;
// acknowledgement keys survive restarts and changed reminder times form new keys.
export function createWorkbenchReminderService(siyuan, getNotebookId, options = {}) {
    const now = options.now || Date.now;
    const schedule = options.setInterval || setInterval;
    const cancel = options.clearInterval || clearInterval;
    let active = false, generation = 0, timer = null, scannedNotebook, scanPromise = null, lastError = null;
    let due = new Map(), acknowledged = {}, sequence = 0, operations = Promise.resolve();
    const leases = new Map(), registered = new Set();
    const serialize = operation => {
        const result = operations.then(operation);
        operations = result.catch(() => {});
        return result;
    };
    const keyFor = (notebookId, record) => JSON.stringify([notebookId, record.id, record.reminderAt]);

    async function post(path, body) {
        const response = await siyuan.client.fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const payload = await response.json();
        if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || `提醒读取失败：${path}`);
        return payload;
    }

    async function scan() {
        if (!active) return;
        if (scanPromise) return scanPromise;
        const scanGeneration = generation;
        scanPromise = (async () => {
            const notebookId = getNotebookId() || null;
            const next = new Map();
            if (notebookId) {
                if (!isValidNodeID(notebookId)) throw new Error('提醒笔记本配置无效');
                const books = await post('/api/notebook/lsNotebooks', {});
                if (!books.data?.notebooks?.some(book => book.id === notebookId && !book.closed)) throw new Error('提醒笔记本当前不可用');
                const ids = [];
                for (let offset = 0; ; offset += 500) {
                    if (!active || scanGeneration !== generation) return;
                    const page = await post('/api/query/sql', {mode: 'readonly', stmt: `SELECT id FROM blocks WHERE type='d' AND box='${notebookId}' AND (hpath LIKE '/思源工作台/任务/%' OR hpath LIKE '/思源工作台/日程/%') ORDER BY updated DESC, id ASC LIMIT 500 OFFSET ${offset}`});
                    if (!Array.isArray(page.data) || page.truncated) throw new Error('提醒文档查询未完整返回');
                    ids.push(...page.data.map(row => row.id));
                    if (page.data.length < 500) break;
                }
                let index = 0;
                const folderCache=new Map();
                async function worker() {
                    while (active && scanGeneration === generation && index < ids.length) {
                        const id = ids[index++];
                        if (!isValidNodeID(id)) throw new Error('提醒查询返回无效文档 ID');
                        const raw = await post('/api/block/getBlockKramdown', {id});
                        if(raw.data?.id!==id)throw new Error('提醒记录根文档身份不一致');
                        const record = parseWorkbenchRecordMarkdown(raw.data?.kramdown);
                        if (!record) continue; // User-created ordinary documents may share the folder.
                        if (record.id !== id || (record.docId && record.docId !== id)) throw new Error('提醒记录 ID 不一致');
                        if (!record.reminderAt || (record.kind === 'task' && record.status === 'done') || Date.parse(record.reminderAt) > now()) continue;
                        await assertWorkbenchLocation({notebookId,id,kind:record.kind,post,cache:folderCache});
                        const key = keyFor(notebookId, record);
                        if (!owns(acknowledged, key)) next.set(key, {key, id, notebookId, title: record.title, kind: record.kind, reminderAt: record.reminderAt});
                    }
                }
                // Wait for all outstanding reads even on error; scans never overlap.
                const results = await Promise.allSettled(Array.from({length: Math.min(4, ids.length)}, worker));
                const failed = results.find(result => result.status === 'rejected');
                if (failed) throw failed.reason;
            }
            if (active && scanGeneration === generation && (getNotebookId() || null) === notebookId) {
                due = next;
                scannedNotebook = notebookId;
                lastError = null;
                for (const key of leases.keys()) if (!due.has(key)) leases.delete(key);
            }
        })().catch(error => { lastError = error; throw error; }).finally(() => { scanPromise = null; });
        return scanPromise;
    }

    function assertClient(params, ack = false) {
        const allowed = ack ? ['clientId', 'key', 'leaseToken'] : ['clientId'];
        if (!active) throw new Error('提醒服务未运行');
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))
            || typeof params.clientId !== 'string' || !params.clientId || params.clientId.length > 100) throw new Error('提醒客户端参数无效');
    }

    const claim = params => serialize(async () => {
        assertClient(params);
        const claimGeneration = generation;
        const assertCurrent = () => {
            assertClient(params);
            if (claimGeneration !== generation) throw new Error('提醒服务已重新启动，旧认领已失效');
        };
        for (let attempt = 0; attempt < 3 && (scanPromise || scannedNotebook !== (getNotebookId() || null) || lastError); attempt++) await scan();
        if (!active || scannedNotebook !== (getNotebookId() || null) || lastError) throw lastError || new Error('提醒配置正在变化，请稍后重试');
        const reminders = [];
        let available = 0;
        for (const [key, item] of due) {
            if (owns(acknowledged, key)) continue;
            const lease = leases.get(key);
            if (lease && lease.expiresAt > now()) continue;
            // hasMore describes remaining scan candidates, revalidated in the next claim.
            if (reminders.length >= BATCH_SIZE) { available++; continue; }
            // A task can be completed or rescheduled between minute scans.
            const location = await post('/api/filetree/getPathByID', {id: item.id});
            assertCurrent();
            const human = await post('/api/filetree/getHPathByID', {id: item.id});
            assertCurrent();
            const expectedPrefix = item.kind === 'task' ? '/思源工作台/任务/' : '/思源工作台/日程/';
            if (location.data?.notebook !== scannedNotebook || typeof human.data !== 'string' || !human.data.startsWith(expectedPrefix)) {
                due.delete(key); leases.delete(key); continue;
            }
            await assertWorkbenchLocation({notebookId:scannedNotebook,id:item.id,kind:item.kind,post,location:location.data});
            const raw = await post('/api/block/getBlockKramdown', {id: item.id});
            assertCurrent();
            if(raw.data?.id!==item.id)throw new Error('提醒记录根文档身份不一致');
            const fresh = parseWorkbenchRecordMarkdown(raw.data?.kramdown);
            if (!fresh || fresh.id !== item.id || fresh.kind !== item.kind || fresh.reminderAt !== item.reminderAt
                || (fresh.kind === 'task' && fresh.status === 'done') || Date.parse(fresh.reminderAt) > now()) {
                due.delete(key); leases.delete(key); continue;
            }
            if (scannedNotebook !== getNotebookId()) throw new Error('提醒笔记本已切换，请重试');
            item.title = fresh.title;
            available++;
            const leaseToken = `${now()}-${++sequence}`;
            leases.set(key, {clientId: params.clientId, leaseToken, expiresAt: now() + LEASE_MS});
            const {notebookId, ...payload} = item;
            reminders.push({...payload, leaseToken});
        }
        assertCurrent();
        return {notebookId: scannedNotebook || null, reminders, hasMore: available > reminders.length};
    });

    const ack = params => serialize(async () => {
        assertClient(params, true);
        const lease = leases.get(params.key), item = due.get(params.key);
        if (!item || item.notebookId !== getNotebookId() || !lease || lease.clientId !== params.clientId
            || lease.leaseToken !== params.leaseToken || lease.expiresAt <= now()) throw new Error('提醒租约无效或已过期');
        const next = {...acknowledged, [params.key]: new Date(now()).toISOString()};
        await siyuan.storage.put(REMINDER_STATE_FILE, JSON.stringify({version: 1, acknowledged: next}));
        acknowledged = next;
        leases.delete(params.key);
        due.delete(params.key);
        return {acknowledged: true};
    });

    async function onload() {
        const entries = await siyuan.storage.list('');
        if (entries.some(entry => entry.name === REMINDER_STATE_FILE)) {
            const stored = await (await siyuan.storage.get(REMINDER_STATE_FILE)).json();
            if (stored?.version !== 1 || !stored.acknowledged || typeof stored.acknowledged !== 'object' || Array.isArray(stored.acknowledged)) throw new Error('提醒确认文件损坏');
            acknowledged = stored.acknowledged;
        }
        generation++;
        active = true;
        try {
            await siyuan.rpc.bind(CLAIM_REMINDERS_RPC, claim); registered.add(CLAIM_REMINDERS_RPC);
            await siyuan.rpc.bind(ACK_REMINDER_RPC, ack); registered.add(ACK_REMINDER_RPC);
            timer = schedule(() => { void scan().catch(error => { void siyuan.logger?.warn?.(error.message); }); }, 60_000);
            void scan().catch(() => {});
        } catch (error) { await onunload(); throw error; }
    }

    async function onunload() {
        generation++;
        active = false;
        if (timer !== null) cancel(timer);
        timer = null;
        leases.clear(); due.clear(); scannedNotebook = undefined;
        const cleanup = await Promise.allSettled([...registered].map(name => siyuan.rpc.unbind(name)));
        registered.clear();
        const failed = cleanup.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
    return {onload, onunload, scan, claim, ack};
}
