# 工作台 UI 模块

`workbench.js` 导出 `mountWorkbench(container, options)`，仅负责展示和表单交互；`workbench.css` 需随插件视图加载。该模块不读写 localStorage，不直接调用 Kernel API。

## 挂载约定

```js
import { mountWorkbench } from "../ui/workbench.js";
import "../ui/workbench.css";

const tasks = await repository.list("task", { from: dayStart, to: dayEnd });
const events = await repository.list("event", { from: dayStart, to: dayEnd });
const cleanup = mountWorkbench(container, {
  tasks,
  events,
  onSave: async record => record.id
    ? repository.update(record.id, record)
    : repository.create(record),
  onDateChange: async date => { /* 按新日期查询并重新挂载/刷新 */ },
});
// 视图关闭时调用 cleanup()
```

UI 提交 `kind: "task" | "event"`；任务状态用 `todo | in_progress | done`，优先级用 `low | normal | high | urgent | null`，时间是 ISO 8601 字符串或 `null`，附件字段为 `attachmentPaths: string[]`。新建时 `onSave` 应返回 repository 创建后的完整记录（含思源文档 ID），更新时返回更新后的完整记录。UI 显示中文状态/优先级。

`onDateChange` 用于日期切换后由插件入口重查仓储。表单提醒时间只保存，不会自行调度通知。附件通过原生资源选择器选择已有思源资源，记录中保存资源路径。

v1.0.2 中，`onCreateNote()` 不接收标题/正文表单数据，由插件入口创建空白笔记并以 `openTab` 打开原生编辑器；两个按钮共享同一 pending，失败重试由入口保护。`onDeleteTask(task)` 只在用户二次确认后调用，成功须返回 `{id,deleted:true}`。任务中心使用 `deleteTask(id,{expectedUpdatedAt})`；前置明确未提交可重试，未知或已提交但未核实则暂停写入直到成功刷新。删除当前计时目标调用 `detachPomodoroTask(notebookId,id)`，只清除关联，不重置本轮。
