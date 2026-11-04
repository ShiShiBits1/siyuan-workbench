const cards={todayTasks:['今日待办','已排期且未完成'],overdueTasks:['逾期未完成','按结束时间判断'],unscheduledTasks:['待安排','未设置开始和结束'],todayEvents:['今日日程','与本地今日相交']};
export function overviewCardsHTML(state,escape) {
  if(state.error)return `<section class="swb-summary" aria-label="今日概览"><p role="alert">概览读取失败：${escape(state.error)}</p><button type="button" data-action="refresh-overview">重新读取概览</button></section>`;
  const entries=Object.entries({...cards,...(state.includeJobs?{awaitingReviewJobs:['待验收成果','等待你采纳或退回']}: {})});
  return `<section class="swb-summary ${state.includeJobs?'swb-summary--jobs':''}" aria-label="今日概览">${entries.map(([key,[title,hint]])=>{const ready=Array.isArray(state.data?.[key]),failed=key==='awaitingReviewJobs'&&state.data?.reviewError;return `<button type="button" data-overview="${key}" ${!ready?'disabled':''}><span>${title}</span><strong>${ready?state.data[key].length:'—'}</strong><small ${failed?'role="alert"':''}>${failed?'委托读取失败，请核查':ready?hint:'正在读取…'}</small></button>`;}).join('')}</section>`;
}
