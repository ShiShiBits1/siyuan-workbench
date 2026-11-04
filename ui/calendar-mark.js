const toLocalDate = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/** True when a dated record occupies the local day, or an undated record was created that day. */
export function hasCalendarMark(item, dateText) {
  const hasStart = Boolean(item.startAt);
  const hasEnd = Boolean(item.endAt);
  if (!hasStart && !hasEnd) return toLocalDate(item.createdAt) === dateText;

  const [year, month, day] = dateText.split("-").map(Number);
  const dayStart = new Date(year, month - 1, day).getTime();
  const nextDay = new Date(year, month - 1, day + 1).getTime();
  let start = hasStart ? Date.parse(item.startAt) : null;
  let end = hasEnd ? Date.parse(item.endAt) : null;
  if (start === null && end === null) return false;
  if (start === null) start = end;
  if (end === null) end = start;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start < nextDay && end >= dayStart;
}
