import {isValidNodeID, newNodeID, stableNodeID} from './node-id.js';

const fieldNames = {
    status: ['状态', '项目状态'],
    priority: ['优先级', '项目优先级'],
    owner: ['负责人', '负责任', '项目负责人'],
    startDate: ['开始日期', '开始时间'],
    endDate: ['结束日期', '结束时间', '截止日期'],
};

const editableTypes = {
    status: ['select'],
    priority: ['select'],
    owner: ['text', 'select', 'mSelect'],
    startDate: ['date'],
    endDate: ['date'],
};

function projectField(av, name) {
    const matches = av.keyValues.filter(field => fieldNames[name].includes(field?.key?.name?.trim()));
    const field = matches[0];
    const key = field?.key;
    const options = Array.isArray(key?.options)
        ? key.options.filter(option => typeof option?.name === 'string' && option.name.trim())
        : [];
    const optionNames = options.map(option => option.name);
    return {
        key,
        options,
        values: Array.isArray(field?.values) ? field.values.filter(Boolean) : [],
        editable: matches.length === 1 && isValidNodeID(key.id) && editableTypes[name].includes(key.type)
            && new Set(optionNames).size === optionNames.length,
    };
}

function fieldRevision(key, value) {
    return JSON.stringify([key.id, key.type, value ?? null]);
}

function editValue(type, cell) {
    if (type === 'mSelect') return (cell?.mSelect || []).map(option => option?.content).filter(Boolean);
    return plainValue(cell);
}

function canEditCell(field, cell) {
    if (!field.editable) return false;
    if (!cell) return true;
    if (cell.type && cell.type !== field.key.type) return false;
    if (field.key.type === 'date') {
        const date = cell.date;
        return !date || (!date.hasEndDate && !date.isNotEmpty2 && (!date.isNotEmpty || date.isNotTime === true));
    }
    if (field.key.type === 'text') return !cell.text?.rich;
    const selected = cell.mSelect || [];
    if (field.key.type === 'select' && selected.length > 1) return false;
    return selected.every(value => field.options.some(option => option.name === value?.content));
}

function valueForWrite(field, value) {
    const {type} = field.key;
    if (type === 'text') {
        if (typeof value !== 'string' || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('请输入不超过 500 个字符的负责人名称');
        return {type, text:{content:value}};
    }
    if (type === 'date') {
        const date = value === '' ? 0 : Date.parse(value + 'T00:00:00');
        if (typeof value !== 'string' || (value !== '' && (
            !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date)
            || plainValue({date:{content:date,isNotEmpty:true}}) !== value
        ))) throw new Error('请输入有效日期');
        return {type,date:{content:date,content2:0,isNotEmpty:value !== '',isNotEmpty2:false,hasEndDate:false,isNotTime:true}};
    }
    const selected = type === 'mSelect' ? value : value === '' ? [] : [value];
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length) throw new Error('请选择有效的数据库选项');
    const options = new Map(field.options.map(option => [option.name, option]));
    const mSelect = selected.map(name => {
        const option = options.get(name);
        if (!option) throw new Error('选项已变更，请刷新后重试');
        return {content:option.name,color:option.color};
    });
    return {type,mSelect};
}

function plainValue(value) {
    if (Array.isArray(value?.mSelect)) return value.mSelect.map(option => option?.content).filter(Boolean).join('、');
    if (value?.date?.isNotEmpty && Number.isFinite(value.date.content)) {
        const date = new Date(value.date.content);
        if (!Number.isNaN(date.getTime())) {
            const pad = number => String(number).padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
        }
    }
    return typeof value?.text?.content === 'string' ? value.text.content : '';
}

