import {BUILTIN_TOOLS} from './catalog.js';
import {readToolZip,validateToolFiles,TOOL_LIMITS} from './package.js';
import {buildToolDocument,TOOL_SANDBOX} from './document.js';
const clone=value=>structuredClone(value);
const get=(object,key)=>Object.hasOwn(object,key)?object[key]:undefined;
const compare=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
const same=(a,b)=>JSON.stringify(Object.entries(a.files).sort())===JSON.stringify(Object.entries(b.files).sort());
const token=()=>globalThis.crypto.randomUUID();
export function createToolboxManager({load,save}={}){
    if(typeof load!=='function'||typeof save!=='function')throw Error('缺少工具箱持久化接口');
    let state=null,tail=Promise.resolve();const previews=new Map();
    const builtin=BUILTIN_TOOLS.map(p=>validateToolFiles(p.files));
    const ready=()=>{if(!state)throw Error('工具箱尚未初始化');};
    const serialized=operation=>{const run=tail.then(operation);tail=run.catch(()=>{});return run;};
    const persist=async next=>{if(JSON.stringify(next).length>12*TOOL_LIMITS.totalBytes)throw Error('工具箱本地存储已达上限');await save(clone(next));state=next;};
    const listing=()=>{
        ready();const catalog=new Map(builtin.map(p=>[p.manifest.id,{manifest:clone(p.manifest),source:'builtin'}]));
        for(const [id,value] of Object.entries(state.catalog))catalog.set(id,{manifest:clone(value.manifest),source:'local'});
        const installed=Object.entries(state.installed).map(([id,value])=>({manifest:clone(value.active.manifest),enabled:value.enabled===true,hasRollback:Boolean(value.previous)}));
        return {catalog:[...catalog].map(([id,row])=>({...row,installedVersion:get(state.installed,id)?.active.manifest.version||null,enabled:get(state.installed,id)?.enabled===true,hasRollback:Boolean(get(state.installed,id)?.previous)})),installed};
    };
    async function initialize(){
        return serialized(async()=>{
            if(state)return listing();const data=await load();const next=data==null||(typeof data==='object'&&!Array.isArray(data)&&!Object.keys(data).length)?{schemaVersion:1,catalog:{},installed:{}}:clone(data);
            if(next.schemaVersion!==1||!next.catalog||typeof next.catalog!=='object'||Array.isArray(next.catalog)||!next.installed||typeof next.installed!=='object'||Array.isArray(next.installed))throw Error('工具箱存储格式不受支持，未覆盖原数据');
            for(const [id,p] of Object.entries(next.catalog)){const checked=validateToolFiles(p.files);if(checked.manifest.id!==id||JSON.stringify(p.manifest)!==JSON.stringify(checked.manifest))throw Error('工具目录身份不一致');buildToolDocument(checked);}
            for(const [id,v] of Object.entries(next.installed)){if(!v||typeof v.enabled!=='boolean')throw Error('已装工具状态无效');for(const p of [v.active,v.previous].filter(Boolean)){const checked=validateToolFiles(p.files);if(checked.manifest.id!==id||JSON.stringify(p.manifest)!==JSON.stringify(checked.manifest))throw Error('已装工具身份不一致');buildToolDocument(checked);}}
            state=next;return listing();
        });
    }
    function checkAction(pkg){const current=get(state.installed,pkg.manifest.id)?.active;if(!current)return 'install';const order=compare(pkg.manifest.version,current.manifest.version);if(!order){if(!same(pkg,current))throw Error('同版本工具内容不同，未覆盖已安装版本');return 'same';}if(order<0)throw Error('导入版本较旧，请使用明确的回滚操作');return 'upgrade';}
    const installPackage=async(pkg,local)=>{
        ready();const action=checkAction(pkg);const next=clone(state),id=pkg.manifest.id,old=get(next.installed,id);
        if(action!=='same')next.installed[id]={...old,active:clone(pkg),previous:old?.active?clone(old.active):null,enabled:old?old.enabled:true};
        if(local)next.catalog[id]=clone(pkg);await persist(next);return listing();
    };
    return {
        initialize,list:listing,
        async previewInstall(file){ready();if(file?.size>TOOL_LIMITS.archiveBytes)throw Error('工具ZIP超过2MB');const pkg=await readToolZip(file);buildToolDocument(pkg);const action=checkAction(pkg),id=token();if(previews.size>=8)previews.delete(previews.keys().next().value);previews.set(id,pkg);return {token:id,manifest:clone(pkg.manifest),fileCount:Object.keys(pkg.files).length,totalBytes:pkg.totalBytes,action,warnings:['仅安装你信任的自研工具；iframe与CSP不是敌意代码的绝对隔离','工具输入和输出仅留在当前页面，关闭前请自行保存']};},
        install(id){return serialized(async()=>{ready();const pkg=previews.get(id);if(!pkg)throw Error('安装预览已过期，请重新选择ZIP');const result=await installPackage(pkg,true);previews.delete(id);return result;});},
        installBuiltin(id){return serialized(async()=>{ready();const pkg=get(state.catalog,id)||builtin.find(p=>p.manifest.id===id);if(!pkg)throw Error('目录工具不存在');return installPackage(pkg,false);});},
        setEnabled(id,enabled){return serialized(async()=>{ready();if(typeof enabled!=='boolean'||!get(state.installed,id))throw Error('工具状态参数无效');const next=clone(state);next.installed[id].enabled=enabled;await persist(next);return listing();});},
        uninstall(id){return serialized(async()=>{ready();if(!get(state.installed,id))throw Error('工具尚未安装');const next=clone(state);delete next.installed[id];await persist(next);return listing();});},
        rollback(id){return serialized(async()=>{ready();if(!get(state.installed,id)?.previous)throw Error('没有可回滚版本');const next=clone(state),v=next.installed[id];[v.active,v.previous]=[v.previous,v.active];await persist(next);return listing();});},
        getToolDocument(id){ready();const tool=get(state.installed,id);if(!tool?.enabled)throw Error('请先安装并启用工具');return {manifest:clone(tool.active.manifest),html:buildToolDocument(tool.active),sandbox:TOOL_SANDBOX};}
    };
}
