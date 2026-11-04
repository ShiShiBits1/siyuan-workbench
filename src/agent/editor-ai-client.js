import {isValidNodeID} from '../data/node-id.js';
const check=signal=>{if(signal?.aborted)throw new DOMException('已停止生成','AbortError');};
/** Official 3.8.9 /api/ai/editor/chat, kernel/api/ai.go and kernel/model/ai.go.
 * Uses the native editing model. No block IDs, history, tools or provider overrides.
 */
export function createEditorAIClient({fetcher=globalThis.fetch}={}) {
  return {async generate({taskID,input},{signal,onToken=()=>{}}={}) {
    if(!isValidNodeID(taskID)||typeof input!=='string'||!input.trim()||input.length>240000)throw new Error('委托输入无效或材料超出240000字');
    check(signal);let reader;const cancel=()=>{void reader?.cancel().catch(()=>{});};
    try{
      const response=await fetcher('/api/ai/editor/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({taskID,ids:[],input,action:'',history:[]}),signal});
      check(signal);
      if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream')){
        let message='请在思源设置中配置编辑器AI模型';try{message=(await response.json()).msg||message;}catch{}
        throw new Error('委托生成失败：'+message);
      }
      reader=response.body?.getReader();if(!reader)throw new Error('模型响应流不可读取');
      signal?.addEventListener('abort',cancel,{once:true});
      const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',event='message',data=[],output='',done=false;
      const dispatch=async()=>{if(!data.length){event='message';return;}let value;try{value=JSON.parse(data.join('\n'));}catch{throw new Error('模型事件格式无效');}const name=event;event='message';data=[];
        if(name==='error'||name==='truncated')throw new Error(value.message||'模型输出中断或过长');
        if(name==='content'){if(typeof value.token!=='string')throw new Error('模型内容事件无效');output+=value.token;if(output.length>120000)throw new Error('模型输出超出限制');await onToken(value.token);check(signal);}
        if(name==='done'){if(value.finishReason!=='stop')throw new Error('模型未正常完成：'+value.finishReason);done=true;}
      };
      const line=async text=>{if(!text)return dispatch();if(text.startsWith(':'))return;const i=text.indexOf(':');const key=i<0?text:text.slice(0,i);let value=i<0?'':text.slice(i+1);if(value.startsWith(' '))value=value.slice(1);if(key==='event')event=value;else if(key==='data')data.push(value);};
      const drain=async final=>{for(;;){const i=buffer.search(/[\r\n]/);if(i<0)break;if(buffer[i]==='\r'&&i===buffer.length-1&&!final)break;const count=buffer[i]==='\r'&&buffer[i+1]==='\n'?2:1;const text=buffer.slice(0,i);buffer=buffer.slice(i+count);await line(text);}};
      while(!done){check(signal);const chunk=await reader.read();check(signal);if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>240000)throw new Error('模型事件过长');await drain(false);}
      buffer+=decoder.decode();await drain(true);check(signal);if(!done)throw new Error('模型连接提前结束，成果未保存');return output;
    }finally{signal?.removeEventListener('abort',cancel);try{await reader?.cancel();}catch{}reader?.releaseLock();}
  }};
}
