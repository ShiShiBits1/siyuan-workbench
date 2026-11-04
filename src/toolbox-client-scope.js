const KEY='siyuan-workbench-toolbox-client-v1';
const valid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// The native SDK returns an empty string when this client's JSON file is absent.
export const normalizeToolboxClientData=value=>value===''?undefined:value;

/** Client preferences, not account authentication or an authorization boundary. */
export function toolboxClientStorageKey({storage,randomUUID}) {
    let id;
    try{
        id=storage.getItem(KEY);
        if(id&&!valid(id))throw new Error('invalid-client-id');
        if(!id){id=randomUUID();if(!valid(id))throw new Error('invalid-generated-id');storage.setItem(KEY,id);if(storage.getItem(KEY)!==id)throw new Error('client-id-not-persisted');}
    }catch{throw new Error('工具箱无法保存本客户端标识，请检查浏览器存储权限；未使用共享安装配置');}
    return `workbench-toolbox-${id}.json`;
}
