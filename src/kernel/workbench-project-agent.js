import {createWorkbenchProjects} from '../data/workbench-projects.js';
import {isValidNodeID} from '../data/node-id.js';

export const LIST_PROJECTS_CAPABILITY = 'workbench_list_projects';
export const GET_PROJECT_CAPABILITY = 'workbench_get_project';
export const CREATE_PROJECT_CAPABILITY = 'workbench_create_project';
export const UPDATE_PROJECT_CAPABILITY = 'workbench_update_project';
export const PROJECT_PENDING_WRITES_PATH = 'workbench-agent-pending-projects.json';
const ID = {type:'string',pattern:'^\\d{14}-[a-z0-9]{7}$'};
const fields = ['status','priority','owner','startDate','endDate'];
const text = maxLength => ({type:'string',maxLength});
function config(title, description, properties, required, write=false) {
    return {title,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
        outputSchema:{type:'object'},effects:write?{localRead:true,localWrite:true}:{localRead:true}};
}
export const listProjectsConfig = config('查询工作台项目','查询当前工作台笔记本已绑定的项目数据库。最多返回50项元数据、可用选项和属性版本，不读取正文。',
    {search:text(200),status:text(500),limit:{type:'integer',minimum:1,maximum:50}},[]);
export const getProjectConfig = config('查看项目正文','按项目行ID明确读取绑定项目的原生正文，最多10000字，引用文档不展开。', {id:ID},['id']);
export const createProjectConfig = config('创建项目','仅在当前已绑定且可写的项目数据库创建项目和介绍。失败时核查返回文档ID，禁止自动重试未知结果。',
    {title:{...text(120),minLength:1},description:text(10000)},['title'],true);
export const updateProjectConfig = config('更新项目属性','按行ID修改一个项目属性。先查询项目取得该字段revision及可用选项，并把revision原样作为expectedRevision传回。',
    {id:ID,field:{type:'string',enum:fields},value:{anyOf:[text(500),{type:'array',maxItems:50,items:text(500)}]},expectedRevision:text(20000)},['id','field','value','expectedRevision'],true);

function exact(input, allowed, required=[]) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(input,key)))throw new Error('项目操作参数无效或含不允许字段');
}
function validText(value, limit, required=false) {
    if(typeof value!=='string'||value.length>limit||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||(required&&!value.trim()))throw new Error('项目文本参数无效或过长');
    return value;
}
function projectOutput(project) {
    return {id:project.id,documentId:project.documentId,title:project.title,...Object.fromEntries(fields.map(field=>[field,project[field]])),
        editValues:project.editValues,revision:project.revision,editable:project.editable};
}

