/**
 * SiYuan native-document repository for the workbench.
 * All records remain ordinary, user-visible SiYuan documents. No direct DB access.
 * @typedef {import('../domain/workbench.js').TaskRecord} TaskRecord
 * @typedef {import('../domain/workbench.js').EventRecord} EventRecord
 */
import {fetchSyncPost} from 'siyuan';
import {ensureCategoryFolder} from './category-location.js';
import {readWorkbenchRecords,readWorkbenchRecord} from './read-record-list.js';
import {validateRecord} from '../domain/workbench.js';
import {formatWorkbenchRecordMarkdown, parseWorkbenchRecordMarkdown} from '../domain/workbench-markdown.js';
import {taskAttachmentRefAttrs} from './task-attachment-refs.js';
import {formatWorkbenchNoteMarkdown, parseWorkbenchNoteMarkdown, validateWorkbenchNote} from '../domain/workbench-note-markdown.js';
import {isValidNodeID, newNodeID, stableNodeID} from './node-id.js';
import {WorkbenchPlannerRepository} from './workbench-planner.js';
import {withTaskHistory} from '../domain/task-history.js';

const ROOT = '/思源工作台';
// SiYuan 3.8.9 fetch.ts only calls processMessage when its fourth argument is true.
// Expected folder conflicts are reconciled below; real failures surface in the form.
const defaultPost = (path, body) => fetchSyncPost(path, body, undefined, false);
const nativeNoteAttempts=new WeakMap();
export class WorkbenchRepository {
    /** @param {string} notebookId Selected notebook ID. */
    constructor(notebookId, {post = defaultPost} = {}) {
        if (!notebookId) throw new Error('请先选择用于保存工作台数据的笔记本');
        this.notebookId = notebookId;
        this.post = post;
    }

    /** @param {'task'|'event'} kind @param {{from?:string,to?:string}} [range] @returns {Promise<Array<TaskRecord|EventRecord>>} */
    async list(kind, range = {}) {
        const records=await readWorkbenchRecords({notebookId:this.notebookId,kind,post:this.post});
        const from = range.from ? Date.parse(range.from) : null;
        const to = range.to ? Date.parse(range.to) : null;
        return records.filter(record => {
            let start = record.startAt ? Date.parse(record.startAt) : null;
            let end = record.endAt ? Date.parse(record.endAt) : null;
            if (start === null && end === null) return true;
            if (start === null) start = end;
            if (end === null) end = start;
            return (!from || end >= from) && (!to || start <= to);
        });
    }

    /** @param {string} id @returns {Promise<TaskRecord|EventRecord>} */
    async get(id) {
        return readWorkbenchRecord({notebookId:this.notebookId,id,post:this.post});
    }

