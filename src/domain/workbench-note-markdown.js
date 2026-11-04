export const WORKBENCH_NOTE_MARKER = '```workbench-note\n';

export function validateWorkbenchNote(input) {
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const detail = typeof input?.detail === 'string' ? input.detail : '';
    if (input?.type !== 'note') throw new Error('记录不是独立笔记');
    if (!title) throw new Error('笔记标题不能为空');
    if (title.length > 200) throw new Error('笔记标题不能超过 200 个字符');
    if (detail.length > 100000) throw new Error('笔记正文不能超过 100000 个字符');
    if (typeof input?.id !== 'string' || !/^\d{14}-[a-z0-9]{7}$/.test(input.id)) throw new Error('笔记 ID 无效');
    const createdAt = validTimestamp(input.createdAt, '创建时间');
    const updatedAt = validTimestamp(input.updatedAt, '更新时间');
    return {type: 'note', id: input.id, title, detail, createdAt, updatedAt};
}

export function formatWorkbenchNoteMarkdown(note) {
    const normalized = validateWorkbenchNote(note);
    const heading = normalized.title.replace(/[\r\n]+/g, ' ').trim();
    return `# ${heading}\n\n${normalized.detail}\n\n${WORKBENCH_NOTE_MARKER}${JSON.stringify(normalized, null, 2)}\n\`\`\``;
}

export function parseWorkbenchNoteMarkdown(markdown) {
    if (typeof markdown !== 'string') throw new Error('笔记正文无效');
    const start = markdown.lastIndexOf(WORKBENCH_NOTE_MARKER);
    if (start < 0) return null;
    const end = markdown.indexOf('\n```', start + WORKBENCH_NOTE_MARKER.length);
    if (end < 0) throw new Error('笔记格式缺少闭合标记');
    const note = validateWorkbenchNote(JSON.parse(markdown.slice(start + WORKBENCH_NOTE_MARKER.length, end)));
    if (note.type !== 'note') throw new Error('文档不是工作台笔记');
    return note;
}

function validTimestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error(`笔记${label}无效`);
    }
    return value;
}
