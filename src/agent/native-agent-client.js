import {fetchSyncPost} from 'siyuan';
import {isValidNodeID,newNodeID} from '../data/node-id.js';

const defaultPost=(path,body)=>fetchSyncPost(path,body,undefined,false);
const aborted=signal=>{if(signal?.aborted)throw signal.reason?.name==='AbortError'?signal.reason:new DOMException('已停止生成','AbortError');};

/** Native 3.8.9 contract: save user entry first, then stream that revision.
 * Sources: siyuan/v3.8.9/kernel/api/agent.go and kernel/agent/{runtime,session}.go.
 * getSession overlays recoverable runtime but does not commit it. Commit that turn
 * separately before appending a new user entry; never rebuild model entries locally.
 */
export function createNativeAgentClient({fetcher=globalThis.fetch,post=defaultPost}={}) {
  let busy=false;
  const pending=new Set(),confirming=new Set();
  async function api(path,body){
    const response=await post(path,body);
    if(!response||response.code!==0){const error=new Error(response?.msg||'思源 Agent 接口调用失败');error.code=response?.code;throw error;}
    return response.data;
  }
  function checkSession(session,id){
    if(session?.id!==id||!Array.isArray(session.entries)||!Number.isInteger(session.revision))throw new Error('Agent 会话响应无效');
    if(session.agentRunning)throw new Error('原生会话仍在完成，请稍后重试');
  }
  function writableSession(session){
    const result={...session};
    for(const key of ['commitTurnID','recoveryTurnID','recoveryState','recoveryRevision','agentRunning','expectedRevision'])delete result[key];
    return result;
  }
  return {
    async chat(input,{onEvent=()=>{},signal}={}) {
      if(!input||typeof input.message!=='string'||!input.message.trim()||input.message.length>100000)throw new Error('请输入有效消息（最多 100000 字符）');
      if(input.sessionID && !isValidNodeID(input.sessionID))throw new Error('Agent 会话 ID 无效');
      if(busy)throw new Error('当前对话仍在进行，请先停止或等待完成');
      aborted(signal);busy=true;
      let sessionID=input.sessionID||newNodeID(),reader,abortReader,completed=false,turnID='';
      pending.clear();
      try{
        let session;
        if(input.sessionID){
          session=await api('/api/ai/agent/getSession',{id:sessionID});aborted(signal);
          checkSession(session,sessionID);
          if(session.recoveryTurnID){
            // Runtime revision is not the stored-session CAS revision. The native
            // commit replaces the old turn tail, so a new user must not be included.
            if(typeof session.recoveryTurnID!=='string')throw new Error('Agent 恢复标识无效');
            const committed=await api('/api/ai/agent/saveSession',{...writableSession(session),commitTurnID:session.recoveryTurnID,expectedRevision:session.revision});
            aborted(signal);
            if(!Number.isInteger(committed?.revision)||committed.revision<session.revision)throw new Error('Agent 没有确认上一轮已提交');
            session=await api('/api/ai/agent/getSession',{id:sessionID});aborted(signal);
            checkSession(session,sessionID);
            if(session.recoveryTurnID)throw new Error('上一轮 Agent 恢复尚未完成，请稍后核查');
          }
        }else session={id:sessionID,title:'工作台 Agent',createdAt:Date.now(),entries:[],revision:0};
        const userEntryID=newNodeID();
        const entry={id:userEntryID,type:'user',content:input.message,timestamp:Date.now()};
        const saved=await api('/api/ai/agent/saveSession',{...writableSession(session),entries:[...session.entries,entry],updatedAt:Date.now(),expectedRevision:session.revision});
        aborted(signal);
        if(!Number.isInteger(saved?.revision)||saved.revision<=session.revision)throw new Error('Agent 没有确认会话已保存');
        // Adapter metadata: let a stopped first turn keep its real native session.
        await onEvent({event:'session',data:{sessionID}});aborted(signal);
        const response=await fetcher('/api/ai/agent/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'text/event-stream'},body:JSON.stringify({message:input.message,sessionID,userEntryID,contentRevision:saved.revision,language:'zh-CN'}),signal});
        aborted(signal);
        if(!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')){
          let message='请检查思源 AI 模型配置';
          try{const body=await response.json();message=body?.msg||body?.message||message;}catch{ /* Do not dump HTML authentication pages or response bodies. */ }
          throw new Error(`原生 Agent 请求失败：${message}`);
        }
        if(!response.body?.getReader)throw new Error('Agent 返回的流不可读取');
        reader=response.body.getReader();
        abortReader=()=>{void reader.cancel().catch(()=>{});};
        signal?.addEventListener('abort',abortReader,{once:true});
        const decoder=new TextDecoder('utf-8',{fatal:true});
        let buffer='',event='message',data=[];
        const dispatch=async()=>{
          if(!data.length){event='message';return;}
          let payload;try{payload=JSON.parse(data.join('\n'));}catch{throw new Error('Agent 事件数据不是有效 JSON');}
          const name=event;event='message';data=[];
          if(name==='confirm'){
            if(typeof payload?.confirmID!=='string'||!payload.confirmID)throw new Error('Agent 审批事件缺少标识');
            pending.add(payload.confirmID);
          }
          if(name==='turn'||name==='done')turnID=payload?.turnID||turnID;
          await onEvent({event:name,data:payload});aborted(signal);
          if(name==='error'||name==='interrupted')throw new Error(payload?.message||'原生 Agent 对话中断');
          if(name==='done')completed=true;
        };
        const line=async value=>{
          if(!value){await dispatch();return;}
          if(value.startsWith(':'))return;
          const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon);
          let content=colon<0?'':value.slice(colon+1);if(content.startsWith(' '))content=content.slice(1);
          if(field==='event')event=content;else if(field==='data')data.push(content);
        };
        const drain=async(final=false)=>{
          for(;;){
            const index=buffer.search(/[\r\n]/);if(index<0)break;
            if(buffer[index]==='\r'&&index===buffer.length-1&&!final)break;
            const consume=buffer[index]==='\r'&&buffer[index+1]==='\n'?2:1;
            const value=buffer.slice(0,index);buffer=buffer.slice(index+consume);await line(value);
          }
        };
        for(;;){
          aborted(signal);const chunk=await reader.read();aborted(signal);
          if(chunk.done)break;
          buffer+=decoder.decode(chunk.value,{stream:true});
          if(buffer.length>2_000_000)throw new Error('Agent 单条事件过大');
          await drain();
        }
        buffer+=decoder.decode();await drain(true);
        if(!completed)throw new Error('Agent 连接提前结束，未收到完成确认；请核查已执行的操作');
        return {sessionID,turnID};
      }catch(failure){
        const error=signal?.aborted?new DOMException('已停止生成','AbortError'):failure instanceof Error?failure:new Error(String(failure));
        error.sessionID=sessionID;throw error;
      }finally{
        busy=false;pending.clear();confirming.clear();
        if(abortReader)signal?.removeEventListener('abort',abortReader);
        try{await reader?.cancel();}catch{ /* Preserve the original error/abort. */ }
        reader?.releaseLock();
      }
    },
    async confirm(confirmID,approved){
      if(typeof approved!=='boolean'||!pending.has(confirmID))throw new Error('该审批已失效或不属于当前对话');
      if(confirming.has(confirmID))throw new Error('审批正在提交');
      confirming.add(confirmID);
      try{await api('/api/ai/agent/confirm',{confirmID,approved,always:false});pending.delete(confirmID);}
      finally{confirming.delete(confirmID);}
    },
  };
}