    /** @param {Omit<TaskRecord,'id'|'createdAt'|'updatedAt'>|Omit<EventRecord,'id'|'createdAt'|'updatedAt'>} input */
    async create(input) {
        const now = new Date().toISOString();
        const id = input.id || newNodeID();
        // Keep the planned ID on the caller object so an explicit retry reuses it.
        input.id = id;
        input.docId = id;
        const record = withTaskHistory(null,{...input,...validateRecord({...input, id, docId: id, createdAt: now, updatedAt: now})},now);
        delete record._pendingCreate;
        const parentID = await this.#ensureFolders(record.kind,record.category);
        const result = await this.#createDoc({parentID, id, title: record.title, markdown: this.#markdown(record)});
        if (result.recovered) {
            let existing;
            try{
            existing=await this.get(id);
            const location=(await this.#post('/api/filetree/getPathByID',{id})).data;
            const segments=typeof location?.path==='string'?location.path.split('/').filter(Boolean):[];
            const fields=['kind','title','category','startAt','endAt','reminderAt','detail',...(record.kind==='task'?['status','priority','tags','attachmentPaths','checklist','quadrantOverride']:[])];
            if(location?.notebook!==this.notebookId||segments.at(-2)!==parentID||segments.at(-1)!==`${id}.sy`||fields.some(key=>JSON.stringify(existing[key])!==JSON.stringify(record[key]))){
                throw new Error('计划ID已有不同内容或位置的记录，未覆盖；请核查后决定后续操作');
            }
            }catch(error){error.commitState='unknown';error.documentID=id;error.data={...error.data,commitState:'unknown',id};throw error;}
            try{await this.#setAttrs(id,existing);}
            catch(error){throw this.#createdRecordFailure(error,id);}
            return existing;
        }
        try{await this.#setAttrs(id, record);}
        catch(error){throw this.#createdRecordFailure(error,id);}
        return record;
    }

    #createdRecordFailure(error,id){
        // A metadata request's own `none` does not undo the confirmed document.
        error.commitState='committed';error.documentID=id;error.stage='metadata';
        error.data={...error.data,commitState:'committed',id};
        error.message='记录文档已创建或已核对存在，但属性保存失败，请先打开原文档核查：'+error.message;
        return error;
    }

    /** @param {{id?:string, title:string, detail?:string, createdAt?:string, updatedAt?:string}} input */
    async createNote(input) {
        const now = new Date().toISOString();
        const id = input.id || newNodeID();
        // Keep the planned ID and timestamps on the caller draft for safe retries.
        input.id = id;
        input.createdAt ||= now;
        input.updatedAt ||= input.createdAt;
        const note = validateWorkbenchNote({...input, id, type: 'note'});
        if (!isValidNodeID(id)) throw new Error('无效的思源笔记 ID');
        Object.assign(input, note);
        const rootID = await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:root`, null, '思源工作台', 'root');
        const parentID = await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:notes`, rootID, '笔记', 'notes');
        await this.#createNoteDoc({parentID, note});
        await this.#post('/api/attr/setBlockAttrs', {id, attrs: {
            'custom-workbench-type': 'note',
            'custom-workbench-id': id,
        }});
        return note;
    }

