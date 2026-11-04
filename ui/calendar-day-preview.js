let previewSequence = 0;
const clock = new Intl.DateTimeFormat('zh-CN', {hour:'2-digit', minute:'2-digit', hourCycle:'h23'});

export function mountCalendarDayPreview(container, eventsForDate, emptyMessage) {
    const id = `swb-day-preview-${++previewSequence}`;
    let anchor, card;

    function close() {
        anchor?.removeAttribute('aria-describedby');
        anchor = null;
        card?.remove();
    }

    function show(button) {
        if (!button || (button === anchor && card?.isConnected)) return;
        const calendar = button.closest('.swb__calendar');
        if (!calendar) return;
        close();
        anchor = button;
        const doc = button.ownerDocument;
        card = doc.createElement('div');
        card.id = id;
        card.className = 'swb-day-preview';
        card.setAttribute('role', 'tooltip');
        const date = button.dataset.calendarDate;
        const events = eventsForDate(date);
        const title = doc.createElement('strong');
        title.textContent = `${date} 日程`;
        const list = doc.createElement('ul');
        for (const event of events.slice(0, 5)) {
            const item = doc.createElement('li');
            const start = Date.parse(event.startAt);
            const end = Date.parse(event.endAt);
            const times = [start,end].filter(Number.isFinite).map(value=>clock.format(value));
            item.textContent = `${times.length?`${times.join('–')} · `:''}${event.title}`;
            list.append(item);
        }
        const note = doc.createElement('p');
        if (!events.length) note.textContent = emptyMessage();
        if (events.length > 5) note.textContent = `另有 ${events.length - 5} 项，选择日期查看全部`;
        card.replaceChildren(title);
        if (events.length) card.append(list);
        if (note.textContent) card.append(note);
        calendar.append(card);
        const bounds = calendar.getBoundingClientRect();
        const day = button.getBoundingClientRect();
        const viewport = container.closest('.swb-host')?.getBoundingClientRect();
        const visibleTop = Math.max(0, viewport?.top ?? 0);
        const visibleBottom = Math.min(doc.documentElement.clientHeight, viewport?.bottom ?? Infinity);
        const above = day.top - visibleTop;
        const below = visibleBottom - day.bottom;
        const flip = card.offsetHeight > below && above > below;
        card.style.maxHeight = `${Math.max(0, (flip ? above : below) - 4)}px`;
        const width = card.offsetWidth;
        card.style.left = `${Math.max(0, Math.min(day.left - bounds.left, calendar.clientWidth - width))}px`;
        card.style.top = `${(flip ? day.top - card.offsetHeight : day.bottom) - bounds.top}px`;
        button.setAttribute('aria-describedby', id);
    }

    function enter(event) {
        if (event.pointerType === 'touch') return;
        show(event.target.closest?.('[data-calendar-date]'));
    }

    function leave(event) {
        if (!anchor) return;
        const next = event.relatedTarget;
        if (anchor.contains(next) || card.contains(next)) return;
        if (event.type === 'pointerout' && anchor.ownerDocument.activeElement === anchor) return;
        if (anchor.contains(event.target) || card.contains(event.target)) close();
    }

    function dismiss(event) {
        if (event.key === 'Escape' && card?.isConnected) close();
    }

    const handlers = {pointerover:enter,pointerout:leave,focusin:enter,focusout:leave,keydown:dismiss};
    for (const [type, handler] of Object.entries(handlers)) container.addEventListener(type, handler);
    return {close,dispose(){
        close();
        for (const [type, handler] of Object.entries(handlers)) container.removeEventListener(type, handler);
    }};
}
