import {mountRecordPage} from './record-page.js';

/** Projects edit their existing native document, while task pages use a separate body. */
export function mountProjectPage(host, options) {
  return mountRecordPage(host, {
    ...options,
    labels: {
      page: '项目详情页', bar: '项目详情', close: '关闭项目详情页',
      loading: '正在打开项目…', unnamed: '未命名项目', loadError: '项目加载失败，请重试。',
      body: '项目正文', bodyHint: '',
    },
    formatMetadata: record => [
      record?.status, record?.priority, record?.owner,
      record?.startDate ? '开始 ' + record.startDate : '',
      record?.endDate ? '截止 ' + record.endDate : '',
    ].filter(Boolean).join(' · '),
  });
}
