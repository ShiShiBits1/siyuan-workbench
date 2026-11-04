/** Read/write plugin preferences via official APIs, with no SDK cache fallback. */
export function createNativeSearchViewStorage({fetch:request=globalThis.fetch,key,timeoutMs=8000,getAppId}){
    if(typeof key!=='string'||!/^workbench-search-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-\d{14}-[a-z0-9]{7}\.json$/.test(key))throw new Error('常用筛选存储标识无效');
    const path='/data/storage/petal/siyuan-workbench/'+key;
    async function call(url,options){
        const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);
        try{const response=await request(url,{...options,signal:abort.signal,credentials:'same-origin'});return {ok:response.ok,status:response.status,value:response.status===404?undefined:await response.json()};}
        finally{clearTimeout(timer);}
    }
    async function load(){
        const response=await call('/api/file/getFile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
        if(response.status===404)return undefined;
        if(!response.ok)throw new Error('常用筛选读取失败，请检查思源连接后重新读取');
        const value=response.value;
        // SiYuan 3.8.9 sends binary-file errors as HTTP 202 JSON envelopes.
        if(response.status===202&&value?.code===404&&value.data===null&&typeof value.msg==='string'&&Object.keys(value).every(key=>['code','msg','data'].includes(key)))return undefined;
        if(value&&typeof value==='object'&&'code'in value)throw new Error('思源未确认常用筛选文件可读');
        return value;
    }
    async function save(value){
        let app;
        try{app=typeof getAppId==='function'?getAppId():undefined;}catch{/* An unknown source must never become an anonymous broadcast. */}
        if(typeof app!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(app)){
            const error=new Error('无法确认当前思源前端标识，未保存常用筛选，请重新打开工作台');error.commitState='none';throw error;
        }
        const body=new FormData();body.append('path',path);body.append('isDir','false');body.append('modTime',String(Date.now()));body.append('app',app);body.append('file',new Blob([JSON.stringify(value)],{type:'application/json'}),key);
        let sent=false;
        try{
            sent=true;const response=await call('/api/file/putFile',{method:'POST',body});
            if(!response.ok)throw new Error('思源未确认常用筛选保存');
            const result=response.value;if(result?.code!==0)throw new Error('思源未确认常用筛选保存');
            return {code:0};
        }catch(error){error.commitState=sent?'unknown':'none';throw error;}
    }
    return {load,save};
}