    /** Blank native editor document; retry the same draft object after confirmed creation only. */
    async createNativeNote(input){
        if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('原生笔记草稿无效');
        const prior=nativeNoteAttempts.get(input);
        if(prior&&(prior.notebookId!==this.notebookId||prior.note.id!==input.id))throw new Error('原生笔记草稿身份已变化，请核查原文档');
        const now=new Date().toISOString();
        input.id ||= newNodeID();input.createdAt ||= now;input.updatedAt ||= input.createdAt;
        const note=prior?.note||validateWorkbenchNote({...input,type:'note',detail:''});
        if(prior?.phase==='unknown'){const error=new Error('原生笔记创建结果待核查，请先打开计划文档核对，不自动重新创建');error.commitState='unknown';error.documentID=note.id;error.data={commitState:'unknown',id:note.id};throw error;}
        try{
        const rootID=await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:root`,null,'思源工作台','root');
        const parentID=await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:notes`,rootID,'笔记','notes');
        const attempt=prior||{notebookId:this.notebookId,note,parentID,rootID,phase:'pending'};
        if(attempt.parentID!==parentID||attempt.rootID!==rootID)throw new Error('原生笔记目录已变化，请核查原文档');
        const rootLocation=(await this.#post('/api/filetree/getPathByID',{id:rootID})).data;
        const parentLocation=(await this.#post('/api/filetree/getPathByID',{id:parentID})).data;
        const parentHPath=(await this.#post('/api/filetree/getHPathByID',{id:parentID})).data;
        if(rootLocation?.notebook!==this.notebookId||rootLocation.path!==`/${rootID}.sy`||parentLocation?.notebook!==this.notebookId||parentLocation.path!==`/${rootID}/${parentID}.sy`||parentHPath!=='/思源工作台/笔记')throw new Error('原生笔记目录已移动或名称变化，请先在思源核查');
        nativeNoteAttempts.set(input,attempt);
        if(attempt.phase!=='created'){
            attempt.phase='unknown';
            try{const response=await this.#post('/api/filetree/createDocByParent',{notebook:this.notebookId,parentID,id:note.id,title:{format:'plain',text:note.title},markdown:''});
                const actual=response.data?.id||response.data?.document?.id;if(actual&&actual!==note.id)throw new Error('原生笔记创建ID不匹配');attempt.phase='created';
            }catch(error){
                if(error.data?.commitState==='committed'&&(!error.data.id||error.data.id===note.id))attempt.phase='created';
                else{error.commitState=error.data?.commitState==='none'?'none':'unknown';error.documentID=note.id;error.data={...error.data,commitState:error.commitState,id:note.id};error.stage='create';if(error.commitState==='none')nativeNoteAttempts.delete(input);throw error;}
            }
        }
        try{
            const location=(await this.#post('/api/filetree/getPathByID',{id:note.id})).data;
            if(location?.notebook!==this.notebookId||location.path!==`/${rootID}/${parentID}/${note.id}.sy`)throw new Error('新笔记已移动，未补写属性');
            const attrs=(await this.#post('/api/attr/getBlockAttrs',{id:note.id})).data;
            if(!attrs||typeof attrs!=='object'||(attrs['custom-workbench-type']&&attrs['custom-workbench-type']!=='note')||(attrs['custom-workbench-id']&&attrs['custom-workbench-id']!==note.id))throw new Error('原生笔记标记已变化，未覆盖');
            await this.#post('/api/attr/setBlockAttrs',{id:note.id,attrs:{'custom-workbench-type':'note','custom-workbench-id':note.id}});
            const verified=(await this.#post('/api/attr/getBlockAttrs',{id:note.id})).data;
            if(verified?.['custom-workbench-type']!=='note'||verified['custom-workbench-id']!==note.id)throw new Error('笔记属性读回不一致');
            return {...note,nativeEditor:true};
        }catch(error){error.commitState='committed';error.documentID=note.id;error.data={...error.data,commitState:'committed',id:note.id};error.stage='metadata';error.message='原生笔记已创建，但属性或位置核查失败；请打开原文档核对：'+error.message;throw error;}
        }catch(error){if(prior?.phase==='created'&&!error.commitState){error.commitState='committed';error.documentID=note.id;error.data={...error.data,commitState:'committed',id:note.id};error.stage='metadata';}throw error;}
    }

    /** @param {string} id @param {object} patch */
    async update(id, patch) {
        const current = await this.get(id);
        if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('记录修改参数无效');
        if(('id'in patch&&patch.id!==id)||('docId'in patch&&patch.docId!==undefined&&patch.docId!==id)||('kind'in patch&&patch.kind!==current.kind))throw new Error('不允许伪造记录身份');
        const allowed=['title','category','detail','startAt','endAt','reminderAt',...(current.kind==='task'?['tags','priority','status','attachmentPaths','checklist','quadrantOverride']:[])];
        const ignored=['id','docId','kind','createdAt','updatedAt','_pendingCreate'];
        const narrow={};
        for(const [key,value] of Object.entries(patch)){
            if(allowed.includes(key))narrow[key]=value;
            else if(!ignored.includes(key)&&JSON.stringify(value)!==JSON.stringify(current[key]))throw new Error(`不支持修改扩展字段：${key}`);
        }
        if(!Object.keys(narrow).length)return current;
        return new WorkbenchPlannerRepository(this.notebookId,{post:this.post}).patchRecord(id,narrow,{expectedUpdatedAt:patch.updatedAt});
    }

    /** @param {string} id */
    async complete(id) {
        const record = await this.get(id);
        if (record.kind !== 'task') throw new Error('只有任务可以标记完成');
        return this.update(id, {status: 'done'});
    }

    /** @param {string} id */
    async delete(id,options={}) {return new WorkbenchPlannerRepository(this.notebookId,{post:this.post}).deleteTask(id,options);}

    #markdown(record) {
        return formatWorkbenchRecordMarkdown(record);
    }

    async #ensureFolders(kind,category) {
        const rootID = await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:root`, null, '思源工作台', 'root');
        const taskID = await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:tasks`, rootID, '任务', 'tasks');
        const eventID = await this.#ensureFolder(`${this.notebookId}:siyuan-workbench:events`, rootID, '日程', 'events');
        return ensureCategoryFolder({notebookId:this.notebookId,kind,category,parentId:kind==='task'?taskID:eventID,rootId:rootID,post:this.post});
    }

    async #ensureFolder(seed, parentID, title, marker) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const id = stableNodeID(attempt ? `${seed}:collision:${attempt}` : seed);
            try {
                await this.#createDoc({parentID, id, title, marker});
                return id;
            } catch (error) {
                const existing = await this.#readMarkdownIfPresent(id).catch(() => null);
                const expected = `siyuan-workbench-folder:v1:${this.notebookId}:${marker}`;
                if (existing?.includes(expected)) return id;
                if (error.data?.commitState === 'none' && existing) continue;
                throw error;
            }
        }
        throw new Error(`无法安全创建工作台目录：${title}`);
    }

