import {isValidNodeID, newNodeID, stableNodeID} from '../data/node-id.js';
import {TASK_PRIORITIES, validateRecord} from '../domain/workbench.js';
import {withTaskHistory} from '../domain/task-history.js';
import {formatWorkbenchRecordMarkdown, parseWorkbenchRecordMarkdown} from '../domain/workbench-markdown.js';
import {completeTaskCode} from './task-code-update.js';
import {assertWorkbenchLocation,ensureCategoryFolder,categoryFromMarker,assertCategoryFolder} from '../data/category-location.js';
import {createWorkbenchProjectAgentService,LIST_PROJECTS_CAPABILITY,GET_PROJECT_CAPABILITY,CREATE_PROJECT_CAPABILITY,UPDATE_PROJECT_CAPABILITY,listProjectsConfig,getProjectConfig,createProjectConfig,updateProjectConfig} from './workbench-project-agent.js';

export const LIST_TODAY_TASKS_CAPABILITY = 'workbench_list_today_tasks';
export const CREATE_TASK_CAPABILITY = 'workbench_create_task';
export const CREATE_EVENT_CAPABILITY = 'workbench_create_event';
export const COMPLETE_TASK_CAPABILITY = 'workbench_complete_task';
export const SET_NOTEBOOK_RPC = 'workbenchSetNotebook';
export const KERNEL_SETTINGS_PATH = 'workbench-settings.json';
export const PENDING_WRITES_PATH = 'workbench-agent-pending-writes.json';

const ROOT = '/思源工作台/任务';
const FOLDER_ROOT_MARKER = notebookId => `<!-- siyuan-workbench-folder:v1:${notebookId}:root -->`;
const FOLDER_TASKS_MARKER = notebookId => `<!-- siyuan-workbench-folder:v1:${notebookId}:tasks -->`;
const FOLDER_EVENTS_MARKER = notebookId => `<!-- siyuan-workbench-folder:v1:${notebookId}:events -->`;
const PAGE_SIZE = 500;
const MAX_RETURNED_TASKS = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 80;
const MAX_TAG_COUNT = 10;
const MAX_TAG_LENGTH = 48;
const MAX_DETAIL_LENGTH = 10000;
const MAX_CREATE_ATTEMPTS = 3;
const NOTEBOOK_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

const textSchema = maxLength => ({type: 'string', maxLength});
const dateSchema = {type: ['string', 'null'], format: 'date-time'};
const nullablePrioritySchema = {anyOf: [
    {type: 'string', enum: TASK_PRIORITIES},
    {type: 'null'},
]};
const agentTaskOutputSchema = {
    type: 'object',
    properties: {
        id: {type: 'string', pattern: '^\\d{14}-[a-z0-9]{7}$'},
        title: textSchema(MAX_TITLE_LENGTH),
        category: textSchema(MAX_CATEGORY_LENGTH),
        tags: {type: 'array', maxItems: MAX_TAG_COUNT, items: textSchema(MAX_TAG_LENGTH)},
        priority: nullablePrioritySchema,
        status: {type: 'string', enum: ['todo', 'in_progress', 'done']},
        startAt: dateSchema,
        endAt: dateSchema,
        reminderAt: dateSchema,
    },
    required: ['id', 'title', 'category', 'tags', 'priority', 'status', 'startAt', 'endAt', 'reminderAt'],
    additionalProperties: false,
};

function writeCapabilityConfig(title, description, properties, required, outputSchema) {
    return Object.freeze({
        title,
        description,
        inputSchema: {type: 'object', properties, required, additionalProperties: false},
        outputSchema,
        effects: {localWrite: true},
    });
}

export const listTodayTasksConfig = Object.freeze({
    title: '查询今天的工作台任务',
    description: '只读查询当前选定笔记本中今天相关的工作台任务。仅返回标题、分类、标签、优先级、状态和起止/提醒时间，不读取详细内容或附件。',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: {
            date: {type: 'string'},
            total: {type: 'integer'},
            truncated: {type: 'boolean'},
            tasks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: {type: 'string'},
                        title: {type: 'string'},
                        category: {type: 'string'},
                        tags: {type: 'array', items: {type: 'string'}},
                        priority: {type: ['string', 'null']},
                        status: {type: 'string', enum: ['todo', 'in_progress', 'done']},
                        startAt: {type: ['string', 'null']},
                        endAt: {type: ['string', 'null']},
                        reminderAt: {type: ['string', 'null']},
                    },
                    required: ['id', 'title', 'category', 'tags', 'priority', 'status', 'startAt', 'endAt', 'reminderAt'],
                    additionalProperties: false,
                },
            },
        },
        required: ['date', 'total', 'truncated', 'tasks'],
        additionalProperties: false,
    },
    effects: {localRead: true},
});

