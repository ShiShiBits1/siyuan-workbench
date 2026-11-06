import {createAgentMarkdownRenderer} from './agent-markdown.js';
import {appendAgentQuestion} from './agent-question.js';
const icons={
  attach:'<path d="M8 13.5l5.6-5.6a2.1 2.1 0 0 1 3 3l-7.1 7.1a3.5 3.5 0 0 1-5-5l8-8"/>',
  send:'<path d="M10 16V4M5 9l5-5 5 5"/>',
  stop:'<rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
};
const icon=name=>{
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
  return `<span class="swa__icon" aria-hidden="true" style="mask-image:url('data:image/svg+xml,${encodeURIComponent(svg)}')"></span>`;
};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const templates={today:'请查询当前工作台笔记本今天的任务，整理优先处理顺序和需要注意的截止时间。先只读梳理，不修改记录。',week:'请根据我提供的信息协助安排本周工作。先列出建议，确认后再按思源的审批设置执行创建或修改。\n\n本周目标：',meeting:'请从下面的会议记录提炼待办建议，列出标题、负责人线索与时间信息；不确定的信息标记待确认。先给出建议，不立即写入。\n\n会议记录（请自行粘贴）：'};
function toolTitle(name='') {
  if(name.includes('create_task'))return '创建任务';
  if(name.includes('create_event'))return '创建日程';
  if(name.includes('complete_task'))return '完成任务';
  if(name.includes('list_today'))return '查询今日任务';
  return name || 'Agent 操作';
}
function effectsLabel(effects={}) {
  const items=[];
  if(effects.localRead)items.push('读取本地数据');
  if(effects.localWrite)items.push('写入本地数据');
  if(effects.network || effects.dataEgress || effects.externalWrite)items.push('涉及外部数据操作');
  if(effects.externalCost)items.push('涉及外部费用');
  return items.length?items.join(' · '):'请核对操作内容后决定';
}

function chatFailureText(failure) {
  const reason = failure?.message || '思源未返回错误详情';
  if (/(^|[:：]\s*)ChatGPT connection failed[.!。]?$/i.test(reason)) {
    return '思源未能连接 ChatGPT。请在思源原生 Agent 中检查连接。原始原因：' + reason;
  }
  return reason;
}

