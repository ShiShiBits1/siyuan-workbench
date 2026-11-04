import {isValidNodeID,stableNodeID} from './node-id.js';

export const incidentStatuses = Object.freeze({
    verify:'待核实', rectify:'待整改', waiting:'待平台回复', restored:'审核通过', closed:'驳回',
});
const attr = 'custom-workbench-commodity-incident';
const textFields = ['title','supplier','supplierStyle','style','productID','skus','reason','nextStep'];
const dateFields = ['noticedOn','dueOn','restoredOn'];

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp=Date.parse(value+'T00:00:00Z');
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0,10)===value;
}

function incidentFields(input) {
    const result = {};
    for (const key of [...textFields,...dateFields]) {
        const value=input[key] ?? '';
        if (typeof value!=='string' || value.length>2000) throw new Error('登记字段格式不正确或过长');
        result[key]=value.trim();
    }
    if (!result.title || !result.style) throw new Error('请填写事件标题和款号');
    if (!result.noticedOn || dateFields.some(key=>result[key]&&!validDate(result[key]))) throw new Error('请填写有效的发现日期和处理日期');
    if (!Object.hasOwn(incidentStatuses,input.status)) throw new Error('请选择有效的处理状态');
    return {...result,status:input.status};
}

export class CommodityIncidentRepository {
    constructor(notebookId,{post,runWrite=operation=>operation()}) {
        if (!isValidNodeID(notebookId)) throw new Error('请选择有效的笔记本');
        this.notebookId=notebookId;
        this.post=post;
        this.runWrite=runWrite;
        this.parentID=stableNodeID(`${notebookId}:siyuan-workbench:commodity-incidents`);
    }

    async call(path,body) {
        const response=await this.post(path,body);
        if (response?.code!==0) {
            const error=new Error(response?.msg || '思源没有确认台账操作');
            error.data=response?.data;
            throw error;
        }
        return response.data;
    }

    marker(id) {return `<!-- siyuan-workbench-commodity-incident:v1:${this.notebookId}:${id} -->`;}

    async verify(id,path) {
        const location=await this.call('/api/filetree/getPathByID',{id});
        if (location?.notebook!==this.notebookId || location.path!==path) throw new Error('台账文档位置已变更');
        const raw=await this.call('/api/block/getBlockKramdown',{id});
        if (raw?.id!==id || !raw.kramdown?.split(/\r?\n/).includes(this.marker(id))) throw new Error('台账文档标记无法核对');
    }

    async ensureDocument(id,parentID,path,title,markdown) {
        try {
            await this.call('/api/filetree/createDocByParent',{
                notebook:this.notebookId,parentID,id,title:{format:'plain',text:title},markdown,
            });
        } catch (error) {
            try {await this.verify(id,path);}
            catch {throw error;}
            return;
        }
        await this.verify(id,path);
    }

    async list() {
        const records=[];
        for (let offset=0;;offset+=200) {
            const rows=await this.call('/api/query/sql',{mode:'readonly',stmt:
                `SELECT id FROM blocks WHERE type='d' AND box='${this.notebookId}' AND path LIKE '/${this.parentID}/%' AND path NOT LIKE '/${this.parentID}/%/%' ORDER BY id DESC LIMIT 200 OFFSET ${offset}`,
            });
            if (!Array.isArray(rows)) throw new Error('无法读取商品异常记录');
            for (const row of rows) {
                if (!isValidNodeID(row.id)) throw new Error('台账文档 ID 无效');
                const attrs=await this.call('/api/attr/getBlockAttrs',{id:row.id});
                if (!attrs?.[attr]) continue;
                const record=JSON.parse(attrs[attr]);
                if (record?.id!==row.id) throw new Error('台账记录与文档身份不匹配');
                records.push({...record,...incidentFields(record)});
            }
            if (rows.length<200) return records;
        }
    }

    save(id,input,expectedUpdatedAt) {
        return this.runWrite(()=>this.#save(id,input,expectedUpdatedAt));
    }

    async #save(id,input,expectedUpdatedAt) {
        if (!isValidNodeID(id) || id===this.parentID) throw new Error('台账文档 ID 无效');
        const fields=incidentFields(input);
        const path=`/${this.parentID}/${id}.sy`;
        if (expectedUpdatedAt===undefined) {
            await this.ensureDocument(this.parentID,null,`/${this.parentID}.sy`,'商品异常台账',this.marker(this.parentID));
            await this.ensureDocument(id,this.parentID,path,fields.title,
                this.marker(id)+'\n\n## 平台通知与凭证\n\n## 核实与处理时间线\n\n## 整改材料与平台回复\n\n## 最终结果');
        } else await this.verify(id,path);
        const attrs=await this.call('/api/attr/getBlockAttrs',{id});
        const current=attrs?.[attr] ? JSON.parse(attrs[attr]) : null;
        if (current && current.id!==id) throw new Error('台账记录与文档身份不匹配');
        if (current && Object.keys(fields).every(key=>current[key]===fields[key])) return current;
        if (current && expectedUpdatedAt===undefined) {
            throw new Error('登记结果已存在，请刷新后编辑该事件');
        }
        if (current?.updatedAt!==expectedUpdatedAt) throw new Error('该事件已变更，请刷新后重新编辑');
        const updatedAt=Math.max(Date.now(),(current?.updatedAt||0)+1);
        const record={...current,...fields,id,createdAt:current?.createdAt||updatedAt,updatedAt};
        await this.verify(id,path);
        const serialized=JSON.stringify(record);
        await this.call('/api/attr/setBlockAttrs',{id,attrs:{[attr]:serialized}});
        await this.call('/api/sqlite/flushTransaction',{});
        const saved=await this.call('/api/attr/getBlockAttrs',{id});
        if (saved?.[attr]!==serialized) throw new Error('登记结果未确认，请保留当前表单后重试或刷新核对');
        return record;
    }
}