export const createTaskConfig = writeCapabilityConfig(
    '创建工作台任务',
    '在当前选定笔记本创建一条工作台任务。状态由服务端固定为 todo；不支持创建附件或指定笔记本、文档 ID、SQL、路径或其它状态。此操作会写入本地思源文档并遵循 Agent 审批策略。',
    {
        title: {...textSchema(MAX_TITLE_LENGTH), minLength: 1},
        category: textSchema(MAX_CATEGORY_LENGTH),
        tags: {type: 'array', maxItems: MAX_TAG_COUNT, items: {...textSchema(MAX_TAG_LENGTH), minLength: 1}},
        priority: nullablePrioritySchema,
        startAt: dateSchema,
        endAt: dateSchema,
        reminderAt: dateSchema,
        detail: textSchema(MAX_DETAIL_LENGTH),
    },
    ['title'],
    agentTaskOutputSchema,
);

export const createEventConfig = writeCapabilityConfig(
    '创建工作台日程',
    '在当前选定笔记本创建一条工作台日程。只接受标题、分类、起止时间、提醒时间和详细内容，不接受任务字段、附件或目标路径。此操作会写入本地思源文档并遵循 Agent 审批策略。',
    {
        title: {...textSchema(MAX_TITLE_LENGTH), minLength: 1},
        category: textSchema(MAX_CATEGORY_LENGTH),
        startAt: dateSchema,
        endAt: dateSchema,
        reminderAt: dateSchema,
        detail: textSchema(MAX_DETAIL_LENGTH),
    },
    ['title'],
    {
        type: 'object',
        properties: {
            id: {type: 'string', pattern: '^\\d{14}-[a-z0-9]{7}$'},
            title: textSchema(MAX_TITLE_LENGTH),
            category: textSchema(MAX_CATEGORY_LENGTH),
            startAt: dateSchema,
            endAt: dateSchema,
            reminderAt: dateSchema,
        },
        required: ['id', 'title', 'category', 'startAt', 'endAt', 'reminderAt'],
        additionalProperties: false,
    },
);

export const completeTaskConfig = writeCapabilityConfig(
    '完成工作台任务',
    '按单个思源任务 ID 重新读取工作台记录，确认它是任务后将状态改为 done。不会按标题搜索、批量操作或删除文档。此操作遵循 Agent 审批策略。',
    {id: {type: 'string', pattern: '^\\d{14}-[a-z0-9]{7}$'}},
    ['id'],
    {
        type: 'object',
        properties: {
            id: {type: 'string', pattern: '^\\d{14}-[a-z0-9]{7}$'},
            title: textSchema(MAX_TITLE_LENGTH),
            status: {type: 'string', const: 'done'},
        },
        required: ['id', 'title', 'status'],
        additionalProperties: false,
    },
);

/**
 * Creates the Kernel Agent service. Agent tool side effects are independently
 * declared in their capability configs; notebook/journal files stay in Kernel storage.
 * @param {object} siyuan Kernel-injected API surface.
 * @param {{now?:()=>Date}} [options]
 */
