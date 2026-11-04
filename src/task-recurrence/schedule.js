import {isValidNodeID,stableNodeID} from '../data/node-id.js';
export function dateKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function day(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('日期无效');const [y,m,d]=value.split('-').map(Number),n=new Date(Date.UTC(y,m-1,d));if(n.toISOString().slice(0,10)!==value||y<2000||y>2100)throw new Error('日期范围无效');return n;}
export function validateRecurrenceRule(input){
  if(!input||!['daily','weekly'].includes(input.frequency))throw new Error('重复频率仅支持每日或每周');
  const interval=input.interval??1;if(!Number.isInteger(interval)||interval<1||interval>52)throw new Error('重复间隔必须为1至52');day(input.startDate);if(input.endDate){day(input.endDate);if(input.endDate<input.startDate)throw new Error('结束日期早于开始日期');}
  const time=input.time??'09:00';if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('重复时间无效');
  const weekdays=input.weekdays??(input.frequency==='weekly'?[day(input.startDate).getUTCDay()]:[]);if(!Array.isArray(weekdays)||(input.frequency==='weekly'&&!weekdays.length)||weekdays.length>7||weekdays.some(v=>!Number.isInteger(v)||v<0||v>6))throw new Error('重复星期无效');
  return {...input,frequency:input.frequency,interval,startDate:input.startDate,endDate:input.endDate||null,time,weekdays:[...new Set(weekdays)].sort()};
}
export function occurrenceDateTime(date,time){const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number),result=new Date(y,m-1,d,h,min);if(dateKey(result)!==date||result.getHours()!==h||result.getMinutes()!==min)throw new Error('本地时区该时间不存在，请调整重复计划');return result;}
export function occurrenceDates(input,{after=null,now=new Date(),limit=7}={}){
  const rule=validateRecurrenceRule(input);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('生成批次数量无效');if(after)day(after);if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('当前时间无效');
  const start=day(rule.startDate),end=day(dateKey(now)),anchor=start.getTime()-((start.getUTCDay()+6)%7)*86400000,dates=[];
  for(let n=start.getTime();n<=end.getTime();n+=86400000){const d=new Date(n),key=d.toISOString().slice(0,10);if(after&&key<=after)continue;if(rule.endDate&&key>rule.endDate)break;
    const matches=rule.frequency==='daily'?((n-start.getTime())/86400000)%rule.interval===0:Math.floor((n-anchor)/604800000)%rule.interval===0&&rule.weekdays.includes(d.getUTCDay());
    if(matches&&occurrenceDateTime(key,rule.time)<=now){dates.push(key);if(dates.length>limit)break;}
  }
  return {dates:dates.slice(0,limit),hasMore:dates.length>limit};
}
export function occurrenceID(seriesID,date){if(!isValidNodeID(seriesID))throw new Error('重复计划ID无效');day(date);return stableNodeID(`${date.replaceAll('-','')}000000:task-occurrence:${seriesID}`);}
