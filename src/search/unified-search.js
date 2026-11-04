import {isAttachmentAssetPath} from '../task-attachment-upload.js';

const keys=['query','kind','category','tag','status','period'];
const enums={kind:['all','task','event','note','attachment'],status:['all','todo','in_progress','done'],period:['all','today','this-week','overdue','unscheduled']};
export function normalizeSearchFilter(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))throw new Error('搜索筛选格式无效');
    const result={query:'',kind:'all',category:'',tag:'',status:'all',period:'all',...input};
    for(const key of keys)if(typeof result[key]!=='string')throw new Error('搜索条件必须为文本');
    for(const [key,values]of Object.entries(enums))if(!values.includes(result[key]))throw new Error('搜索筛选值无效');
    for(const key of ['query','category','tag']){result[key]=result[key].trim();if(result[key].length>(key==='tag'?100:200)||/[\u0000-\u001f]/.test(result[key]))throw new Error('搜索文本过长或含无效字符');}
    return result;
}

export function periodBounds(period,now=new Date()) {
    if(!['today','this-week'].includes(period))return null;
    const start=new Date(now);if(!Number.isFinite(start.getTime()))throw new Error('当前时间无效');
    start.setHours(0,0,0,0);if(period==='this-week')start.setDate(start.getDate()-(start.getDay()+6)%7);
    const end=new Date(start);end.setDate(end.getDate()+(period==='today'?1:7));
    return {from:start.toISOString(),to:end.toISOString()};
}
function stamp(value){
    if(typeof value==='string'&&/^\d{14}$/.test(value))return new Date(+value.slice(0,4),+value.slice(4,6)-1,+value.slice(6,8),+value.slice(8,10),+value.slice(10,12),+value.slice(12,14)).getTime();
    return value?Date.parse(value):NaN;
}
const filename=path=>{try{return decodeURIComponent(path).split('/').at(-1);}catch{return path.split('/').at(-1);}};
const contains=(value,query)=>String(value??'').toLocaleLowerCase().includes(query.toLocaleLowerCase());
function inPeriod(item,period,now){
    if(period==='all')return true;
    if(item.kind==='note'){
        const range=periodBounds(period,now);if(!range)return false;
        const updated=stamp(item.updatedAt);return updated>=Date.parse(range.from)&&updated<Date.parse(range.to);
    }
    if(period==='overdue')return item.kind==='task'&&item.status!=='done'&&stamp(item.endAt)<now.getTime();
    if(period==='unscheduled')return ['task','event'].includes(item.kind)&&!item.startAt&&!item.endAt&&(item.kind!=='task'||item.status!=='done');
    const range=periodBounds(period,now),from=stamp(item.startAt||item.endAt),to=stamp(item.endAt||item.startAt);
    if(!Number.isFinite(from)||!Number.isFinite(to))return false;
    return from===to?from>=Date.parse(range.from)&&from<Date.parse(range.to):from<Date.parse(range.to)&&to>Date.parse(range.from);
}

/** Pure merge/filter; native note rows are already matched by read-only SQL. */
export function searchWorkbench({tasks=[],events=[],notes=[],attachments=[]},input={},now=new Date()){
    const filter=normalizeSearchFilter(input),instant=new Date(now),managed=new Map([...tasks,...events].map(item=>[item.id,item]));
    if(!Number.isFinite(instant.getTime()))throw new Error('当前时间无效');
    const sources=new Map([...notes,...tasks,...events].map(item=>[item.id,item]));
    const candidates=[...tasks,...events,...notes.filter(item=>!managed.has(item.id))];
    for(const task of tasks)for(const path of task.attachmentPaths||[])if(isAttachmentAssetPath(path))candidates.push({id:task.id+':'+path,kind:'attachment',title:filename(path),sourceId:task.id,attachmentPath:path});
    candidates.push(...attachments);
    const results=new Map();
    for(const item of candidates){
        if(!['task','event','note','attachment'].includes(item.kind))continue;
        const attachment=item.kind==='attachment';
        if(attachment&&!isAttachmentAssetPath(item.attachmentPath))continue;
        const source=attachment?(sources.get(item.sourceId)||{...item,kind:'note'}):item;
        if(filter.kind!=='all'&&filter.kind!==item.kind)continue;
        if(filter.category&&source.category!==filter.category)continue;
        if(filter.tag&&!(Array.isArray(source.tags)&&source.tags.includes(filter.tag)))continue;
        if(filter.status!=='all'&&(source.kind!=='task'||source.status!==filter.status))continue;
        if(!inPeriod(source,filter.period,instant))continue;
        if(filter.query){
            const text=attachment?[filename(item.attachmentPath),item.title]:[item.title,item.detail,item.snippet,...(item.tags||[]),item.category,...(item.checklist||[]).map(step=>step.title)];
            if(!(item.kind==='note'&&item._matchedQuery===filter.query)&&!text.some(value=>contains(value,filter.query)))continue;
        }
        const key=attachment?`attachment:${item.sourceId}:${item.attachmentPath}`:`${item.kind}:${item.id}`;
        const {_matchedQuery,...display}=item;
        results.set(key,{...display,category:source.category||'',tags:source.tags||[],...(source.status?{status:source.status}:{}),...(attachment?{startAt:source.startAt,endAt:source.endAt}:{})});
    }
    return [...results.values()].sort((a,b)=>String(a.title).localeCompare(String(b.title),'zh-CN')||String(a.id).localeCompare(String(b.id)));
}

export function createUnifiedSearchService({listTasks,listEvents,nativeRepository,now=()=>Date.now()}) {
    return {async search(input){
        const criteria=normalizeSearchFilter(input);
        const [tasks,events,native]=await Promise.all([listTasks(),listEvents(),nativeRepository.search(criteria)]);
        if(!Array.isArray(tasks)||!Array.isArray(events)||!Array.isArray(native?.notes)||!Array.isArray(native?.attachments))throw new Error('搜索数据读取未完成，请重试');
        return {items:searchWorkbench({tasks,events,...native},criteria,now()),truncated:native.truncated===true};
    }};
}
