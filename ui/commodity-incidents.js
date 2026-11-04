import {newNodeID} from '../src/data/node-id.js';
import {incidentStatuses} from '../src/data/commodity-incidents.js';

const escape = value => String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const day = date => [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
const fields = [
    ['title','事件标题','text',true], ['style','款号','text',true], ['supplier','供应商'], ['supplierStyle','供应商款号'],
    ['productID','商品 ID'], ['skus','受影响 SKU'], ['noticedOn','发现日期','date',true],
    ['dueOn','处理期限','date'], ['restoredOn','恢复日期','date'], ['reason','平台通知原因','textarea'],
    ['nextStep','下一步','textarea'],
];
const closed = record => ['restored','closed'].includes(record.status);

export function mountCommodityIncidents(host,{repository,onOpenRecord,onCreateTask}) {
    host.innerHTML=`<section class="swci" aria-label="商品异常台账">
        <header><div data-workbench-page-intro><h2>商品异常台账</h2><p>按次记录禁售与整改，凭证、时间线和处理结果保存在事件原文。</p></div>
        <button type="button" data-ci="add">登记事件</button></header>
        <div class="swci__tools"><label>查找记录 <input type="search" placeholder="款号、供应商、商品 ID 或标题"></label>
        <label>查看范围 <select><option value="open">处理中</option><option value="due">临近截止</option><option value="all">全部历史</option></select></label>
        <button type="button" data-ci="refresh">刷新</button></div>
        <p role="alert" hidden></p><div class="swci__editor"></div>
        <div class="swci__results" aria-live="polite"></div></section>`;
    const root=host.firstElementChild;
    const editor=root.querySelector('.swci__editor'), results=root.querySelector('.swci__results');
    const search=root.querySelector('input'), scope=root.querySelector('select'), alert=root.querySelector('[role="alert"]');
    let records=[], loading=false, saving=false, disposed=false, readGeneration=0;
    const showError=error=>{alert.textContent=error?.message||'';alert.hidden=!error;};

    function render() {
        const query=search.value.trim().toLocaleLowerCase();
        const upcoming=new Date();upcoming.setDate(upcoming.getDate()+7);
        const deadline=day(upcoming);
        const visible=records.filter(record=>
            (scope.value==='all'||!closed(record)) &&
            (scope.value!=='due'||(record.dueOn&&record.dueOn<=deadline)) &&
            (!query||[record.style,record.productID,record.title,record.supplier,record.supplierStyle,record.shop,record.platform,record.skus].some(value=>String(value??'').toLocaleLowerCase().includes(query))));
        if (loading) {results.textContent='正在读取台账…';return;}
        if (!visible.length) {results.textContent='当前没有符合条件的记录。';return;}
        results.innerHTML=`<table><thead><tr><th scope="col">事件与款号</th><th scope="col">状态</th><th scope="col">发现日期</th><th scope="col">处理期限</th><th scope="col">下一步</th><th scope="col">操作</th></tr></thead>
            <tbody>${visible.map(record=>`<tr data-record-id="${escape(record.id)}"><td><strong>${escape(record.title)}</strong><small>${escape([record.style,record.supplier,record.supplierStyle].filter(Boolean).join(' · '))}</small>
            ${record.platform||record.shop?`<small>${escape([record.platform&&'历史平台 '+record.platform,record.shop&&'历史店铺 '+record.shop].filter(Boolean).join(' · '))}</small>`:''}</td>
            <td>${escape(incidentStatuses[record.status])}</td><td>${escape(record.noticedOn)}</td><td>${escape(record.dueOn||'—')}</td><td>${escape(record.nextStep||'—')}</td>
            <td class="swci__actions"><button type="button" data-ci="edit">编辑</button><button type="button" data-ci="open">打开原文</button>
            ${onCreateTask&&!closed(record)?'<button type="button" data-ci="task">创建跟进任务</button>':''}</td></tr>`).join('')}</tbody></table>`;
    }

    async function refresh() {
        const generation=++readGeneration; loading=true;render();
        try {
            const loaded=await repository.list();
            if (disposed||generation!==readGeneration) return;
            records=loaded;showError();
        } catch (error) {if (!disposed&&generation===readGeneration) showError(error);}
        finally {if (!disposed&&generation===readGeneration){loading=false;render();}}
    }

    function edit(record) {
        if (editor.firstElementChild) {editor.querySelector('input').focus();return;}
        const id=record?.id||newNodeID();
        const current=record||{status:'verify',noticedOn:day(new Date())};
        editor.innerHTML=`<form class="swci__form" data-workbench-draft><h3>${record?'编辑事件':'登记事件'}</h3>
            <div class="swci__fields">${fields.map(([name,label,type='text',required])=>`<label>${label}
                ${type==='textarea'? `<textarea name="${name}" maxlength="2000">${escape(current[name])}</textarea>` :
                `<input type="${type}" name="${name}" maxlength="2000" value="${escape(current[name])}" ${required?'required':''}>`}</label>`).join('')}
            <label>状态<select name="status">${Object.entries(incidentStatuses).map(([value,label])=>`<option value="${value}" ${current.status===value?'selected':''}>${label}</option>`).join('')}</select></label></div>
            <footer><button type="button" data-ci="cancel">取消</button><button type="submit">保存登记</button></footer></form>`;
        const form=editor.firstElementChild;
        form.querySelector('input').focus();
        form.addEventListener('submit',async event=>{
            event.preventDefault();
            if (saving||disposed) return;
            const input=Object.fromEntries([...fields.map(([name])=>name),'status'].map(name=>[name,form.querySelector(`[name="${name}"]`).value]));
            const controls=[...form.querySelectorAll('input,textarea,select,button')];
            saving=true;controls.forEach(control=>{control.disabled=true;});showError();
            try {
                const saved=await repository.save(id,input,record?.updatedAt);
                if (disposed) return;
                ++readGeneration;loading=false;
                records=[saved,...records.filter(item=>item.id!==id)];
                if (closed(saved)) scope.value='all';
                editor.replaceChildren();render();root.querySelector('[data-ci="add"]').focus();
            } catch(error) {if(!disposed)showError(error);}
            finally {saving=false;controls.forEach(control=>{control.disabled=false;});}
        });
    }

    root.addEventListener('click',async event=>{
        const button=event.target.closest('button[data-ci]');
        if (!button||disposed||saving) return;
        const action=button.dataset.ci;
        if (action==='add') {edit();return;}
        if (action==='cancel') {editor.replaceChildren();showError();root.querySelector('[data-ci="add"]').focus();return;}
        if (action==='refresh') {await refresh();return;}
        const record=records.find(item=>item.id===button.closest('tr')?.dataset.recordId);
        if (!record) return;
        try {
            if (action==='edit') edit(record);
            if (action==='open') {await repository.verify(record.id,`/${repository.parentID}/${record.id}.sy`);if(!disposed) await onOpenRecord(record.id);}
            if (action==='task') onCreateTask({title:record.nextStep||`跟进商品异常：${record.style}`,category:'商品异常',
                detail:`${record.title}\n\n[商品异常原文](siyuan://blocks/${record.id})`,
                ...(record.dueOn?{endAt:new Date(record.dueOn+'T23:59:00').toISOString()}:{})});
        } catch (error) {if(!disposed)showError(error);}
    });
    search.addEventListener('input',render);scope.addEventListener('change',render);
    void refresh();
    return {refresh,dispose(){disposed=true;host.replaceChildren();}};
}
