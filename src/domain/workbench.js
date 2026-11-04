import {normalizeChecklist} from './task-checklist.js';
export const TASK_STATUSES = Object.freeze(['todo', 'in_progress', 'done']);
export const TASK_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
export const TASK_QUADRANTS = Object.freeze(['important-urgent', 'important-later', 'urgent-only', 'later']);

export function validateQuadrantOverride(value) {
    if (value !== null && !TASK_QUADRANTS.includes(value)) throw new Error('任务象限无效');
    return value;
}

/** @typedef {'todo'|'in_progress'|'done'} TaskStatus */
/** @typedef {'low'|'normal'|'high'|'urgent'} TaskPriority */
/** @typedef {{kind:'task',id:string,docId?:string,title:string,category:string,tags:string[],priority:TaskPriority|null,status:TaskStatus,startAt:string|null,endAt:string|null,reminderAt:string|null,detail:string,attachmentPaths:string[],createdAt:string,updatedAt:string}} TaskRecord */
/** @typedef {{kind:'event',id:string,docId?:string,title:string,category:string,startAt:string|null,endAt:string|null,reminderAt:string|null,detail:string,createdAt:string,updatedAt:string}} EventRecord */

const isIsoOrNull = value => value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));

export function validateRecord(input) {
    if (!input || !['task', 'event'].includes(input.kind)) throw new Error('记录类型无效');
    if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('标题不能为空');
    if (!isIsoOrNull(input.startAt) || !isIsoOrNull(input.endAt) || !isIsoOrNull(input.reminderAt)) {
        throw new Error('时间格式无效');
    }
    if (input.startAt && input.endAt && Date.parse(input.endAt) < Date.parse(input.startAt)) {
        throw new Error('结束时间不能早于开始时间');
    }
    const base = {
        id: String(input.id || ''), docId: input.docId ? String(input.docId) : undefined,
        kind: input.kind, title: input.title.trim(), category: String(input.category || ''),
        startAt: input.startAt || null, endAt: input.endAt || null, reminderAt: input.reminderAt || null,
        detail: String(input.detail || ''), createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: input.updatedAt || new Date().toISOString(),
    };
    if (input.kind === 'event') return base;
    const status = input.status || 'todo';
    if (!TASK_STATUSES.includes(status)) throw new Error('任务状态无效');
    if (input.priority && !TASK_PRIORITIES.includes(input.priority)) throw new Error('任务优先级无效');
    return {...base, kind: 'task', tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        priority: input.priority || null, status,
        attachmentPaths: Array.isArray(input.attachmentPaths) ? input.attachmentPaths.map(String) : [],
        ...('checklist' in input?{checklist:normalizeChecklist(input.checklist)}:{}),
        ...('quadrantOverride' in input?{quadrantOverride:validateQuadrantOverride(input.quadrantOverride)}:{})};
}
