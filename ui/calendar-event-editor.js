import {mountCategoryPicker} from './category-picker.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localInput=value=>{if(!value)return '';const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
function iso(value,label,required=false){
  if(!value){if(required)throw new Error(`${label}不能为空`);return null;}
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error(`${label}无效`);
  const date=new Date(value);if(!Number.isFinite(date.getTime())||localInput(date)!==value)throw new Error(`${label}无效或处于不存在的本地时间`);return date.toISOString();
}
/** Stable inline form; persistence callbacks own IDs and document writes. */
export function mountCalendarEventEditor(host,{record,date,createEvent,updateEvent,deleteEvent,onOpenRecord,reconcile,verifyEventCategory,listCategories,onSaved,onDeleted,onClose}){
  let disposed=false,busy=false,locked=false,categoryPending=false,operation='',verified=null,draft=record?{...record}:{kind:'event'},confirmation=false;
  const existing=Boolean(record?.id),expectedUpdatedAt=record?.updatedAt;
  const field=(label,name,type,value)=>`<label>${label}<input name="${name}" type="${type}" value="${escape(value)}"></label>`;
  host.innerHTML=`<form class="swcal__event-form" aria-label="日程编辑"><header><h2>${existing?'编辑':'新增'}日程</h2>${existing?'<button type="button" data-event-action="open">打开原文 ↗</button>':''}</header><div class="swcal__fields">${field('标题','title','text',record?.title||'')}${field('分类','category','text',record?.category||'')}${field('开始时间','startAt','datetime-local',existing?localInput(record.startAt):date+'T09:00')}${field('结束时间','endAt','datetime-local',existing?localInput(record.endAt):date+'T10:00')}${field('提醒时间','reminderAt','datetime-local',localInput(record?.reminderAt))}<label class="swcal__detail">详细内容<textarea name="detail" rows="4">${escape(record?.detail||'')}</textarea></label></div><p class="swcal__event-error" role="alert" hidden></p><section class="swcal__delete-confirm" hidden><strong></strong><p>将删除这条日程及其文档正文，附件文件保留。请确认无需保留。</p><button type="button" data-event-action="cancel-delete">保留日程</button><button type="button" class="swcal__danger" data-event-action="confirm-delete">确认删除</button></section><footer>${existing&&deleteEvent?'<button type="button" class="swcal__danger" data-event-action="delete">删除日程</button>':''}<button type="button" data-event-action="cancel">取消</button><button type="button" data-event-action="reconcile" hidden>核查保存结果</button><button type="button" data-event-action="load-current" hidden>加载当前日程（放弃草稿）</button><button type="submit" ${existing?!updateEvent?'disabled':'':!createEvent?'disabled':''}>保存日程</button></footer></form>`;
  const form=host.querySelector('form'),error=form.querySelector('[role="alert"]'),confirm=form.querySelector('.swcal__delete-confirm');
  if (listCategories) mountCategoryPicker(form.querySelector('[name="category"]'), () => listCategories('event'));
  const categoryNotice='分类归档仍待核查，可在插件设置中使用“按分类整理已有任务与日程”恢复目录位置。';
  const showError=message=>{error.textContent=message;error.hidden=!message;};
  function controls(){if(disposed)return;form.setAttribute('aria-busy',String(busy));for(const node of form.querySelectorAll('input,textarea,button'))node.disabled=busy||locked;form.querySelector('[data-event-action="reconcile"]').hidden=!locked;form.querySelector('[data-event-action="reconcile"]').disabled=busy;const load=form.querySelector('[data-event-action="load-current"]');load.hidden=!verified;load.disabled=busy;load.textContent=categoryPending?'加载当前日程（放弃草稿，归档待整理）':'加载当前日程（放弃草稿）';if(locked&&!busy)form.querySelector('[data-event-action="open"]')?.removeAttribute('disabled');if(!locked&&!busy)form.querySelector('[type="submit"]').disabled=existing?!updateEvent:!createEvent;form.querySelector('[type="submit"]').textContent=busy?'正在处理…':'保存日程';}
  function failure(reason){categoryPending ||= reason?.categoryPending===true||reason?.data?.categoryPending===true||(reason?.stage??reason?.data?.stage)==='category-move';const commit=reason?.commitState??reason?.data?.commitState;locked=categoryPending||(busy&&commit!=='none')||commit==='unknown'||commit==='committed'||reason?.unconfirmed===true;
    if(locked){draft.id ||= reason?.documentID;showError(`${commit==='committed'?'日程已提交，但同步或校验未完成':'操作结果未确认'}：${reason?.message||'请核查'}。已保留输入并暂停写入，请核查结果后重新确认，不会自动重放操作。${categoryPending?categoryNotice:''}`);}
    else showError(`操作失败：${reason?.message||'请重试'}`);
  }
  async function save(event){event.preventDefault();if(disposed||busy||locked||confirmation)return;
    try{
      const value=name=>form.querySelector(`[name="${name}"]`).value;
      const timestamp=(name,label)=>existing&&value(name)===localInput(record[name])?(record[name]?new Date(record[name]).toISOString():null):iso(value(name),label);
      const title=value('title').trim();if(!title)throw new Error('请填写日程标题');
      const patch={title,category:value('category').trim()||null,startAt:timestamp('startAt','开始时间'),endAt:timestamp('endAt','结束时间'),reminderAt:timestamp('reminderAt','提醒时间'),detail:value('detail')};
      if(patch.startAt&&patch.endAt&&Date.parse(patch.endAt)<Date.parse(patch.startAt))throw new Error('结束时间不能早于开始时间');
      if(existing?!updateEvent:!createEvent)throw new Error('日程保存尚未配置');
      Object.assign(draft,patch);busy=true;operation=existing?'update':'create';showError('');controls();
      const result=existing?await updateEvent(record.id,patch,{expectedUpdatedAt}):await createEvent(draft);
      if(disposed)return;if(!result?.id||result.kind!=='event'||typeof result.title!=='string'||(existing&&result.id!==record.id)||(!existing&&draft.id&&result.id!==draft.id)||!['category','startAt','endAt','reminderAt','detail'].every(name=>Object.hasOwn(result,name)))throw Object.assign(new Error('未收到完整日程保存回执'),{unconfirmed:true});
      onSaved(result);
    }catch(reason){if(!disposed)failure(reason);}finally{busy=false;controls();}
  }
  async function click(event){const button=event.target.closest('[data-event-action]');if(!button||button.disabled||disposed)return;const action=button.dataset.eventAction;
    if(action==='open'){try{if(!onOpenRecord)throw new Error('原生文档打开尚未配置');await onOpenRecord(record.id);}catch(reason){if(!disposed)showError(`打开失败：${reason?.message||'请重试'}`);}return;}
    try{
      if(busy)return;
      if(action==='reconcile'){
        verified=null;busy=true;controls();const list=await reconcile();if(disposed)return;
        const found=list.find(event=>event.id===(draft.id||record?.id));
        if(operation==='delete'&&!found){onDeleted(record.id);return;}
        if(!found)throw new Error('尚未找到可确认的日程，输入继续保留。请在思源中核查后再次刷新，勿重复创建。');
        const keys=['title','category','detail','startAt','endAt','reminderAt'];
        const matches=operation!=='delete'&&keys.every(name=>name.endsWith('At')?(found[name]&&draft[name]?Date.parse(found[name])===Date.parse(draft[name]):!found[name]&&!draft[name]):(found[name]??'')===(draft[name]??''));
        if(matches){
          if(categoryPending){
            verified=found;
            if(typeof verifyEventCategory!=='function')throw new Error(`尚未配置分类目录核查。${categoryNotice}`);
            const categoryVerified=await verifyEventCategory(found);if(disposed)return;
            if(categoryVerified===false)throw new Error(`分类目录尚未匹配。${categoryNotice}`);
            categoryPending=false;
          }
          onSaved(found);return;
        }
        verified=found;showError(operation==='delete'?'当前仍能读到这条日程，删除结果未确认。原输入继续保留；需要重新操作时，请明确加载当前日程后重新确认。':'核查发现当前日程与提交内容不同，原输入继续保留。可继续核查，或明确加载当前日程并放弃此草稿。'+(categoryPending?categoryNotice:''));return;
      }
      if(action==='load-current'&&verified){onSaved(verified,{reopen:true,categoryPending});return;}
      if(locked)return;
      if(action==='cancel'){onClose();return;}
      if(action==='delete'){confirmation=true;confirm.hidden=false;confirm.querySelector('strong').textContent=`确认删除：${record.title}`;return;}
      if(action==='cancel-delete'){confirmation=false;confirm.hidden=true;return;}
      if(action==='confirm-delete'){
        busy=true;operation='delete';showError('');controls();const result=await deleteEvent(record.id,{expectedUpdatedAt});if(disposed)return;
        if(result?.id!==record.id||result.deleted!==true)throw Object.assign(new Error('未确认日程已删除'),{unconfirmed:true});onDeleted(record.id);
      }
    }catch(reason){if(!disposed){if(action==='reconcile')showError(`核查失败：${reason?.message||'请重试'}${categoryPending?' '+categoryNotice:''}`);else if(action==='open')showError(`打开失败：${reason?.message||'请重试'}`);else failure(reason);}}
    finally{busy=false;controls();}
  }
  form.addEventListener('submit',save);form.addEventListener('click',click);form.querySelector('[name="title"]').focus();
  return {get busy(){return busy;},dispose(){disposed=true;form.removeEventListener('submit',save);form.removeEventListener('click',click);}};
}
