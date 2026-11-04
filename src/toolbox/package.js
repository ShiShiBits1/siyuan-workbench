import {Inflate} from 'fflate';

export const TOOL_LIMITS = Object.freeze({archiveBytes:2*1024*1024,entries:32,fileBytes:256*1024,totalBytes:1024*1024});
const decoder=new TextDecoder('utf-8',{fatal:true});
const fail=message=>{throw new Error(message);};
export function toolPath(value){
    if(typeof value!=='string'||!value||value.length>160||/[\\:%\u0000-\u001f\u007f<>"|?*]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))fail('工具文件路径无效');
    return value.normalize('NFC');
}
export function validateManifest(value){
    const keys=['schemaVersion','id','name','version','author','description','entry','permissions'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('工具清单格式或字段不受支持');
    if(value.schemaVersion!==1||typeof value.id!=='string'||!/^[a-z][a-z0-9-]{2,63}$/.test(value.id))fail('工具ID或清单版本无效');
    if(typeof value.version!=='string'||!/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value.version))fail('工具版本必须为三段数字');
    for(const [key,max] of [['name',80],['author',100],['description',600]])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max||/[\u0000-\u0008]/.test(value[key]))fail('工具名称、作者或说明无效');
    if(!Array.isArray(value.permissions)||value.permissions.length)fail('首版工具不支持宿主或网络权限');
    if(!toolPath(value.entry).endsWith('.html'))fail('工具入口必须为本地HTML文件');
    return structuredClone(value);
}
export function crc32(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;}
export async function readToolZip(input){
    if(input?.size>TOOL_LIMITS.archiveBytes)fail('工具ZIP超过2MB');
    const bytes=input instanceof Uint8Array?input:new Uint8Array(await input.arrayBuffer());
    if(bytes.length>TOOL_LIMITS.archiveBytes||bytes.length<22)fail('工具ZIP大小无效');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=i=>view.getUint16(i,true),u32=i=>view.getUint32(i,true);
    let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===bytes.length){end=i;break;}
    if(end<0||u16(end+4)||u16(end+6)||u16(end+8)!==u16(end+10))fail('不支持分卷或损坏的ZIP');
    const count=u16(end+10),offset=u32(end+16),length=u32(end+12);
    if(!count||count>TOOL_LIMITS.entries||offset+length!==end||count===65535)fail('工具条目数量、ZIP64或目录无效');
    let at=offset,total=0;const entries=[],seen=new Set(),ranges=[];
    for(let i=0;i<count;i++){
        if(at+46>end||u32(at)!==0x02014b50)fail('ZIP中央目录损坏');
        const flags=u16(at+8),method=u16(at+10),compressed=u32(at+20),size=u32(at+24),nameLen=u16(at+28),extraLen=u16(at+30),commentLen=u16(at+32),local=u32(at+42),attrs=u32(at+38),mode=(attrs>>>16)&0xf000;
        if(flags&~0x080e||![0,8].includes(method)||[compressed,size,local].includes(0xffffffff)||u16(at+34)||at+46+nameLen+extraLen+commentLen>end)fail('不支持加密、特殊压缩或ZIP64');
        if(mode&&mode!==0x8000&&mode!==0x4000)fail('工具ZIP不可包含符号链接或特殊文件');
        const name=decoder.decode(bytes.subarray(at+46,at+46+nameLen)),directory=name.endsWith('/'),path=toolPath(directory?name.slice(0,-1):name),key=path.toLowerCase();
        if(seen.has(key))fail('工具ZIP包含重复规范化路径');seen.add(key);
        for(let p=at+46+nameLen,limit=p+extraLen;p<limit;){if(p+4>limit||p+4+u16(p+2)>limit||u16(p)===1)fail('ZIP扩展字段或ZIP64不受支持');p+=4+u16(p+2);}
        if(size>TOOL_LIMITS.fileBytes||(total+=size)>TOOL_LIMITS.totalBytes||(size>4096&&size>Math.max(1,compressed)*200))fail('工具解压大小或压缩比超限');
        if(local+30>offset||u32(local)!==0x04034b50||u16(local+6)!==flags||u16(local+8)!==method)fail('ZIP本地目录不一致');
        const ln=u16(local+26),le=u16(local+28),start=local+30+ln+le,finish=start+compressed;
        if(start>offset||finish>offset||decoder.decode(bytes.subarray(local+30,local+30+ln))!==name)fail('ZIP文件名或数据范围不一致');
        for(let p=local+30+ln,limit=p+le;p<limit;){if(p+4>limit||p+4+u16(p+2)>limit||u16(p)===1)fail('ZIP本地扩展字段无效');p+=4+u16(p+2);}
        if(!(flags&8)&&(u32(local+18)!==compressed||u32(local+22)!==size||u32(local+14)!==u32(at+16)))fail('ZIP本地长度不一致');
        if(ranges.some(([a,b])=>local<b&&finish>a))fail('ZIP条目数据重叠');ranges.push([local,finish]);
        if(directory&&size)fail('ZIP目录不能包含数据');
        if(!directory){if(path!=='tool.json'&&!/\.(html|js|css)$/.test(path))fail('首版工具仅支持HTML、JS、CSS及tool.json');entries.push({path,start,finish,size,method,crc:u32(at+16)});}
        at+=46+nameLen+extraLen+commentLen;
    }
    if(at!==end)fail('ZIP目录长度不一致');
    const files={};
    for(const e of entries){
        const raw=bytes.subarray(e.start,e.finish);let out=raw;
        if(e.method===8){
            out=new Uint8Array(e.size);let written=0,finished=false;
            const stream=new Inflate((chunk,final)=>{if(written+chunk.length>e.size)fail('ZIP实际解压大小超限');out.set(chunk,written);written+=chunk.length;finished=final;});
            if(!raw.length)fail('ZIP压缩数据为空');
            for(let p=0;p<raw.length;p+=256)stream.push(raw.subarray(p,Math.min(p+256,raw.length)),p+256>=raw.length);
            if(!finished||written!==e.size)fail('ZIP实际解压长度不一致');
        }
        if(out.length!==e.size||crc32(out)!==e.crc)fail('ZIP文件长度或校验失败');files[e.path]=decoder.decode(out);
    }
    return validateToolFiles(files);
}
export function validateToolFiles(files){
    if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>TOOL_LIMITS.entries)fail('工具文件集合无效');
    let total=0;const seen=new Set();
    for(const [name,text] of Object.entries(files)){
        const path=toolPath(name),key=path.toLowerCase();if(path!==name||seen.has(key)||typeof text!=='string'||(name!=='tool.json'&&!/\.(html|js|css)$/.test(name)))fail('工具文件格式无效');seen.add(key);
        const n=new TextEncoder().encode(text).length;if(n>TOOL_LIMITS.fileBytes||(total+=n)>TOOL_LIMITS.totalBytes)fail('工具文件大小超限');
    }
    let parsed;try{parsed=JSON.parse(files['tool.json']);}catch{fail('ZIP根目录缺少有效tool.json');}
    const manifest=validateManifest(parsed);if(!Object.hasOwn(files,manifest.entry))fail('工具入口不存在');
    return {manifest,files:structuredClone(files),totalBytes:total};
}