/** UI delegates model configuration, SSE and decisions to the native client. */
export function mountAgentWorkspace(container,options={}) {
  let disposed=false,generation=0,active=null,sessionID=null;
  const doc=container.ownerDocument;
  const renderMarkdown=createAgentMarkdownRenderer(doc,{lute:options.lute??doc.defaultView?.Lute??globalThis.Lute});
  const notebookName=typeof options.notebookName==='string'&&options.notebookName.trim()?options.notebookName.trim():'未选择';
  container.innerHTML=`<section class="swa" aria-label="Agent 工作流"><header class="swa__head"><div><h2 data-workbench-page-intro>Agent 助手</h2><p>当前笔记本：<span>${escape(notebookName)}</span></p></div><button type="button" data-agent-action="new">新会话</button></header><p class="swa__hint">使用思源中配置的模型和已启用的能力，操作遵循思源审批设置。只有点击发送才调用模型；笔记或会议内容请自行粘贴。</p><nav class="swa__templates" aria-label="工作流模板"><button type="button" data-agent-template="today">今日梳理</button><button type="button" data-agent-template="week">本周安排</button><button type="button" data-agent-template="meeting">会议待办提炼</button></nav><div class="swa__transcript" role="log" aria-label="Agent 对话" aria-live="polite"><p class="swa__empty">选一个工作流，或直接描述需要完成的工作。</p></div><p class="swa__error" role="alert" hidden></p><form class="swa__composer" aria-label="发送给 Agent"><label><textarea name="message" aria-label="Agent 消息" rows="1" maxlength="30000" placeholder="描述工作，或粘贴要提炼的会议记录…"></textarea></label><footer><span class="swa__status" role="status">准备就绪</span><div><button type="submit" class="swa__primary" aria-label="发送" title="发送">${icon('send')}</button></div></footer></form></section>`;
  const root=container.querySelector('.swa'),log=root.querySelector('.swa__transcript'),input=root.querySelector('textarea'),form=root.querySelector('form');
  const error=root.querySelector('.swa__error'),status=root.querySelector('.swa__status'),send=form.querySelector('[type="submit"]');
  input.addEventListener('input',resizeInput);
  function resizeInput(){
    if(doc.defaultView?.CSS?.supports('field-sizing','content'))return;
    input.style.height='auto';
    if(input.scrollHeight)input.style.height=`${input.scrollHeight}px`;
  }
  let files=[];
  const previews=new Map(),url=doc.defaultView?.URL;
  let fileInput, fileList;
  if(typeof options.prepareAttachments==='function'){
    const attachments=doc.createElement('div');
    attachments.className='swa__attachments';
    attachments.innerHTML='<button type="button" data-agent-action="attach">添加附件</button><input type="file" multiple hidden><span class="swa__attachment-hint">支持图片和其他文件。发送时上传到思源资源，Agent 会收到文件引用。最多 5 个，每个 20 MB。</span><ul class="swa__files" aria-label="待发送附件" hidden></ul>';
    form.querySelector('footer').before(attachments);
    fileInput=attachments.querySelector('input');fileList=attachments.querySelector('ul');
    const attach=attachments.querySelector('button');
    attach.innerHTML=icon('attach');
    attach.setAttribute('aria-label','添加附件');
    attach.title='添加附件';
    form.querySelector('footer>div').prepend(attach);
    fileInput.addEventListener('change',selectFiles);
    input.addEventListener('paste',pasteImages);
  }
  form.querySelector('footer').before(error);
  let lastChatError = '';
  const showError=(message=lastChatError)=>{error.textContent=message;error.hidden=!message;};
  function selectFiles(){
    const selected=Array.from(fileInput.files||[]);
    fileInput.value='';
    addFiles(selected);
  }
  function pasteImages(event){
    const clipboard=event.clipboardData;
    if(!clipboard||clipboard.getData('text/plain'))return;
    const images=Array.from(clipboard.files||[]).filter(file=>file.type.startsWith('image/'));
    if(images.length){event.preventDefault();addFiles(images);}
  }
  function addFiles(selected){
    if(disposed||active||!selected.length)return;
    if(files.length+selected.length>5){showError('一次最多添加 5 个附件，请减少文件数量后重试。');return;}
    if(selected.some(file=>file.size>20*1024*1024)){showError('单个附件不能超过 20 MB，请缩小文件后重试。');return;}
    files.push(...selected);renderFiles();showError();
  }
  function renderFiles(){
    if(!fileList)return;
    form.toggleAttribute('data-workbench-draft',files.length>0);
    fileList.replaceChildren();
    for(const [file,preview] of previews)if(!files.includes(file)){url.revokeObjectURL(preview);previews.delete(file);}
    fileList.hidden=!files.length;
    files.forEach((file,index)=>{
      const row=doc.createElement('li'),name=doc.createElement('span'),remove=doc.createElement('button');
      if(file.type.startsWith('image/')&&typeof url?.createObjectURL==='function'){
        if(!previews.has(file))previews.set(file,url.createObjectURL(file));
        const preview=doc.createElement('img');preview.src=previews.get(file);preview.alt='';row.append(preview);
      }
      name.textContent=file.name;name.title=file.name;
      remove.type='button';remove.textContent='移除';remove.setAttribute('aria-label',`移除附件：${file.name}`);
      remove.disabled=Boolean(active);
      remove.addEventListener('click',()=>{
        if(disposed||active)return;
        files.splice(index,1);renderFiles();showError();
        (fileList.querySelectorAll('button')[index]||fileList.querySelector('button')||form.querySelector('[data-agent-action="attach"]'))?.focus();
      });
      row.append(name,remove);fileList.append(row);
    });
  }
  function notifyBusy(busy){try{void Promise.resolve(options.onBusyChange?.(busy)).catch(()=>{});}catch{/* Host UI callbacks cannot change the native operation result. */}}
  function controls(busy){input.disabled=busy;send.type=busy?'button':'submit';send.dataset.agentAction=busy?'stop':'send';send.innerHTML=icon(busy?'stop':'send');send.title=busy?'停止':'发送';send.setAttribute('aria-label',send.title);if(fileInput)fileInput.disabled=busy;root.querySelectorAll('[data-agent-template], [data-agent-message-action="quote"], [data-agent-action="attach"], .swa__attachments li button').forEach(button=>{button.disabled=busy;});notifyBusy(busy);}
  function renderSentFiles(node,attachments){
    if(!attachments.length)return;
    const list=doc.createElement('ul');list.className='swa__files';list.setAttribute('aria-label','已发送附件');
    const feedback=node.querySelector('.swa__message-feedback');
    for(const {name,path} of attachments){
      const row=doc.createElement('li');
      const link=doc.createElement(options.onOpenAttachment?'button':'span');link.textContent=name;
      if(options.onOpenAttachment){
        link.type='button';link.addEventListener('click',async()=>{
          try{await options.onOpenAttachment(path,name);}
          catch(failure){if(!disposed&&log.contains(node))feedback.textContent=failure?.message||'附件打开失败';}
        });
      }
      row.append(link);list.append(row);
    }
    feedback.before(list);
  }
  function entry(kind,text='') {
    log.querySelector('.swa__empty')?.remove();
    const node=doc.createElement('article');node.className=`swa__message swa__message--${kind}`;
    const speaker=kind==='user'?'你':kind==='assistant'?'Agent':'工具';
    const header=doc.createElement('header');header.className='swa__message-head';
    const label=doc.createElement('strong');label.textContent=speaker;header.append(label);
    const actions=doc.createElement('div');actions.className='swa__message-actions';
    for(const [action,title] of [['copy','复制'],['quote','引用']]){const button=doc.createElement('button');button.type='button';button.dataset.agentMessageAction=action;button.textContent=title;button.setAttribute('aria-label',`${title}${speaker}消息`);if(action==='quote')button.disabled=Boolean(active);actions.append(button);}
    header.append(actions);node.append(header);
    const body=doc.createElement('div');body.className='swa__message-body';node.append(body);
    const feedback=doc.createElement('span');feedback.className='swa__message-feedback';feedback.setAttribute('role','status');node.append(feedback);log.append(node);
    let raw='';
    const setText=value=>{raw=String(value??'');if(kind==='assistant')renderMarkdown(body,raw);else body.textContent=raw;};
    setText(text);
    for(const button of actions.querySelectorAll('button'))button.addEventListener('click',async()=>{
      if(disposed||!log.contains(node)||button.disabled)return;
      if(button.dataset.agentMessageAction==='quote'){
        if(active)return;
        const quote=`> ${speaker}：\n${raw.split(/\r?\n/).map(line=>`> ${line}`).join('\n')}`;
        input.value=input.value?`${input.value}\n\n${quote}\n\n`:`${quote}\n\n`;resizeInput();input.focus();feedback.textContent='已引用到输入框';return;
      }
      button.disabled=true;feedback.textContent='';
      try {
        const clipboard=doc.defaultView?.navigator?.clipboard??globalThis.navigator?.clipboard;
        if(options.copyText)await options.copyText(raw);
        else if(clipboard?.writeText)await clipboard.writeText(raw);
        else throw new Error('当前环境不支持剪贴板写入');
        if(!disposed&&log.contains(node))feedback.textContent='已复制';
      }catch(failure){if(!disposed&&log.contains(node))feedback.textContent=`复制失败：${failure?.message||'请手动选择文本复制'}`;}
      finally{if(!disposed&&log.contains(node))button.disabled=false;}
    });
    return {node,body,setText,append:value=>setText(raw+String(value??''))};
  }
  function cancelPending(run) {
    for (const card of run.questions.values()) card.close();
    for(const card of run?.approvals.values()||[]) {
      if(card.decided||card.pending)continue;
      card.decided=true;card.buttons.forEach(button=>{button.disabled=true;});card.note.textContent='本次请求已取消';
      // Closing/stopping never grants approval. Only reject this run's own pending IDs.
      try {void Promise.resolve(options.confirm(card.id,false)).catch(()=>{});} catch {/* Best effort rejection must not prevent abort/cleanup. */}
    }
  }
  function stopRun() {
    const run=active;if(!run)return;
    ++generation;active=null;cancelPending(run);run.controller.abort();
    if(!disposed){controls(false);status.textContent=run.uploading?'已停止上传。已上传的文件可能保留在思源资源中。':'已停止本次请求；已经执行的操作会保留。';}
  }
  function approval(run,data) {
    if(typeof data.confirmID!=='string'||!data.confirmID)throw new Error('原生审批缺少标识，已停止本次请求');
    if(run.approvals.has(data.confirmID))return;
    const node=doc.createElement('article');node.className='swa__approval';
    node.innerHTML=`<h3>等待决定：${escape(toolTitle(data.name))}</h3><p>${escape(effectsLabel(data.effects))}</p><pre>${escape(JSON.stringify(data.arguments??{},null,2))}</pre><div><button type="button" class="swa__primary" data-agent-decision="approve">批准本次</button><button type="button" data-agent-decision="reject">拒绝</button></div><p class="swa__decision-status" role="status">尚未执行此项操作</p>`;
    const card={id:data.confirmID,node,note:node.querySelector('.swa__decision-status'),buttons:[...node.querySelectorAll('button')],pending:false,decided:false};
    run.approvals.set(card.id,card);log.append(node);status.textContent='等待你批准或拒绝';
    for(const button of card.buttons)button.addEventListener('click',async()=>{
      if(disposed||active!==run||card.pending||card.decided)return;
      card.pending=true;card.buttons.forEach(item=>{item.disabled=true;});card.note.textContent='正在提交决定…';
      try {
        await options.confirm(card.id,button.dataset.agentDecision==='approve');
        if(disposed||run.request!==generation)return;
        card.decided=true;card.note.textContent=button.dataset.agentDecision==='approve'?'已批准本次，操作结果请见工具回复':'已拒绝本次';if(active===run)status.textContent='Agent 正在继续…';
      }catch(failure){if(!disposed&&run.request===generation)card.note.textContent=`决定提交失败：${failure?.message||'请重试'}。可重新提交。`;}
      finally{card.pending=false;if(!disposed&&active===run&&!card.decided)card.buttons.forEach(item=>{item.disabled=false;});}
    });
  }
  async function submit(event) {
    event.preventDefault();if(disposed||active)return;
    const text=input.value.trim();if(!text&&!files.length){input.focus();return;}
    const message=text||'请查看我上传的附件。';
    if(typeof options.chat!=='function'){showError('Agent 尚未连接。请检查思源 AI 配置。');return;}
    const run={controller:new AbortController(),approvals:new Map(),questions:new Map(),tools:new Map(),request:++generation,assistant:null,failure:null};active=run;
    lastChatError='';
    showError();controls(true);
    const current=()=>!disposed&&active===run&&run.request===generation;
    try {
      let prepared;
      if(files.length){
        run.uploading=true;
        status.textContent='正在上传附件…';
        try{prepared=await options.prepareAttachments([...files],{signal:run.controller.signal});}
        catch(failure){
          if(current()){showError(`附件上传失败：${failure?.message||'思源未确认上传结果'}`);status.textContent='消息和附件已保留';}
          return;
        }
        if(!current())return;
        run.uploading=false;
      }
      const user=entry('user',message);
      renderSentFiles(user.node,prepared?.attachments||[]);
      status.textContent='正在连接思源 Agent…';
      const result=await options.chat({message:message+(prepared?.messageSuffix||''),...(sessionID?{sessionID}:{})},{signal:run.controller.signal,onEvent:({event:kind,data={}})=>{
        if(!current())return;
        if(kind==='content') {run.assistant ||= entry('assistant');run.assistant.append(data.token||'');status.textContent='正在回复…';}
        else if(kind==='session'&&typeof data.sessionID==='string')sessionID=data.sessionID;
        else if(kind==='confirm')approval(run,data);
        else if(kind==='question'){
          if (run.questions.has(data.questionID)) return;
          const question = appendAgentQuestion(log, data, {
            answerQuestion: options.answerQuestion,
            isCurrent: current,
            ownsTurn: () => !disposed && generation === run.request,
            onAnswered: () => { status.textContent = '回答已提交，等待 Agent 继续…'; },
          });
          run.questions.set(data.questionID, question);
          run.assistant = null;
          status.textContent = '请在对话中回答 Agent 的问题';
        }
        else if(kind==='tool_call'){const row=entry('tool',`${toolTitle(data.name)}：执行中`);run.tools.set(data.callID,row);status.textContent='正在调用工具…';}
        else if(kind==='tool_result'){
          const row=run.tools.get(data.callID)||entry('tool');row.setText(`${toolTitle(data.name)}\n${data.result??''}`);
          try{void Promise.resolve(options.onRecordChange?.()).catch(()=>{});}catch{/* A refresh callback must not alter the native operation result. */}
        }
        else if(kind==='error'||kind==='interrupted'){run.failure=new Error(data.message||'原生 Agent 请求中断');showError(run.failure.message);}
      }});
      if(!current())return;
      if(run.failure)throw run.failure;
      if(typeof result?.sessionID==='string')sessionID=result.sessionID;
      input.value='';resizeInput();files=[];renderFiles();status.textContent='本次回复结束';
    }catch(failure){
      if(!current())return;
      if(typeof failure?.sessionID==='string')sessionID=failure.sessionID;
      lastChatError = chatFailureText(failure);
      if (run.tools.size || run.approvals.size) lastChatError += '\n再次发送前，请核对本轮工具操作的结果。';
      showError(lastChatError);
      status.textContent = '草稿已保留';
    }finally{
      if(current()){cancelPending(run);active=null;controls(false);}
    }
  }
  function click(event) {
    const button=event.target.closest('button');if(!button||!root.contains(button)||button.disabled||disposed)return;
    if(button.dataset.agentTemplate){input.value=templates[button.dataset.agentTemplate];resizeInput();input.focus();showError();return;}
    if(button.dataset.agentAction==='attach'){fileInput?.click();return;}
    if(button.dataset.agentAction==='stop'){stopRun();return;}
    if(button.dataset.agentAction==='new'){
      stopRun();sessionID=null;++generation;log.innerHTML='<p class="swa__empty">新会话已准备好，输入消息开始。</p>';input.value='';resizeInput();files=[];renderFiles();lastChatError='';showError();status.textContent='准备就绪';input.focus();
    }
  }
  root.addEventListener('click',click);form.addEventListener('submit',submit);
  return {dispose(){if(disposed)return;const hadRun=Boolean(active);stopRun();if(!hadRun)notifyBusy(false);disposed=true;++generation;files=[];renderFiles();fileInput?.removeEventListener('change',selectFiles);input.removeEventListener('paste',pasteImages);input.removeEventListener('input',resizeInput);root.removeEventListener('click',click);form.removeEventListener('submit',submit);}};
}