export function createWorkbenchAgentService(siyuan, options = {}) {
    if (!siyuan?.storage || !siyuan?.client?.fetch || !siyuan?.agent || !siyuan?.rpc) {
        throw new Error('思源 Kernel Plugin API 不完整');
    }
    const now = options.now || (() => new Date());
    const makeID = options.newID || newKernelNodeID;
    let configuredNotebookId = null;
    const registeredCapabilities = new Set();
    let rpcRegistered = false;
    let createQueue = Promise.resolve();

    async function loadSettings() {
        try {
            const data = await siyuan.storage.get(KERNEL_SETTINGS_PATH);
            const settings = await data.json();
            configuredNotebookId = isValidNotebookID(settings?.notebookId) ? settings.notebookId : null;
        } catch {
            configuredNotebookId = null;
        }
    }

    async function handleSetNotebook(params) {
        if (!params || typeof params !== 'object' || Array.isArray(params)
            || Object.keys(params).some(key => key !== 'notebookId')) {
            throw new Error('工作台笔记本配置参数无效');
        }
        const notebookId = params.notebookId;
        if (notebookId !== null && !isValidNotebookID(notebookId)) {
            throw new Error('工作台笔记本 ID 无效');
        }
        if (notebookId !== null) await assertNotebookAvailable(notebookId);
        configuredNotebookId = notebookId;
        await siyuan.storage.put(KERNEL_SETTINGS_PATH, JSON.stringify({notebookId}));
        return {configured: Boolean(notebookId), notebookId};
    }

    async function handleListTodayTasks(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
            throw new Error('此查询不接受筛选参数');
        }
        const notebookId = configuredNotebookId;
        if (!notebookId) throw new Error('工作台尚未配置笔记本，请先打开工作台并选择笔记本');
        await assertNotebookAvailable(notebookId);

        const {date, from, to} = getLocalDayRange(now());
        const ids = await listTaskDocumentIDs(notebookId);
        const matches = [];
        for (const id of ids) {
            const record = await readTaskRecord(id,notebookId);
            if (record && isOnLocalDay(record, from, to)) matches.push(toAgentTask(record));
        }
        return {
            date,
            total: matches.length,
            truncated: matches.length > MAX_RETURNED_TASKS,
            tasks: matches.slice(0, MAX_RETURNED_TASKS),
        };
    }

    async function handleCreateTask(input = {}) {
        const fields = normalizeCreateTaskInput(input);
        return serializeCreate(() => createRecord('task', fields));
    }

    async function handleCreateEvent(input = {}) {
        const fields = normalizeCreateEventInput(input);
        return serializeCreate(() => createRecord('event', fields));
    }

    async function handleCompleteTask(input = {}) {
        assertExactKeys(input, ['id'], '完成任务');
        const id = input.id;
        if (!isValidNodeID(id)) throw new Error('任务 ID 格式无效');
        const notebookId = await requireConfiguredNotebook();
        await assertNotebookAvailable(notebookId);
        const parentID = await resolveDocumentParent(id, notebookId);
        await assertDocumentLocation(id, notebookId, parentID, 'task');

        const current = await readRecord(id);
        if (current.kind !== 'task') throw new Error('指定记录不是工作台任务');
        if (current.id !== id) throw new Error('任务记录 ID 与请求 ID 不一致');
        const targetID = current.docId || id;
        if (!isValidNodeID(targetID) || targetID !== id) throw new Error('任务文档 ID 与记录 ID 不一致');
        const verified = await completeTaskCode({post,id,notebookId,now,
            assertLocation: () => assertDocumentLocation(id, notebookId, parentID, 'task'),
        });
        return toCompletedTask(verified);
    }

    function serializeCreate(operation) {
        const result = createQueue.then(operation);
        createQueue = result.catch(() => {});
        return result;
    }

    async function createRecord(kind, fields) {
        const notebookId = await requireConfiguredNotebook();
        await assertNotebookAvailable(notebookId);
        const parentID = await ensureFolders(notebookId, kind, fields.category);
        const fingerprint = createFingerprint(notebookId, kind, fields);
        const payloadFingerprint = createPayloadFingerprint(kind, fields);
        const journal = await readPendingJournal();
        for (const entry of Object.values(journal.entries)) {
            if (!entry.notebookId || !entry.kind || !entry.payloadFingerprint) {
                throw new Error(`存在旧版或未完成的 Agent 创建检查记录 ${entry.id || '(ID 未知)'}；请先人工核对后再创建`);
            }
            if (entry.notebookId !== notebookId && entry.kind === kind
                && entry.payloadFingerprint === payloadFingerprint) {
                throw new Error(`其它笔记本中存在相同内容的未确认记录 ${entry.id}；请先按 ID 检查，避免跨笔记本重复创建`);
            }
        }
        const existing = journal.entries[fingerprint];
        if (existing) {
            if (existing.notebookId !== notebookId || existing.kind !== kind
                || existing.payloadFingerprint !== payloadFingerprint) {
                throw new Error(`待检查记录 ${existing.id} 的笔记本或类型不匹配；请人工核对后再创建`);
            }
            try {
                const recoveredParent=await resolveDocumentParent(existing.id,notebookId);
                await assertDocumentLocation(existing.id, notebookId, recoveredParent, kind);
                const recovered = await readRecord(existing.id);
                if (matchesCreateInput(recovered, kind, fields)) {
                    await setRecordAttrs(existing.id, recovered);
                    const verified = await readRecord(existing.id);
                    if (!matchesCreateInput(verified, kind, fields)) {
                        throw new Error('恢复的 Agent 创建记录在复核期间发生变化');
                    }
                    await clearPendingJournal(journal, fingerprint);
                    return toCreatedOutput(verified);
                }
            } catch {
                // A journal entry without a verifiable matching record is uncertain.
                // Keep its ID and require a human inspection instead of risking a duplicate.
            }
            throw new Error(`上次创建结果不确定；请先在思源检查记录 ID ${existing.id}，不要重试创建`);
        }
        if (Object.keys(journal.entries).length >= 20) {
            throw new Error('存在过多待检查的 Agent 创建记录，请先按 ID 核对后再创建');
        }

        const createdAt = now().toISOString();
        let id = makeID();
        const entry = {id, state: 'prepared', notebookId, kind, payloadFingerprint, updatedAt: createdAt};
        journal.entries[fingerprint] = entry;
        await writePendingJournal(journal);

        for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
            const record = buildRecord(kind, fields, id, createdAt, now().toISOString());
            try {
                const result = await post('/api/filetree/createDocByParent', {
                    notebook: notebookId,
                    parentID,
                    id,
                    title: {format: 'plain', text: record.title},
                    markdown: formatWorkbenchRecordMarkdown(record),
                });
                const actualID = result.data?.id || result.data?.document?.id;
                if (actualID && actualID !== id) {
                    throw await preserveUncertainCreate(journal, fingerprint, entry, id,
                        new Error(`思源返回的记录 ID 不匹配：${actualID}`));
                }
            } catch (error) {
                if (error.commitState === 'committed' && (!error.data?.id || error.data.id === id)) {
                    // The kernel confirms that the document commit completed.
                } else if (error.commitState === 'none' && attempt + 1 < MAX_CREATE_ATTEMPTS) {
                    id = makeID();
                    entry.id = id;
                    entry.state = 'prepared';
                    entry.updatedAt = now().toISOString();
                    await writePendingJournal(journal);
                    continue;
                } else if (error.commitState === 'none') {
                    await clearPendingJournal(journal, fingerprint);
                    throw error;
                } else {
                    throw await preserveUncertainCreate(journal, fingerprint, entry, id, error);
                }
            }

            try {
                await assertDocumentLocation(id, notebookId, parentID, kind);
                const created = await readRecord(id);
                if (!matchesCreateInput(created, kind, fields)) {
                    throw new Error('写入后的记录字段与请求不一致');
                }
                await setRecordAttrs(id, created);
                await assertDocumentLocation(id, notebookId, parentID, kind);
                const verified = await readRecord(id);
                if (!matchesCreateInput(verified, kind, fields)) {
                    throw new Error('写入后的记录复核失败');
                }
                await clearPendingJournal(journal, fingerprint);
                return toCreatedOutput(verified);
            } catch (error) {
                throw await preserveUncertainCreate(journal, fingerprint, entry, id, error);
            }
        }
        await clearPendingJournal(journal, fingerprint);
        throw new Error('无法为工作台记录分配可用的思源文档 ID');
    }

    async function preserveUncertainCreate(journal, fingerprint, entry, id, cause) {
        entry.id = id;
        entry.state = 'uncertain';
        entry.updatedAt = now().toISOString();
        await writePendingJournal(journal);
        const error = new Error(`创建状态不确定，请先在思源按记录 ID 检查，勿自动重试：${id}`, {cause});
        error.documentID = id;
        error.commitState = cause?.commitState || 'unknown';
        throw error;
    }

    async function readPendingJournal() {
        let data;
        try {
            data = await siyuan.storage.get(PENDING_WRITES_PATH);
        } catch {
            return {entries: {}};
        }
        const stored = await data.json();
        if (!stored || typeof stored !== 'object' || !stored.entries || typeof stored.entries !== 'object'
            || Array.isArray(stored.entries)) {
            throw new Error('Agent 创建检查记录文件格式无效，已停止写入以避免重复');
        }
        return stored;
    }

    async function writePendingJournal(journal) {
        await siyuan.storage.put(PENDING_WRITES_PATH, JSON.stringify(journal));
    }

    async function clearPendingJournal(journal, fingerprint) {
        delete journal.entries[fingerprint];
        await writePendingJournal(journal);
    }

    async function ensureFolders(notebookId, kind, category) {
        const rootSeed = `${notebookId}:siyuan-workbench:root`;
        const root = await ensureFolder(notebookId, null, rootSeed, '思源工作台', FOLDER_ROOT_MARKER(notebookId));
        const isTask = kind === 'task';
        const seed = `${notebookId}:siyuan-workbench:${isTask ? 'tasks' : 'events'}`;
        const parentId=await ensureFolder(notebookId, root, seed, isTask ? '任务' : '日程',
            isTask ? FOLDER_TASKS_MARKER(notebookId) : FOLDER_EVENTS_MARKER(notebookId));
        return ensureCategoryFolder({notebookId,kind,category,parentId,rootId:root,post});
    }

    async function ensureFolder(notebookId, parentID, seed, title, marker) {
        for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
            const id = stableNodeID(attempt ? `${seed}:collision:${attempt}` : seed);
            try {
                const response = await post('/api/filetree/createDocByParent', {
                    notebook: notebookId,
                    parentID,
                    id,
                    title: {format: 'plain', text: title},
                    markdown: marker,
                });
                const actualID = response.data?.id || response.data?.document?.id;
                if (actualID && actualID !== id) throw new Error(`工作台目录 ID 不匹配：${actualID}`);
                return id;
            } catch (error) {
                if (error.commitState === 'committed' && (!error.data?.id || error.data.id === id)) return id;
                const existingMarkdown = await readMarkdownIfPresent(id).catch(() => null);
                if (existingMarkdown?.includes(marker)) {
                    const actual=(await post('/api/filetree/getPathByID',{id})).data;
                    const parent=parentID?(await post('/api/filetree/getPathByID',{id:parentID})).data:null;
                    const expectedPath=parentID?`${parent?.path?.replace(/\.sy$/,'')}/${id}.sy`:`/${id}.sy`;
                    if(actual?.notebook===notebookId&&actual.path===expectedPath)return id;
                }
                if (error.commitState === 'none' && existingMarkdown) continue;
                throw error;
            }
        }
        throw new Error(`无法安全创建工作台目录：${title}`);
    }

    async function requireConfiguredNotebook() {
        if (!configuredNotebookId) throw new Error('工作台尚未配置笔记本，请先打开工作台并选择笔记本');
        if (!isValidNotebookID(configuredNotebookId)) throw new Error('工作台笔记本配置无效');
        return configuredNotebookId;
    }

    async function readMarkdownIfPresent(id) {
        const response = await post('/api/export/exportMdContent', {id});
        return typeof response.data?.content === 'string' ? response.data.content : null;
    }

    async function readRecord(id) {
        if (!isValidNodeID(id)) throw new Error('思源文档 ID 格式无效');
        const raw = await post('/api/block/getBlockKramdown', {id});
        if(raw.data?.id!==id)throw new Error('思源记录根文档身份不一致');
        const markdown = raw.data?.kramdown;
        if (typeof markdown !== 'string') throw new Error(`无法读取思源记录：${id}`);
        let record;
        try {
            record = parseWorkbenchRecordMarkdown(markdown);
        } catch (error) {
            throw new Error(`工作台记录无法解析：${id}`, {cause: error});
        }
        if (!record) throw new Error(`指定文档不是工作台记录：${id}`);
        if (record.id !== id || (record.docId && record.docId !== id)) {
            throw new Error(`工作台记录 ID 与文档 ID 不一致：${id}`);
        }
        return record;
    }

    async function resolveDocumentParent(id, notebookId) {
        const location = await post('/api/filetree/getPathByID', {id});
        const data = location.data;
        const segments = typeof data?.path === 'string' ? data.path.split('/').filter(Boolean) : [];
        const parentID = segments[segments.length - 2];
        if (data?.notebook !== notebookId || segments.length < 2
            || !isValidNodeID(parentID) || segments[segments.length - 1] !== `${id}.sy`) {
            throw new Error(`文档不属于当前工作台笔记本或目标目录：${id}`);
        }
        return parentID;
    }

    async function assertDocumentLocation(id, notebookId, parentID, kind) {
        if (!isValidNodeID(id) || !isValidNodeID(parentID)) throw new Error('工作台文档位置 ID 无效');
        const location=await assertWorkbenchLocation({notebookId,id,kind,post});
        if((location.categoryFolderId||location.kindFolderId)!==parentID){
            throw new Error(`文档不属于当前工作台笔记本或目标目录：${id}`);
        }
    }

    async function setRecordAttrs(id, record) {
        const attrs = {'custom-workbench-type': record.kind, 'custom-workbench-id': record.id};
        if (record.kind === 'task') attrs['custom-workbench-status'] = record.status;
        await post('/api/attr/setBlockAttrs', {id, attrs});
    }

    async function listTaskDocumentIDs(notebookId) {
        const ids = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
            const escapedNotebook = notebookId.replaceAll("'", "''");
            const response = await post('/api/query/sql', {
                stmt: `SELECT id FROM blocks WHERE type='d' AND box='${escapedNotebook}' AND hpath LIKE '${ROOT}/%' ORDER BY updated DESC, id ASC LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
                mode: 'readonly',
            });
            if (response.truncated) throw new Error('思源限制了只读查询结果，请稍后重试');
            const rows = Array.isArray(response.data) ? response.data : [];
            ids.push(...rows.map(row => row?.id).filter(id => isValidNodeID(id)));
            if (rows.length < PAGE_SIZE) break;
        }
        return ids;
    }

    async function readTaskRecord(id,notebookId) {
        const raw=(await post('/api/block/getBlockKramdown',{id})).data;
        if(raw?.id!==id||typeof raw.kramdown!=='string')throw new Error('任务查询记录身份不匹配');
        let record;try{record=parseWorkbenchRecordMarkdown(raw.kramdown);}catch(cause){throw new Error(`工作台记录无法解析：${id}`,{cause});}
        if(!record){
            if(categoryFromMarker(raw.kramdown,notebookId,'task')!==null){
                const location=(await post('/api/filetree/getPathByID',{id})).data;
                const parts=typeof location?.path==='string'?location.path.split('/').filter(Boolean):[];
                if(location?.notebook!==notebookId||parts.length!==3||parts[2]!==`${id}.sy`)throw new Error('任务分类目录位置异常');
                await assertCategoryFolder({notebookId,kind:'task',rootId:parts[0],parentId:parts[1],id,post});
            }
            return null;
        }
        if(record.id!==id||(record.docId&&record.docId!==id))throw new Error('任务查询文档与记录身份不匹配');
        if(record.kind!=='task')return null;
        await assertWorkbenchLocation({notebookId,id,kind:'task',post});return record;
    }

    async function assertNotebookAvailable(notebookId) {
        if (!isValidNotebookID(notebookId)) throw new Error('工作台笔记本 ID 无效');
        const response = await post('/api/notebook/lsNotebooks', {});
        const notebooks = response.data?.notebooks;
        if (!Array.isArray(notebooks) || !notebooks.some(notebook => notebook?.id === notebookId)) {
            throw new Error('工作台所选笔记本当前不可用，请重新打开工作台选择笔记本');
        }
    }

    async function post(path, body) {
        const response = await siyuan.client.fetch(path, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        let payload = null;
        try {
            payload = await response?.json?.();
        } catch {
            // The API may return a non-JSON transport error. Preserve status below.
        }
        if (!response?.ok || !payload || payload.code !== 0) {
            const error = new Error(payload?.msg || `思源 API 请求失败：${path}`);
            error.path = path;
            error.code = payload?.code ?? response?.status;
            error.data = payload?.data;
            error.commitState = payload?.data?.commitState;
            throw error;
        }
        return payload;
    }

    const projectService = createWorkbenchProjectAgentService({
        post,
        fetcher:(path,request)=>siyuan.client.fetch(path,request),
        storage:siyuan.storage,
        newID:makeID,
        requireNotebook:async()=>{
            const notebookId=await requireConfiguredNotebook();
            await assertNotebookAvailable(notebookId);
            return notebookId;
        },
    });

    async function onload() {
        await loadSettings();
        await siyuan.rpc.bind(SET_NOTEBOOK_RPC, handleSetNotebook, '同步工作台前端选择的笔记本 ID');
        rpcRegistered = true;
        const capabilities = [
            [LIST_TODAY_TASKS_CAPABILITY, listTodayTasksConfig, handleListTodayTasks],
            [CREATE_TASK_CAPABILITY, createTaskConfig, handleCreateTask],
            [CREATE_EVENT_CAPABILITY, createEventConfig, handleCreateEvent],
            [COMPLETE_TASK_CAPABILITY, completeTaskConfig, handleCompleteTask],
            [LIST_PROJECTS_CAPABILITY,listProjectsConfig,projectService.handleListProjects],
            [GET_PROJECT_CAPABILITY,getProjectConfig,projectService.handleGetProject],
            [CREATE_PROJECT_CAPABILITY,createProjectConfig,projectService.handleCreateProject],
            [UPDATE_PROJECT_CAPABILITY,updateProjectConfig,projectService.handleUpdateProject],
        ];
        for (const [name, config, handler] of capabilities) {
            await siyuan.agent.registerCapability(name, config, handler);
            registeredCapabilities.add(name);
        }
    }

    async function onunload() {
        for (const name of registeredCapabilities) await siyuan.agent.unregisterCapability(name);
        registeredCapabilities.clear();
        if (rpcRegistered) {
            rpcRegistered = false;
            await siyuan.rpc.unbind(SET_NOTEBOOK_RPC);
        }
        configuredNotebookId = null;
    }

    return {
        getNotebookId: () => configuredNotebookId,
        onload,
        onunload,
        handleListTodayTasks,
        handleCreateTask,
        handleCreateEvent,
        handleCompleteTask,
        handleSetNotebook,
        ...projectService,
    };
}

export function isValidNotebookID(notebookId) {
    return typeof notebookId === 'string' && NOTEBOOK_ID_PATTERN.test(notebookId);
}

function assertExactKeys(input, allowed, operation) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`${operation}参数必须是对象`);
    }
    const invalid = Object.keys(input).find(key => !allowed.includes(key));
    if (invalid) throw new Error(`${operation}不接受字段：${invalid}`);
}

function normalizeCreateTaskInput(input) {
    assertExactKeys(input, ['title', 'category', 'tags', 'priority', 'startAt', 'endAt', 'reminderAt', 'detail'], '创建任务');
    const fields = {
        title: normalizeText(input.title, '标题', MAX_TITLE_LENGTH, true),
        category: normalizeText(input.category, '分类', MAX_CATEGORY_LENGTH),
        tags: normalizeTags(input.tags),
        priority: normalizePriority(input.priority),
        startAt: normalizeTime(input.startAt, '开始时间'),
        endAt: normalizeTime(input.endAt, '结束时间'),
        reminderAt: normalizeTime(input.reminderAt, '提醒时间'),
        detail: normalizeText(input.detail, '详细内容', MAX_DETAIL_LENGTH),
    };
    validateTimeRange(fields.startAt, fields.endAt);
    return fields;
}

function normalizeCreateEventInput(input) {
    assertExactKeys(input, ['title', 'category', 'startAt', 'endAt', 'reminderAt', 'detail'], '创建日程');
    const fields = {
        title: normalizeText(input.title, '标题', MAX_TITLE_LENGTH, true),
        category: normalizeText(input.category, '分类', MAX_CATEGORY_LENGTH),
        startAt: normalizeTime(input.startAt, '开始时间'),
        endAt: normalizeTime(input.endAt, '结束时间'),
        reminderAt: normalizeTime(input.reminderAt, '提醒时间'),
        detail: normalizeText(input.detail, '详细内容', MAX_DETAIL_LENGTH),
    };
    validateTimeRange(fields.startAt, fields.endAt);
    return fields;
}

function normalizeText(value, label, limit, required = false) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
    const normalized = label === '详细内容' ? value : value.trim();
    if (required && !normalized) throw new Error(`${label}不能为空`);
    if (normalized.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符`);
    return normalized;
}

function normalizeTags(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('标签必须是数组');
    if (value.length > MAX_TAG_COUNT) throw new Error(`标签最多 ${MAX_TAG_COUNT} 个`);
    const tags = value.map((tag, index) => {
        if (typeof tag !== 'string') throw new Error(`第 ${index + 1} 个标签必须是文本`);
        const normalized = tag.trim();
        if (!normalized) throw new Error(`第 ${index + 1} 个标签不能为空`);
        if (normalized.length > MAX_TAG_LENGTH) throw new Error(`标签不能超过 ${MAX_TAG_LENGTH} 个字符`);
        return normalized;
    });
    return [...new Set(tags)];
}

function normalizePriority(value) {
    if (value === undefined || value === null) return null;
    if (!TASK_PRIORITIES.includes(value)) throw new Error('优先级无效');
    return value;
}

function normalizeTime(value, label) {
    if (value === undefined || value === null) return null;
    const match = typeof value === 'string'
        ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/)
        : null;
    if (!match) {
        throw new Error(`${label}必须是带时区的 ISO 时间`);
    }
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , zone, , zoneHourText = '0', zoneMinuteText = '0'] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const zoneHour = Number(zoneHourText), zoneMinute = Number(zoneMinuteText);
    const calendarCheck = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (calendarCheck.getUTCFullYear() !== year || calendarCheck.getUTCMonth() !== month - 1
        || calendarCheck.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59
        || zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
        throw new Error(`${label}无效`);
    }
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new Error(`${label}无效`);
    return new Date(timestamp).toISOString();
}