export function createWorkbenchProjectAgentService({post,fetcher,requireNotebook,newID,storage,repositoryFactory=createWorkbenchProjects}) {
    let writes = Promise.resolve();
    const serialize = operation => {const result=writes.then(operation);writes=result.catch(()=>{});return result;};
    async function bindingFor(notebookId) {
        const response=await fetcher('/api/file/getFile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/data/storage/petal/siyuan-workbench/workbench-projects-'+notebookId+'.json'})});
        if(!response?.ok)throw new Error('当前笔记本尚未关联项目库，请在工作台项目页创建或接入');
        let binding;try{binding=await response.json();}catch{throw new Error('项目数据库配置无法读取');}
        if(!isValidNodeID(binding?.avId)||!isValidNodeID(binding?.blockId)||!isValidNodeID(binding?.documentId))throw new Error('项目数据库绑定无效，请在工作台重新关联');
        return binding;
    }
    async function context(makeID=newID) {
        const notebookId=await requireNotebook();
        if(!isValidNodeID(notebookId))throw new Error('工作台未配置有效笔记本');
        const binding=await bindingFor(notebookId);
        const repository=repositoryFactory({notebookId,post,newID:makeID});
        const snapshot=await repository.list(binding);
        if(snapshot.sourceDocId!==binding.documentId)throw new Error('项目数据库位置已变化，请重新关联');
        const ctx={notebookId,binding,repository,snapshot};await assertCurrent(ctx);return ctx;
    }
    async function assertCurrent(ctx) {
        if(await requireNotebook()!==ctx.notebookId)throw new Error('工作台笔记本已切换，请重新查询');
        const current=await bindingFor(ctx.notebookId);
        if(['avId','blockId','documentId'].some(key=>current[key]!==ctx.binding[key]))throw new Error('项目数据库绑定已变化，请重新查询');
    }
    function member(ctx,id) {
        if(!isValidNodeID(id))throw new Error('项目行ID无效');
        const matches=ctx.snapshot.projects.filter(project=>project.id===id);
        if(matches.length!==1)throw new Error('项目已删除或不属于当前项目库');
        return matches[0];
    }
    async function journal() {
        let data;
        try {data=await storage.get(PROJECT_PENDING_WRITES_PATH);}
        catch {
            // A read failure can be transient. Only a successful directory
            // listing proving absence permits a fresh journal.
            const entries=await storage.list('');
            if(!Array.isArray(entries)||entries.some(entry=>entry?.name===PROJECT_PENDING_WRITES_PATH))throw new Error('项目创建检查记录暂不可读，请稍后核查');
            return {entries:[]};
        }
        const value=await data.json();
        if(!Array.isArray(value?.entries)||value.entries.length>20||value.entries.some(entry=>!isValidNodeID(entry?.documentId)||typeof entry.fingerprint!=='string'))throw new Error('项目创建检查记录无效，请人工核查');
        return value;
    }
    const store=value=>storage.put(PROJECT_PENDING_WRITES_PATH,JSON.stringify(value));
    async function handleListProjects(input={}) {
        exact(input,['search','status','limit']);
        if(input.search!==undefined)validText(input.search,200);
        if(input.status!==undefined)validText(input.status,500);
        const limit=input.limit===undefined?50:input.limit;
        if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('项目查询数量必须为1到50');
        const ctx=await context(),query=(input.search||'').trim().toLowerCase();
        const rows=ctx.snapshot.projects.filter(project=>(!query||project.title.toLowerCase().includes(query))&&(input.status===undefined||project.status===input.status));
        return {name:ctx.snapshot.name,sourceDocId:ctx.snapshot.sourceDocId,fields:ctx.snapshot.fields,readonly:ctx.snapshot.readonly,readonlyReason:ctx.snapshot.readonlyReason,
            total:rows.length,truncated:rows.length>limit,projects:rows.slice(0,limit).map(projectOutput)};
    }
    async function handleGetProject(input={}) {
        exact(input,['id'],['id']);
        if(!isValidNodeID(input.id))throw new Error('项目行ID无效');
        const ctx=await context(),project=member(ctx,input.id);
        if(!isValidNodeID(project.documentId))throw new Error('该项目尚未绑定原生文档');
        const info=await post('/api/block/getBlockInfo',{id:project.documentId});
        if(info?.data?.box!==ctx.notebookId||info.data.rootID!==project.documentId)throw new Error('项目原生文档已移动或不可读');
        const raw=await post('/api/block/getBlockKramdown',{id:project.documentId});
        if(raw?.data?.id!==project.documentId||typeof raw.data.kramdown!=='string')throw new Error('项目正文响应无效');
        await assertCurrent(ctx);
        const current=await ctx.repository.list(ctx.binding);
        if(!current.projects.some(row=>row.id===project.id&&row.documentId===project.documentId))throw new Error('项目绑定已变化');
        const again=await post('/api/block/getBlockInfo',{id:project.documentId});
        if(again?.data?.box!==ctx.notebookId||again.data.rootID!==project.documentId)throw new Error('项目文档位置已变化');
        return {project:projectOutput(project),fields:ctx.snapshot.fields,content:raw.data.kramdown.slice(0,10000),truncated:raw.data.kramdown.length>10000};
    }
    async function handleCreateProject(input={}) {
        exact(input,['title','description'],['title']);
        const title=validText(input.title,120,true).trim(),description=validText(input.description===undefined?'':input.description,10000).trim();
        if(/[\x00-\x1f\x7f]/.test(title))throw new Error('项目名称不能包含控制字符或换行');
        return serialize(async()=>{
            const documentId=newID();if(!isValidNodeID(documentId))throw new Error('无法生成项目文档ID');
            const ctx=await context(()=>documentId);
            if(ctx.snapshot.readonly)throw new Error('项目数据库不可写：'+ctx.snapshot.readonlyReason);
            const pending=await journal(),fingerprint=JSON.stringify([ctx.notebookId,ctx.binding.avId,ctx.binding.blockId,title,description]);
            const existing=pending.entries.find(entry=>entry.fingerprint===fingerprint);
            if(existing)return {created:false,documentId:existing.documentId,commitState:'unknown',message:'此前创建结果待核查，请按文档ID检查；未重复创建'};
            if(pending.entries.length>=20)throw new Error('待核查项目已达20项，请先在原生文档核查');
            const entry={fingerprint,documentId};pending.entries.push(entry);await store(pending);
            let started=false;
            try {
                await assertCurrent(ctx);started=true;
                const result=await ctx.repository.create(ctx.binding,{title,description});
                if(result?.documentId!==documentId)throw new Error('项目文档ID未通过核对');
                await assertCurrent(ctx);
                const snapshot=await ctx.repository.list(ctx.binding);
                const project=snapshot.projects.find(row=>row.documentId===documentId);
                if(!project)throw new Error('项目数据库条目暂未确认');
                pending.entries=pending.entries.filter(value=>value!==entry);await store(pending);
                return {created:true,documentId,project:projectOutput(project),fields:snapshot.fields};
            }catch(error){
                if(!started){pending.entries=pending.entries.filter(value=>value!==entry);await store(pending);throw error;}
                return {created:false,documentId,commitState:'unknown',message:'创建结果待核查，禁止自动重试。'+String(error?.message||'思源未确认保存').slice(0,400)};
            }
        });
    }
    async function handleUpdateProject(input={}) {
        exact(input,['id','field','value','expectedRevision'],['id','field','value','expectedRevision']);
        if(!fields.includes(input.field)||!isValidNodeID(input.id))throw new Error('项目或单字段名称无效');
        validText(input.expectedRevision,20000,true);
        if(Array.isArray(input.value)){if(input.value.length>50||input.value.some(value=>typeof value!=='string'||value.length>500))throw new Error('项目选项无效');}
        else validText(input.value,500);
        return serialize(async()=>{
            const ctx=await context();member(ctx,input.id);
            if(ctx.snapshot.readonly)throw new Error('项目数据库不可写：'+ctx.snapshot.readonlyReason);
            await assertCurrent(ctx);
            const result=await ctx.repository.update(ctx.binding,input);
            const project=result.projects.find(row=>row.id===input.id);
            if(!project)throw new Error('项目保存结果未确认，请刷新核查');
            return {project:projectOutput(project),fields:result.fields};
        });
    }
    return {handleListProjects,handleGetProject,handleCreateProject,handleUpdateProject};
}
