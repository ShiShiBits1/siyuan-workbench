import {isValidNodeID} from '../data/node-id.js';
import {isAttachmentAssetPath} from '../task-attachment-upload.js';
import {normalizeSearchFilter,periodBounds} from './unified-search.js';
const literal=value=>`'${String(value).replace(/'/g,"''")}'`;
const like=value=>literal('%'+String(value).toLowerCase().replace(/[\\%_]/g,'\\$&')+'%');
const category=alias=>`COALESCE((SELECT a.value FROM attributes a WHERE a.block_id=${alias}.id AND a.box=${alias}.box AND a.name='custom-workbench-category' LIMIT 1),'')`;
function metadata(row){
 let tags=[];try{const parsed=JSON.parse(row.custom_tags||'[]');if(Array.isArray(parsed))tags=parsed.filter(x=>typeof x==='string');}catch{/* Native tags remain usable without custom metadata. */}
 if(!tags.length)tags=[...String(row.tag||'').matchAll(/#([^#]+)#/g)].map(x=>x[1]);
 return {category:typeof row.category==='string'?row.category:'',tags,updatedAt:row.updated||''};
}
export function createNativeSearchRepository({notebookId,post,limit=200,now=()=>new Date()}) {
 if(!isValidNodeID(notebookId)||typeof post!=='function'||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('当前笔记本搜索配置无效');
 async function query(stmt){const result=await post('/api/query/sql',{stmt,mode:'readonly'});if(result?.code!==0||!Array.isArray(result.data))throw new Error('原生搜索读取失败，请刷新重试');return result.data;}
 return {async search(input={}){
  const criteria=normalizeSearchFilter(input);
  if(['task','event'].includes(criteria.kind))return {notes:[],attachments:[],truncated:false};
  const ordinaryAllowed=!['overdue','unscheduled'].includes(criteria.period)&&(!criteria.status||criteria.status==='all');
  const q=String(criteria.query||'').trim(),scope=`d.type='d' AND d.box=${literal(notebookId)}`,conditions=[];
  if(criteria.category)conditions.push(`${category('d')}=${literal(criteria.category)}`);
  const bounds=periodBounds(criteria.period,now());
  if(bounds){const stamp=value=>{const d=new Date(value);return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;};conditions.push(`d.updated>=${literal(stamp(bounds.from))} AND d.updated<${literal(stamp(bounds.to))}`);}
  if(criteria.tag){const tag=literal(criteria.tag);conditions.push(`(d.tag LIKE ${like('#'+criteria.tag+'#')} ESCAPE '\\' OR EXISTS(SELECT 1 FROM attributes ta,json_each(CASE WHEN json_valid(ta.value) THEN ta.value ELSE '[]' END) jt WHERE ta.block_id=d.id AND ta.box=d.box AND ta.name='custom-workbench-tags' AND jt.value=${tag}))`);}
  const extra=conditions.length?' AND '+conditions.join(' AND '):'';
  const cols=`d.id,d.content,d.updated,d.tag,${category('d')} AS category,(SELECT a.value FROM attributes a WHERE a.block_id=d.id AND a.box=d.box AND a.name='custom-workbench-tags' LIMIT 1) AS custom_tags`;
  const text=q?` AND (lower(d.content) LIKE ${like(q)} ESCAPE '\\' OR EXISTS(SELECT 1 FROM blocks b WHERE b.root_id=d.id AND b.box=d.box AND (lower(b.content) LIKE ${like(q)} ESCAPE '\\' OR lower(b.markdown) LIKE ${like(q)} ESCAPE '\\')))` :'';
  const assetText=q?` AND (lower(s.name) LIKE ${like(q)} ESCAPE '\\' OR lower(s.path) LIKE ${like(q)} ESCAPE '\\')`:'';
  // Task metadata lives in its managed JSON, not necessarily native attributes.
  // Let the final scoped task map apply those filters to task-owned resources.
  const taskRoot=`EXISTS(SELECT 1 FROM attributes wa WHERE wa.block_id=d.id AND wa.box=d.box AND wa.name='custom-workbench-type' AND wa.value='task')`;
  const assetEligibility=` AND (${taskRoot} OR (${ordinaryAllowed?'1'+extra:'0'}))`;
  const [docs,assets]=await Promise.all([ordinaryAllowed&&criteria.kind!=='attachment'?query(`SELECT ${cols} FROM blocks d WHERE ${scope}${extra}${text} ORDER BY d.updated DESC,d.id ASC LIMIT ${limit+1}`):Promise.resolve([]),criteria.kind!=='note'?query(`SELECT DISTINCT ${cols},s.path AS attachment_path,s.name AS attachment_name FROM assets s JOIN blocks d ON d.id=s.root_id AND d.box=s.box WHERE s.box=${literal(notebookId)} AND ${scope}${assetEligibility}${assetText} ORDER BY d.updated DESC,d.id ASC,s.path ASC LIMIT ${limit+1}`):Promise.resolve([])]);
  const notes=docs.slice(0,limit).map(row=>{if(!isValidNodeID(row.id)||typeof row.content!=='string')throw new Error('搜索文档身份无效');return {id:row.id,kind:'note',title:row.content,_matchedQuery:q,...metadata(row)};});
  const attachments=assets.slice(0,limit).map(row=>{if(!isValidNodeID(row.id)||!isAttachmentAssetPath(row.attachment_path))return null;return {id:`${row.id}:${row.attachment_path}`,kind:'attachment',sourceId:row.id,attachmentPath:row.attachment_path,title:row.attachment_name||decodeURIComponent(row.attachment_path.split('/').at(-1)),...metadata(row)};}).filter(Boolean);
  return {notes,attachments,truncated:docs.length>limit||assets.length>limit};
 }};
}
