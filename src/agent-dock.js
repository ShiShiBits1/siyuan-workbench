import {createPomodoroDockHost} from '../ui/pomodoro-dock-host.js';
import {mountAgentWorkspace} from '../ui/agent-workspace.js';
import {createNativeAgentClient} from './agent/native-agent-client.js';
import {createChatAttachmentPreparer} from './agent/chat-attachments.js';
import {createTaskAttachmentUploader} from './task-attachment-upload.js';

export const AGENT_DOCK_ICON = '<symbol id="iconWorkbenchAgent" viewBox="0 0 24 24"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m12 7 1.2 2.8L16 11l-2.8 1.2L12 15l-1.2-2.8L8 11l2.8-1.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></symbol>';

const styles = `.swb-agent-dock{height:100%;min-width:0;overflow:auto;box-sizing:border-box;padding:10px;color:var(--b3-theme-on-background)}
.swb-agent-dock__bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.swb-agent-dock__bar strong{font-size:13px}.swb-agent-dock__bar button,.swb-agent-dock__context button{font:inherit;color:inherit;border:1px solid var(--b3-border-color);border-radius:7px;background:var(--b3-theme-background);padding:5px 8px;cursor:pointer}
.swb-agent-dock__context{font-size:12px;overflow-wrap:anywhere;margin:8px 0}.swb-agent-dock__context p{margin:5px 0}.swb-agent-dock__context button:disabled{opacity:.5;cursor:default}
.swb-agent-dock .swa{padding:0;min-width:0}.swb-agent-dock .swa__head{gap:8px;align-items:flex-start}.swb-agent-dock .swa__head h2{display:none}.swb-agent-dock .swa__head button{flex:none;padding:5px 8px}
.swb-agent-dock .swa__templates{gap:5px;margin:10px 0}.swb-agent-dock .swa__templates button{padding:5px 7px}.swb-agent-dock .swa__hint{margin:8px 0}
.swb-agent-dock .swa__transcript{height:clamp(160px,43vh,500px);max-height:none;padding:10px}.swb-agent-dock .swa__composer{margin-top:10px;padding:8px}.swb-agent-dock .swa__composer textarea{font-size:13px}.swb-agent-dock .swa__approval{padding:9px}.swb-agent-dock .swa__attachment-hint{font-size:11px}`;

/** Native dock registration stays synchronous; the chat mounts after plugin readiness.
 * Hiding the dock preserves the session. Changing notebooks requires an explicit
 * new session, so refresh notifications cannot erase a draft or retarget a run.
 */