function validateTimeRange(startAt, endAt) {
    if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) {
        throw new Error('结束时间不能早于开始时间');
    }
}

function buildRecord(kind, fields, id, createdAt, updatedAt) {
    if (!isValidNodeID(id)) throw new Error('生成的思源文档 ID 格式无效');
    return withTaskHistory(null,validateRecord({
        ...fields,
        id,
        docId: id,
        kind,
        ...(kind === 'task' ? {status: 'todo', attachmentPaths: []} : {}),
        createdAt,
        updatedAt,
    }),createdAt);
}

function createFingerprint(notebookId, kind, fields) {
    const source = JSON.stringify({notebookId, kind, fields});
    return hashFingerprint(source);
}

function createPayloadFingerprint(kind, fields) {
    return hashFingerprint(JSON.stringify({kind, fields}));
}

function hashFingerprint(source) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return `${source.length}-${first.toString(36)}-${second.toString(36)}`;
}

function matchesCreateInput(record, kind, fields) {
    if (record.kind !== kind || record.title !== fields.title || record.category !== fields.category
        || record.startAt !== fields.startAt || record.endAt !== fields.endAt
        || record.reminderAt !== fields.reminderAt || record.detail !== fields.detail) return false;
    if (kind === 'event') return true;
    return record.status === 'todo' && record.priority === fields.priority
        && JSON.stringify(record.tags) === JSON.stringify(fields.tags)
        && Array.isArray(record.attachmentPaths) && record.attachmentPaths.length === 0;
}

