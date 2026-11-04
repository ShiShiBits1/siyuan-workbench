import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const allowlist=JSON.parse(readFileSync(resolve(projectRoot,'scripts/package-files.json'),'utf8'));
const required=[...allowlist.generated,...allowlist.copied];
const fail=message=>{throw new Error(message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function safeName(name){return typeof name==='string'&&/^[A-Za-z0-9._/-]+$/.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');}
function checkedFiles(directory,prefix=''){
  if(lstatSync(directory).isSymbolicLink())fail('Package directory must not be a link');
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const name=prefix+entry.name,path=resolve(directory,entry.name);
    if(!safeName(name)||entry.isSymbolicLink())fail('Unsafe package entry: '+name);
    if(entry.isDirectory())return checkedFiles(path,name+'/');
    if(!entry.isFile())fail('Package entry must be a regular file: '+name);
    return [name];
  });
}
function sameNames(actual,expected){return actual.length===expected.length&&new Set(actual.map(name=>name.toLowerCase())).size===actual.length&&[...actual].sort().join('\n')===[...expected].sort().join('\n');}
function png(bytes,name,width,height,maxBytes){
  if(bytes.length>maxBytes)fail(name+' exceeds '+maxBytes+' bytes');
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')fail(name+' must be PNG');
  if(bytes.readUInt32BE(16)!==width||bytes.readUInt32BE(20)!==height)fail(name+' must be '+width+'x'+height);
}

/** Local release checks do not assert public GitHub visibility, Release upload or
 * marketplace approval; those require separate live verification by the publisher.
 */
export function validateMarketplace({directory=resolve(projectRoot,'dist'),archivePath,requirePackageName=false}={}){
  const names=checkedFiles(directory);
  if(!sameNames(names,required))fail('Package directory differs from the exact allowlist');
  const files=new Map(required.map(name=>[name,readFileSync(resolve(directory,name))]));
  const plugin=JSON.parse(files.get('plugin.json').toString('utf8').replace(/^\uFEFF/,''));
  const sourcePackage=JSON.parse(readFileSync(resolve(projectRoot,'package.json'),'utf8'));
  if(plugin.name!=='siyuan-workbench'||plugin.version!==sourcePackage.version)fail('Package identity/version differs from source package.json');
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(plugin.version))fail('Invalid semantic version');
  const repository=/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(plugin.url||'');
  if(!repository||repository[2].toLowerCase()!==plugin.name.toLowerCase())fail('Marketplace requires a same-name GitHub repository URL without trailing slash or .git');
  if(plugin.icon!=='icon.png'||plugin.preview!=='preview.png')fail('Marketplace icon/preview fields must reference the root PNG files');
  for(const field of ['displayName','description','readme'])if(typeof plugin[field]?.default!=='string'||!plugin[field].default.trim())fail('Missing default '+field);
  for(const readme of Object.values(plugin.readme)){if(!files.has(readme))fail('Readme is not packaged: '+readme);}
  for(const field of ['kernels','backends','frontends'])if(!Array.isArray(plugin[field])||plugin[field].length===0)fail('Missing supported '+field);
  if(!files.get('LICENSE').toString('utf8').trim())fail('Missing license text');
  if(!files.get('THIRD-PARTY-NOTICES.md').toString('utf8').trim())fail('Missing third-party license notices');
  png(files.get('icon.png'),'icon.png',160,160,64*1024);
  png(files.get('preview.png'),'preview.png',1024,768,512*1024);
  const alipay=files.get('images/support-alipay.jpg'),wechat=files.get('images/support-wechat.png');
  if(alipay.length<4||alipay[0]!==255||alipay[1]!==216)fail('Alipay support image is not a JPEG');
  if(wechat.length<8||!wechat.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('WeChat support image is not a PNG');
  if(plugin.funding?.links!==undefined){
    if(!Array.isArray(plugin.funding.links))fail('Funding links must be an array');
    for(const link of plugin.funding.links){
      if(typeof link?.label!=='string'||!link.label.trim()||typeof link.url!=='string')fail('Invalid labeled funding link');
      const url=new URL(link.url);if(url.protocol!=='https:'||url.username||url.password)fail('Funding links must use credential-free HTTPS');
    }
  }
  if(archivePath){
    if(requirePackageName&&basename(archivePath)!=='package.zip')fail('Marketplace Release asset must be named package.zip');
    const seen=new Set();
    const archive=unzipSync(readFileSync(archivePath),{filter(entry){
      const key=entry.name.toLowerCase();
      if(!safeName(entry.name)||seen.has(key))fail('Unsafe or duplicated archive path: '+entry.name);
      seen.add(key);return true;
    }});
    if(!sameNames(Object.keys(archive),required))fail('Archive differs from the exact package allowlist');
    for(const name of required)if(!files.get(name).equals(Buffer.from(archive[name])))fail('Archive differs from verified package files: '+name);
  }
  return {status:'local-marketplace-package-valid',version:plugin.version,repository:plugin.url,fileCount:required.length,
    files:required.map(name=>({name,bytes:files.get(name).length,sha256:digest(files.get(name))})),
    ...(archivePath?{archive:resolve(archivePath),sha256:digest(readFileSync(archivePath))}:{}),
    pendingExternalChecks:['public same-name GitHub repository with main default branch','latest Release package.zip asset','marketplace listing review'],
  };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),directoryIndex=args.indexOf('--directory'),archiveIndex=args.indexOf('--archive');
    const result=validateMarketplace({directory:directoryIndex<0?undefined:resolve(args[directoryIndex+1]),archivePath:archiveIndex<0?undefined:resolve(args[archiveIndex+1]),requirePackageName:args.includes('--require-package-name')});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){process.stderr.write((error?.message||String(error))+'\n');process.exitCode=1;}
}