export function createAgentDock({
  register, ready=Promise.resolve(), getContext, post, runWrite,
  assertAvailable=()=>{}, onOpenAttachment, onBusyChange=()=>{},
  onRecordChange=()=>{}, onOpenWorkbench, onError=()=>{}, unregister,
  mountWorkspace=mountAgentWorkspace, clientFactory=createNativeAgentClient,
}={}) {
  if(typeof getContext!=='function'||typeof post!=='function'||typeof runWrite!=='function')throw new Error('Agent 侧栏参数无效');
  const views=new Set();
  const notifyBusy=(busy,token)=>{try{void Promise.resolve(onBusyChange(busy,token)).catch(()=>{});}catch{/* Host refresh failures do not affect native requests or cleanup. */}};
  const host=createPomodoroDockHost({register,ready,unregister,onError,mount(model){
    const element=model.element,doc=element.ownerDocument;
    const root=doc.createElement('section');root.className='swb-agent-dock';root.setAttribute('aria-label','Agent 助手侧栏');
    const style=doc.createElement('style');style.textContent=styles;root.append(style);
    const bar=doc.createElement('header');bar.className='swb-agent-dock__bar';
    const heading=doc.createElement('strong');heading.textContent='Agent 助手';bar.append(heading);
    const open=doc.createElement('button');open.type='button';open.textContent='在工作台打开';
    if(onOpenWorkbench){open.addEventListener('click',()=>{try{void Promise.resolve(onOpenWorkbench()).catch(error=>showError(error));}catch(error){showError(error);}});bar.append(open);}
    const notice=doc.createElement('div');notice.className='swb-agent-dock__context';notice.setAttribute('role','status');
    const message=doc.createElement('p'),switchButton=doc.createElement('button');switchButton.type='button';switchButton.textContent='结束当前会话并切换';notice.append(message,switchButton);
    const chat=doc.createElement('div');root.append(bar,notice,chat);element.replaceChildren(root);
    let disposed=false,controller=null,context=null,busy=false,token=null,loadFailure='';
    function showError(error){message.textContent=error?.message||'Agent 侧栏暂时无法加载，请重试。';notice.hidden=false;}
    function nextContext(){const value=getContext()||{};return {notebookId:value.notebookId||'',notebookName:value.notebookName||'当前笔记本'};}
    function refresh(){
      if(disposed)return;
      const next=nextContext();
      if(!context){start(next);return;}
      const changed=next.notebookId!==context.notebookId;
      if(!context.notebookId&&!next.notebookId){notice.hidden=false;switchButton.hidden=true;message.textContent='请先在插件设置中选择工作笔记本，再打开 Agent 助手。';return;}
      if(loadFailure&&!changed){notice.hidden=false;switchButton.hidden=false;switchButton.disabled=false;message.textContent=loadFailure;return;}
      notice.hidden=!changed;
      switchButton.hidden=!changed;
      switchButton.disabled=busy;
      if(changed)message.textContent=busy?'笔记本已切换，当前请求仍在处理，请完成或停止后切换会话。':'当前会话和草稿仍保留在原笔记本。点击下方按钮，在当前笔记本开始新会话。';
    }
    function release(){
      const previous=controller;controller=null;previous?.dispose?.();
      if(token)notifyBusy(false,token);
      token=null;busy=false;chat.replaceChildren();
    }
    function start(next){
      release();context=next;loadFailure='';notice.hidden=true;switchButton.hidden=true;
      if(!context.notebookId){message.textContent='请先在插件设置中选择工作笔记本，再打开 Agent 助手。';notice.hidden=false;return;}
      const current=context,runToken={};token=runToken;
      const assertCurrent=()=>{if(disposed||context!==current)throw new Error('此会话已经关闭');assertAvailable(current.notebookId);};
      try{
        const client=clientFactory({post});
        const upload=createTaskAttachmentUploader({post});
        const prepareAttachments=createChatAttachmentPreparer(files=>runWrite(current.notebookId,()=>{assertCurrent();return upload(files);}),assertCurrent);
        controller=mountWorkspace(chat,{
          notebookId:current.notebookId,notebookName:current.notebookName,
          chat:(input,options)=>{assertCurrent();return client.chat(input,options);},
          confirm:(id,approved)=>client.confirm(id,approved),
          answerQuestion:(id,answers)=>client.answerQuestion(id,answers),
          prepareAttachments,onOpenAttachment,
          onBusyChange(value){
            notifyBusy(value,runToken);
            if(disposed||token!==runToken)return;
            busy=value;refresh();
          },
          onRecordChange,
        });
      }catch(error){loadFailure=error?.message||'Agent 助手加载失败，请重试。';showError(error);switchButton.hidden=false;switchButton.textContent='重新加载助手';}
    }
    const switchContext=()=>{if(!disposed&&!busy){switchButton.textContent='结束当前会话并切换';start(nextContext());}};
    switchButton.addEventListener('click',switchContext);
    const view={refresh,dispose(){if(disposed)return;disposed=true;views.delete(view);release();switchButton.removeEventListener('click',switchContext);root.remove();}};
    views.add(view);refresh();return view;
  }});
  return {...host,refresh(){for(const view of views)view.refresh();}};
}