function toCreatedOutput(record) {
    return record.kind === 'task' ? toAgentTask(record) : {
        id: record.id,
        title: cleanText(record.title, MAX_TITLE_LENGTH),
        category: cleanText(record.category, MAX_CATEGORY_LENGTH),
        startAt: record.startAt,
        endAt: record.endAt,
        reminderAt: record.reminderAt,
    };
}

function toCompletedTask(record) {
    return {id: record.id, title: cleanText(record.title, MAX_TITLE_LENGTH), status: 'done'};
}

function newKernelNodeID() {
    try {
        return newNodeID();
    } catch (error) {
        if (globalThis.crypto?.getRandomValues) throw error;
        // IDs are locators rather than secrets; the kernel validates conflicts
        // through createDocByParent commitState and bounded collision recovery.
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const suffix = Array.from({length: 7}, () => Math.floor(Math.random() * 36).toString(36)).join('');
        const id = `${stamp}-${suffix}`;
        if (!isValidNodeID(id)) throw new Error('无法生成有效的思源文档 ID');
        return id;
    }
}

export function getLocalDayRange(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('无法确定本机当前日期');
    const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    return {date: formatLocalDate(from), from: from.getTime(), to: to.getTime()};
}

function isOnLocalDay(record, from, to) {
    let start = record.startAt ? Date.parse(record.startAt) : null;
    let end = record.endAt ? Date.parse(record.endAt) : null;
    if (start === null && end === null) return true;
    if (start === null) start = end;
    if (end === null) end = start;
    return start < to && end >= from;
}

function toAgentTask(record) {
    return {
        id: record.id,
        title: cleanText(record.title, 200),
        category: cleanText(record.category, 80),
        tags: record.tags.slice(0, 10).map(tag => cleanText(tag, 48)),
        priority: record.priority,
        status: record.status,
        startAt: record.startAt,
        endAt: record.endAt,
        reminderAt: record.reminderAt,
    };
}

function cleanText(value, limit) {
    return String(value || '').slice(0, limit);
}

function formatLocalDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
