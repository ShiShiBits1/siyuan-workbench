import {isValidNodeID, newNodeID} from './node-id.js';

export function createDocumentTreeRepository({notebookId, post}) {
  async function api(path, body) {
    const result = await post(path, body);
    if (result?.code !== 0) throw new Error(result?.msg || '思源未确认文档操作');
    return result.data;
  }

  async function list(path) {
    const data = await api('/api/filetree/listDocsByPath', {
      notebook: notebookId, path, maxListCount: 0, ignoreMaxListHint: true,
    });
    if (data?.box !== notebookId || (data.files != null && !Array.isArray(data.files))) throw new Error('无法读取当前笔记本文档');
    const prefix = path === '/' ? '/' : path.replace(/\.sy$/, '') + '/';
    return (data.files || []).filter(file => isValidNodeID(file?.id) && file.path === prefix + file.id + '.sy').map(file => ({
      id: file.id, path: file.path, title: String(file.name || '').replace(/\.sy$/, '') || '未命名文档',
      hasChildren: file.subFileCount > 0,
    }));
  }

  async function assertDocument(id) {
    if (!isValidNodeID(id)) throw new Error('文档标识无效');
    const info = await api('/api/block/getBlockInfo', {id});
    if (info?.box !== notebookId || info.rootID !== id) throw new Error('文档已移动或不在当前笔记本');
  }

  async function create(parentID, draft) {
    await assertDocument(parentID);
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    if (!title || title.length > 100 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('请输入有效的文档标题（最多 100 字）');
    draft.id ||= newNodeID();
    if (!isValidNodeID(draft.id)) throw new Error('新文档标识无效');
    try {
      const result = await api('/api/filetree/createDocByParent', {
        notebook: notebookId, parentID, id: draft.id, title: {format: 'plain', text: title}, markdown: '',
      });
      if (result?.id === draft.id || result === draft.id) return draft.id;
    } catch (failure) {
      const [child, parent, info] = await Promise.all([
        post('/api/filetree/getPathByID', {id: draft.id}),
        post('/api/filetree/getPathByID', {id: parentID}),
        post('/api/block/getBlockInfo', {id: draft.id}),
      ]);
      if (child?.code === 0 && parent?.code === 0 && child.data?.notebook === notebookId &&
          parent.data?.notebook === notebookId && parent.data.path?.endsWith('.sy') &&
          child.data.path === parent.data.path.slice(0, -3) + '/' + draft.id + '.sy' &&
          info?.code === 0 && info.data?.box === notebookId && info.data.rootID === draft.id &&
          info.data.rootTitle === title) return draft.id;
      throw failure;
    }
    await assertDocument(draft.id);
    return draft.id;
  }

  return {list, assertDocument, create};
}