    async #createDoc({parentID, id, title, markdown, marker}) {
        if (!isValidNodeID(id)) throw new Error(`无效的思源文档 ID：${id}`);
        if (parentID !== null && !isValidNodeID(parentID)) throw new Error(`无效的思源父文档 ID：${parentID}`);
        const body = markdown ?? `<!-- siyuan-workbench-folder:v1:${this.notebookId}:${marker} -->`;
        const request = {
            notebook: this.notebookId,
            parentID,
            id,
            title: {format: 'plain', text: title},
            markdown: body,
        };
        try {
            const response = await this.#post('/api/filetree/createDocByParent', request);
            const actualID = response.data?.id || response.data?.document?.id;
            if (actualID && actualID !== id) throw new Error(`思源创建文档返回 ID 不匹配：${actualID}`);
            return {id: actualID || id, recovered: false};
        } catch (error) {
            // `committed` is definitive. For `none`, only recover an existing source
            // document when its marker proves it belongs to this exact workbench write.
            if (error.data?.commitState === 'committed' && (!error.data.id || error.data.id === id)) return {id, recovered: false};
            if (error.data?.commitState === 'none') {
                const existing = await this.#readMarkdownIfPresent(id).catch(() => '');
                const expectedMarker = marker ? `siyuan-workbench-folder:v1:${this.notebookId}:${marker}` : '```workbench-record\n';
                if (existing.includes(expectedMarker)) return {id, recovered: !marker};
            }
            error.documentID = id;
            throw error;
        }
    }

    async #createNoteDoc({parentID, note}) {
        const id = note.id;
        const markdown = formatWorkbenchNoteMarkdown(note);
        const request = {
            notebook: this.notebookId,
            parentID,
            id,
            title: {format: 'plain', text: note.title},
            markdown,
        };
        try {
            const response = await this.#post('/api/filetree/createDocByParent', request);
            const actualID = response.data?.id || response.data?.document?.id;
            if (actualID && actualID !== id) {
                const error = new Error(`思源创建笔记返回 ID 不匹配：${actualID}`);
                error.commitState = 'unknown';
                error.documentID = id;
                throw error;
            }
            return;
        } catch (error) {
            if (error.data?.commitState === 'committed' && (!error.data.id || error.data.id === id)) return;
            if (error.data?.commitState === 'none') {
                const exported = await this.#readMarkdownIfPresent(id).catch(() => '');
                let existing = null;
                try { existing = parseWorkbenchNoteMarkdown(exported); } catch { /* malformed/foreign document is a collision */ }
                if (existing && isSameNote(existing, note)) return;
                error.documentID = id;
                error.idCollision = Boolean(exported);
                if (error.idCollision) error.message = `笔记 ID ${id} 已被其它文档占用，未覆盖现有文档`;
                throw error;
            }
            error.commitState = 'unknown';
            error.documentID = id;
            throw error;
        }
    }

    async #readMarkdownIfPresent(id) {
        const response = await this.#post('/api/export/exportMdContent', {id});
        return response.data?.content || '';
    }

    async #setAttrs(id, record) {
        const attrs = {'custom-workbench-type': record.kind, 'custom-workbench-id': record.id};
        if (record.kind === 'task') {
            attrs['custom-workbench-status'] = record.status;
            Object.assign(attrs, taskAttachmentRefAttrs(record.attachmentPaths));
        }
        await this.#post('/api/attr/setBlockAttrs', {id, attrs});
    }

    async #post(path, body) {
        const response = await this.post(path, body);
        if (!response || response.code !== 0) {
            const error = new Error(response?.msg || `思源接口调用失败：${path}`);
            error.code = response?.code;
            error.data = response?.data;
            throw error;
        }
        return response;
    }
}

function isSameNote(actual, expected) {
    return actual.type === 'note'
        && actual.id === expected.id
        && actual.title === expected.title
        && actual.detail === expected.detail
        && actual.createdAt === expected.createdAt
        && actual.updatedAt === expected.updatedAt;
}