export function createWorkbenchProjects({notebookId, post, isReadOnly = () => false, newID = newNodeID}) {
    if (!isValidNodeID(notebookId) || typeof post !== 'function') throw new Error('项目笔记本配置无效');
    const staged = new Map();
    let creating = false;
    let creatingDatabase = null;
    const pendingEdits = new Set();

    async function api(path, body) {
        const response = await post(path, body);
        if (response?.code !== 0) throw new Error(response?.msg || '思源未确认项目操作');
        return response.data;
    }

    async function findBlocks(ids, type) {
        const results = [];
        for (let index = 0; index < ids.length; index += 200) {
            const batch = ids.slice(index, index+200).filter(isValidNodeID);
            if (!batch.length) continue;
            const rows = await api('/api/query/sql', {
                mode: 'readonly',
                stmt: `SELECT id, type, root_id, path, content FROM blocks WHERE box='${notebookId}' AND type='${type}' AND id IN (${batch.map(id => "'"+id+"'").join(',')})`,
            });
            if (!Array.isArray(rows)) throw new Error('思源文档列表响应无效');
            results.push(...rows.filter(row => batch.includes(row?.id) && row.type === type));
        }
        return results;
    }

    async function database(avId) {
        const {av} = await api('/api/av/getAttributeView', {id:avId}) || {};
        if (av?.id !== avId || !Array.isArray(av.keyValues)) throw new Error('无法读取该思源数据库');
        return av;
    }

    async function blockBinding(block) {
        if (!isValidNodeID(block?.root_id)) throw new Error('找不到数据库所在文档');
        const data = await api('/api/block/getBlockDOM', {id:block.id});
        const tag = typeof data?.dom === 'string' ? data.dom.match(/^\s*<[^>]+>/)?.[0] : '';
        const avId = tag?.match(/\sdata-av-id=(["'])(.*?)\1/)?.[2];
        if ((data?.id && data.id !== block.id) || !isValidNodeID(avId)) throw new Error('该块不是可读取的思源数据库');
        return {avId, blockId:block.id, documentId:block.root_id};
    }

    async function resolve(input) {
        const raw = typeof input === 'string' ? input.trim() : '';
        const id = raw.match(/^siyuan:\/\/blocks\/([^?/#]+)(?:\?[^#]*)?$/)?.[1] || raw;
        if (!isValidNodeID(id)) throw new Error('请粘贴思源数据库块链接或数据库 ID');
        const [block] = await findBlocks([id], 'av');
        if (block) {
            const binding = await blockBinding(block);
            const av = await database(binding.avId);
            return {...binding, name:av.name || '项目数据库'};
        }
        if (raw.startsWith('siyuan:')) throw new Error('当前工作台笔记本中找不到这个数据库块');
        const av = await database(id);
        const result = await api('/api/av/getAttributeViewPrimaryKeyValues', {id, page:1, pageSize:1});
        const candidates = await findBlocks(Array.isArray(result?.blockIDs) ? result.blockIDs : [], 'av');
        if (candidates.length !== 1) throw new Error('请复制当前笔记本内目标数据库的块链接，以确认数据库位置');
        const binding = await blockBinding(candidates[0]);
        if (binding.avId !== id) throw new Error('数据库 ID 与数据库块不匹配');
        return {...binding, name:av.name || '项目数据库'};
    }

    async function readBinding(binding) {
        if (!isValidNodeID(binding?.blockId) || !isValidNodeID(binding?.avId)) throw new Error('请先关联项目数据库');
        const [block] = await findBlocks([binding.blockId], 'av');
        const fresh = await blockBinding(block);
        if (fresh.avId !== binding.avId) throw new Error('数据库块的绑定已变更，请重新关联');
        return {fresh, av:await database(fresh.avId)};
    }

    function primaryValues(av) {
        const values = av.keyValues.find(field => field?.key?.type === 'block')?.values;
        return Array.isArray(values) ? values : [];
    }

    async function list(binding) {
        const {fresh, av} = await readBinding(binding);
        return projectSnapshot(fresh, av);
    }

    async function projectSnapshot(fresh, av) {
        const values = primaryValues(av).filter(value => isValidNodeID(value?.blockID || value?.id));
        const ids = [...new Set(values.filter(value => !value.isDetached).map(value => value.block?.id).filter(isValidNodeID))];
        const [docs, readonlyReason] = await Promise.all([findBlocks(ids, 'd'), readOnlyReason(fresh)]);
        const documents = new Map(docs.map(row => [row.id,row]));
        const cells = Object.keys(fieldNames).map(name => {
            const field = projectField(av, name);
            return {name, field, values:new Map(field.values.map(value => [value.blockID,value]))};
        });
        const fields = Object.fromEntries(cells.map(({name,field}) => [name, {
            type:field.key?.type || '',
            options:field.options.map(option => option.name),
            label:field.key?.name || fieldNames[name][0],
            editable:!readonlyReason && field.editable,
        }]));
        const projects = values.map(value => {
            const id = value.blockID || value.id;
            const doc = !value.isDetached && documents.get(value.block?.id);
            const row = {
                id, documentId:doc?.id || '',
                title:doc?.content || value.block?.content || '未命名项目',
                editValues:{}, revision:{}, editable:{},
            };
            for (const {name,field,values} of cells) {
                const cell = values.get(id);
                row[name] = plainValue(cell);
                row.editValues[name] = editValue(field.key?.type,cell);
                row.editable[name] = !readonlyReason && isValidNodeID(value.blockID) && canEditCell(field,cell);
                if (row.editable[name]) row.revision[name] = fieldRevision(field.key,cell);
            }
            return row;
        });
        return {name:av.name || '项目数据库',sourceDocId:fresh.documentId,projects,fields,readonly:!!readonlyReason,readonlyReason};
    }

    async function readOnlyReason(binding) {
        if (isReadOnly()) return '当前思源工作区为只读';
        try {
            const result = await api('/api/av/renderAttributeView', {id:binding.avId,blockID:binding.blockId,ignoreRows:true,createIfNotExist:false});
            if (result?.id === binding.avId && result.isMirror === false) return '';
            if (result?.isMirror === true) return '镜像数据库为只读，请在原生源数据库编辑';
        } catch { /* Keep browsing available when edit permission cannot be confirmed. */ }
        return '无法确认数据库可编辑，请打开原生数据库检查';
    }

    async function assertWritable(binding) {
        const reason = await readOnlyReason(binding);
        if (reason) throw new Error('请选择可编辑的项目数据库。'+reason);
    }

    async function update(binding, {id,field:name,value,expectedRevision} = {}) {
        if (!isValidNodeID(id) || !Object.hasOwn(fieldNames,name)) throw new Error('项目或属性标识无效');
        const token = JSON.stringify([binding?.avId,id,name]);
        if (pendingEdits.has(token)) throw new Error('该属性正在保存');
        pendingEdits.add(token);
        try {
            const {fresh} = await readBinding(binding);
            await assertWritable(fresh);
            const {fresh:current,av} = await readBinding(fresh);
            if (current.documentId !== fresh.documentId) throw new Error('数据库已移动，请刷新项目列表');
            if (!primaryValues(av).some(row => row?.blockID === id)) throw new Error('项目已移动或删除，请刷新项目列表');
            const field = projectField(av,name);
            const cell = field.values.find(value => value.blockID === id);
            if (!canEditCell(field,cell)) throw new Error('该属性暂不可在工作台编辑，请打开原生数据库');
            if (expectedRevision !== fieldRevision(field.key,cell)) throw new Error('此属性已在别处更新，请刷新后重试');
            const next = valueForWrite(field,value);
            const unchanged = JSON.stringify(editValue(field.key.type,cell)) === JSON.stringify(editValue(field.key.type,next));
            if (unchanged) return projectSnapshot(current,av);
            if (isReadOnly()) throw new Error('当前思源工作区为只读');
            await api('/api/av/setAttributeViewBlockAttr', {avID:current.avId,keyID:field.key.id,itemID:id,value:next});
            await api('/api/sqlite/flushTransaction', {});
            const snapshot = await list(current);
            const saved = snapshot.projects.find(project => project.id === id)?.editValues?.[name];
            const desired = editValue(field.key.type,next);
            const compare = value => JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
            if (compare(saved) !== compare(desired)) throw new Error('暂未核对到保存结果，请刷新项目列表');
            return snapshot;
        } finally {
            pendingEdits.delete(token);
        }
    }

    function alreadyBound(av, documentId) {
        return primaryValues(av).some(value => !value?.isDetached && value?.block?.id === documentId);
    }

    async function create(binding, draft) {
        if (creating) throw new Error('正在创建项目，请稍候');
        const title = typeof draft?.title === 'string' ? draft.title.trim() : '';
        const description = typeof draft?.description === 'string' ? draft.description.trim() : '';
        if (!title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('请输入不超过 120 个字符的项目名称');
        if (description.length > 10000) throw new Error('项目介绍不能超过 10000 个字符');
        creating = true;
        let documentId = '';
        try {
            const {fresh} = await readBinding(binding);
            await assertWritable(fresh);
            documentId = draft.documentId || newID();
            const parentID = fresh.documentId;
            const stagedKey = `${fresh.avId}:${fresh.blockId}:${parentID}:${title}`;
            if (draft.documentId && staged.get(documentId) !== stagedKey) throw new Error('无法确认待重试的项目文档');
            const marker = `<!-- siyuan-workbench-project:${fresh.avId}:${documentId} -->`;
            const markdown = `${marker}\n\n## 关于此项目\n\n${description || '概述项目目标和背景。'}\n\n## 待办事项\n\n- [ ] 填写下一步行动\n\n## 项目资料\n\n在这里添加相关文档的块引用。`;
            staged.set(documentId, stagedKey);
            const document = draft.documentId ? await post('/api/filetree/getPathByID', {id:documentId}) : null;
            if (document?.code !== 0) {
                await api('/api/filetree/createDocByParent', {
                    notebook:notebookId,parentID,id:documentId,title:{format:'plain',text:title},markdown,
                });
            }
            const [parent, child, raw] = await Promise.all([
                api('/api/filetree/getPathByID', {id:parentID}),
                api('/api/filetree/getPathByID', {id:documentId}),
                api('/api/block/getBlockKramdown', {id:documentId}),
            ]);
            const ownership=raw?.kramdown?.includes(marker)||
                (await api('/api/attr/getBlockAttrs',{id:documentId}))?.['custom-workbench-project-origin']===`${fresh.avId}:${documentId}`;
            if (parent?.notebook !== notebookId || child?.notebook !== notebookId || !parent.path?.endsWith('.sy')
                || child.path !== parent.path.slice(0,-3)+'/'+documentId+'.sy'
                || raw?.id !== documentId || !ownership) {
                throw new Error('项目文档身份或目录不匹配，无法绑定');
            }
            const confirmed = await readBinding(fresh);
            if (confirmed.fresh.documentId !== parentID) throw new Error('项目数据库的位置已变更，未绑定项目文档');
            if (!alreadyBound(confirmed.av, documentId)) {
                await assertWritable(fresh);
                await api('/api/av/addAttributeViewBlocks', {
                    avID:fresh.avId,blockID:fresh.blockId,ignoreDefaultFill:true,srcs:[{id:documentId,isDetached:false}],
                });
                await api('/api/sqlite/flushTransaction', {});
                if (!alreadyBound(await database(fresh.avId), documentId)) throw new Error('项目文档已建立，但暂未确认数据库条目');
            }
            staged.delete(documentId);
            return {documentId};
        } catch (failure) {
            const error = failure instanceof Error ? failure : new Error(String(failure));
            if (documentId && staged.has(documentId)) error.documentId = documentId;
            throw error;
        } finally {
            creating = false;
        }
    }

    async function initializeDatabase() {
        if (isReadOnly()) throw new Error('当前思源工作区为只读');
        const seed = notebookId + ':siyuan-workbench:projects:';
        const documentId = stableNodeID(seed + 'document');
        const blockId = stableNodeID(seed + 'block');
        const avId = stableNodeID(seed + 'database');
        const marker = `<!-- siyuan-workbench-project-database:${notebookId}:${avId} -->`;
        const markdown = `${marker}\n\n在工作台的项目页新建项目，项目文档会保存在这里。\n`;
        let info = await post('/api/block/getBlockInfo', {id:documentId});
        if (info?.code !== 0) {
            try {
                await api('/api/filetree/createDocByParent', {
                    notebook:notebookId, parentID:null, id:documentId,
                    title:{format:'plain',text:'项目'}, markdown,
                });
            } catch (error) {
                info = await post('/api/block/getBlockInfo', {id:documentId});
                if (info?.code !== 0) throw error;
            }
            await api('/api/sqlite/flushTransaction', {});
            info = await post('/api/block/getBlockInfo', {id:documentId});
        }
        if (info?.code !== 0 || info.data?.box !== notebookId || info.data.rootID !== documentId) {
            throw new Error('项目目录标识已被占用或无法确认，请在原生文档中核查');
        }
        const raw = await api('/api/block/getBlockKramdown', {id:documentId});
        if (raw?.id !== documentId || !raw.kramdown?.includes(marker)) {
            throw new Error('项目目录的身份标记不匹配，未修改原文档');
        }
        const attributes = await api('/api/attr/getBlockAttrs', {id:documentId});
        const initialized = attributes?.['custom-workbench-project-database-initialized'] === avId;
        const [existing] = await findBlocks([blockId], 'av');
        if (!existing) {
            const blockInfo = await post('/api/block/getBlockInfo', {id:blockId});
            if (blockInfo?.code === 0) throw new Error('项目数据库块标识已被占用');
            try {
                await api('/api/block/appendBlock', {
                    parentID:documentId, dataType:'dom',
                    data:`<div data-type="NodeAttributeView" data-node-id="${blockId}" data-av-id="${avId}" data-av-type="table"></div>`,
                });
            } catch (error) {
                const [recovered] = await findBlocks([blockId], 'av');
                if (!recovered) throw error;
            }
            await api('/api/sqlite/flushTransaction', {});
        }
        const [block] = await findBlocks([blockId], 'av');
        if (block?.root_id !== documentId) throw new Error('项目数据库不在预期项目目录中');
        const binding = await blockBinding(block);
        if (binding.avId !== avId) throw new Error('项目数据库标识不匹配');
        const rendered = await api('/api/av/renderAttributeView', {
            id:avId, blockID:blockId, createIfNotExist:true, ignoreRows:true,
        });
        if (rendered?.id !== avId || rendered.isMirror !== false) throw new Error('无法初始化可编辑的项目数据库');
        if (initialized) return {...binding,name:(await database(avId)).name || '项目数据库'};
        if (!(await database(avId)).name) {
            await api('/api/transactions', {reqId:Date.now(),transactions:[{doOperations:[
                {action:'setAttrViewName',id:avId,data:'项目'},
            ],undoOperations:[]}]});
            await api('/api/sqlite/flushTransaction', {});
        }
        const definitions = [
            ['状态','select',['未开始','进行中','已完成']],
            ['优先级','select',['紧急','高','普通','低']],
            ['负责人','text'], ['开始日期','date'], ['结束日期','date'],
        ];
        for (const [name,type,labels] of definitions) {
            if (isReadOnly()) throw new Error('当前思源工作区为只读');
            const keyID = stableNodeID(seed + 'field:' + name);
            let av = await database(avId);
            let field = av.keyValues.find(item => item?.key?.id === keyID);
            if (!field) {
                await api('/api/av/addAttributeViewKey', {
                    avID:avId, blockID:blockId, keyID, keyName:name,
                    keyType:type, keyIcon:'', previousKeyID:'',
                });
                av = await database(avId);
                field = av.keyValues.find(item => item?.key?.id === keyID);
            }
            if (field?.key?.type !== type) throw new Error('项目字段类型已变化，请在原生数据库核查');
            if (labels && !field.key.options?.length) {
                // Only initialize unused fields. Existing choices and manual values remain authoritative.
                if (field.values?.some(value => value?.mSelect?.length)) throw new Error('项目字段已有选值但缺少选项，请在原生数据库核查');
                const data = labels.map((name,index) => ({name,color:String(index+1)}));
                await api('/api/transactions', {reqId:Date.now(),transactions:[{doOperations:[
                    {action:'updateAttrViewColOptions',id:keyID,avID:avId,data},
                ],undoOperations:[]}]});
                await api('/api/sqlite/flushTransaction', {});
                const fresh = (await database(avId)).keyValues.find(item => item?.key?.id === keyID);
                if (!labels.every(label => fresh?.key?.options?.some(option => option.name === label))) {
                    throw new Error('项目字段选项保存未确认，请重试创建项目数据库');
                }
            }
        }
        await api('/api/attr/setBlockAttrs', {id:documentId,attrs:{
            'custom-workbench-project-database-initialized':avId,
        }});
        return {...binding,name:(await database(avId)).name || '项目数据库'};
    }

    function createDatabase() {
        if (!creatingDatabase) creatingDatabase = initializeDatabase().finally(() => {creatingDatabase=null;});
        return creatingDatabase;
    }

    return {resolve,list,create,update,createDatabase};
}
