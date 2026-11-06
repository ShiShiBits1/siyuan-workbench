/** Render the native question tool without granting permission or starting a new turn. */
export function appendAgentQuestion(log, data, {answerQuestion, isCurrent, ownsTurn, onAnswered}) {
    const {questionID} = data;
    const questions = data.arguments?.questions;
    if (typeof questionID !== 'string' || !questionID || !Array.isArray(questions) || !questions.length) {
        throw new Error('原生 Agent 返回的问题缺少内容或标识');
    }
    if (typeof answerQuestion !== 'function') throw new Error('工作台未连接原生 Agent 答题接口');

    const doc = log.ownerDocument;
    const form = doc.createElement('form');
    form.className = 'swa__question';
    form.setAttribute('aria-label', 'Agent 提问');
    const fields = questions.map((question, index) => {
        if (typeof question?.question !== 'string' || !question.question.trim() || !Array.isArray(question.options)) {
            throw new Error('原生 Agent 返回的问题格式无效');
        }
        const group = doc.createElement('fieldset');
        const title = doc.createElement('legend');
        title.textContent = question.question;
        if (typeof question.header === 'string' && question.header) {
            const header = doc.createElement('small');
            header.textContent = question.header;
            title.prepend(header);
        }
        group.append(title);
        const choices = question.options.map(option => {
            if (typeof option?.label !== 'string' || !option.label.trim()) throw new Error('原生 Agent 返回了无效选项');
            const label = doc.createElement('label');
            const input = doc.createElement('input');
            input.type = question.multiple === true ? 'checkbox' : 'radio';
            input.name = 'choice-' + index;
            input.value = option.label;
            const copy = doc.createElement('span');
            copy.textContent = option.label;
            if (typeof option.description === 'string' && option.description) {
                const description = doc.createElement('small');
                description.textContent = option.description;
                copy.append(description);
            }
            label.append(input, copy);
            group.append(label);
            return input;
        });
        let custom;
        if (question.custom !== false) {
            custom = doc.createElement('input');
            custom.type = 'text';
            custom.placeholder = '自定义回答';
            custom.setAttribute('aria-label', question.question + '，自定义回答');
            group.append(custom);
        } else if (!choices.length) {
            throw new Error('原生 Agent 返回的问题没有可填写的选项');
        }
        form.append(group);
        return {choices, custom};
    });

    const submit = doc.createElement('button');
    submit.type = 'submit';
    submit.className = 'swa__primary';
    submit.textContent = '提交回答';
    const feedback = doc.createElement('p');
    feedback.setAttribute('role', 'status');
    form.append(submit, feedback);
    log.append(form);
    // Reveal the start of a long question without scrolling the whole workbench.
    log.scrollTop += form.getBoundingClientRect().top - log.getBoundingClientRect().top;

    let closed = false, pending = false, answered = false;
    function disable(value) {
        submit.disabled = value;
        for (const input of form.querySelectorAll('input')) input.disabled = value;
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!isCurrent() || closed || pending || answered) return;
        const answers = fields.flatMap(({choices, custom}) => {
            const selected = choices.filter(input => input.checked).map(input => input.value);
            if (custom?.value.trim()) selected.push(custom.value.trim());
            return selected;
        });
        if (!answers.length) {
            feedback.textContent = '请先选择或填写回答。';
            return;
        }
        pending = true;
        disable(true);
        feedback.textContent = '正在提交回答…';
        try {
            await answerQuestion(questionID, answers);
            answered = true;
            if (ownsTurn()) feedback.textContent = '回答已提交';
            if (!closed && isCurrent()) onAnswered();
        } catch (error) {
            if (!closed && isCurrent()) {
                feedback.textContent = error?.message || '回答提交失败，请重试。';
                disable(false);
            } else if (ownsTurn()) {
                feedback.textContent = error?.message || '回答提交结果未确认';
            }
        } finally {
            pending = false;
        }
    });
    return {
        close() {
            closed = true;
            disable(true);
            if (!answered) feedback.textContent = pending ? '本轮已结束，回答提交结果待确认' : '本轮已结束';
        },
    };
}
