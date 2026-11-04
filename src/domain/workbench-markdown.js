import {validateRecord} from './workbench.js';

export const WORKBENCH_RECORD_MARKER = '```workbench-record\n';

export function formatWorkbenchRecordMarkdown(record) {
    const title = record.title.replace(/\r?\n/g, ' ').trim();
    const detail = record.detail || '';
    const json = JSON.stringify(record, null, 2);
    return `# ${title}\n\n${detail}\n\n${WORKBENCH_RECORD_MARKER}${json}\n\`\`\``;
}

export function parseWorkbenchRecordMarkdown(markdown) {
    if (typeof markdown !== 'string') throw new Error('记录正文无效');
    // Detail text is ordinary Markdown and may contain the marker characters;
    // the canonical machine record is appended last by the serializer.
    const start = markdown.lastIndexOf(WORKBENCH_RECORD_MARKER);
    if (start < 0) return null;
    const end = markdown.indexOf('\n```', start + WORKBENCH_RECORD_MARKER.length);
    if (end < 0) throw new Error('记录格式缺少闭合标记');
    return validateRecord(JSON.parse(markdown.slice(start + WORKBENCH_RECORD_MARKER.length, end)));
}
