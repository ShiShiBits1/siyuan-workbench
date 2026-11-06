import {Plugin, Setting, showMessage, openTab, fetchSyncPost} from 'siyuan';
import {WorkbenchRepository} from './data/workbench-repository.js';
import {WorkbenchNotesRepository} from './data/workbench-notes.js';
import {WorkbenchPlannerRepository} from './data/workbench-planner.js';
import {createNativeNoteOpener} from './native-note-opener.js';
import {deleteTaskAndRefresh} from './task-deletion.js';
import {createCalendarActions} from './calendar-actions.js';
import {createWorkbenchRecordActions} from './workbench-record-actions.js';
import {createTaskAttachmentUploader} from './task-attachment-upload.js';
import {createChatAttachmentPreparer} from './agent/chat-attachments.js';
import {createAttachmentOpener,createAttachmentDownloader} from './attachment-opener.js';
import {toolboxClientStorageKey,normalizeToolboxClientData} from './toolbox-client-scope.js';
import {createToolboxManager} from './toolbox/manager.js';
import {createTaskTemplateRepository} from './task-templates/index.js';
import {createTaskRecurrenceService} from './task-recurrence/index.js';
import {createTaskArrangementService} from './domain/task-arrangements.js';
import {createUnifiedSearchService} from './search/unified-search.js';
import {createNativeSearchRepository} from './search/native-search.js';
import {createSavedSearchStore} from './search/saved-searches.js';
import {createNativeSearchViewStorage} from './search/native-view-storage.js';
import {isAttachmentAssetPath} from './task-attachment-upload.js';
import {mountUnifiedSearch} from '../ui/unified-search.js';
import {mountToolbox} from '../ui/toolbox.js';
import {mountTaskTemplateCenter} from '../ui/task-template-center.js';
import {CategoryOrganizerRepository} from './data/category-organization.js';
import {assertWorkbenchLocation,normalizeCategory} from './data/category-location.js';
import {readWorkbenchCategories} from './data/read-record-list.js';
import {CommodityIncidentRepository} from './data/commodity-incidents.js';
import {mountCommodityIncidents} from '../ui/commodity-incidents.js';
import {mountCategoryOrganizer} from '../ui/category-organizer.js';
import {mountPlanner} from '../ui/planner.js';
import {mountCalendarWorkspace} from '../ui/calendar-workspace.js';
import {mountReminderCenter} from '../ui/reminder-center.js';
import {mountFocusControls} from '../ui/focus-controls.js';
import {mountAgentWorkspace} from '../ui/agent-workspace.js';
import {createNativeAgentClient} from './agent/native-agent-client.js';
import {AgentJobRepository} from './data/agent-jobs.js';
import {createAgentJobRunner} from './agent/agent-job-runner.js';
import {createEditorAIClient} from './agent/editor-ai-client.js';
import {mountAgentJobs} from '../ui/agent-jobs.js';
import {createJobBatch} from './agent/job-batch.js';
import {workReportSnapshot,formatWorkReport} from './domain/task-history.js';
import {WORK_TEMPLATES} from './domain/work-templates.js';
import {mountDiagnostics} from '../ui/diagnostics.js';
import {createVisibleRefresh} from '../ui/refresh-lifecycle.js';
import {createPomodoroDockHost} from '../ui/pomodoro-dock-host.js';
import {mountPomodoroDock} from '../ui/pomodoro-dock.js';
import {mountRecordDock} from '../ui/record-dock.js';
import {createAgentDock,AGENT_DOCK_ICON} from './agent-dock.js';
import {configurePomodoro, getPomodoroConfiguration} from '../ui/workbench.js';
import {mountWorkbench, suspendPomodoro, getPomodoroState, restorePomodoroState} from '../ui/workbench.js';
import {setPomodoroNotifier} from '../ui/workbench.js';
import {detachPomodoroTask} from '../ui/workbench.js';
import {mountWorkbenchShell} from '../ui/workbench-shell.js';
import {mountProjects} from '../ui/projects.js';
import {createWorkbenchProjects} from './data/workbench-projects.js';
import {createDocumentTreeRepository} from './data/workbench-document-tree.js';
import {createTaskBodyRepository} from './data/task-body.js';
import {prepareProjectBody} from './data/project-body.js';
import {createNativeTaskEditor} from './native-task-editor.js';
import {mountRecordPage} from '../ui/record-page.js';
import {mountSupportDevelopment} from '../ui/support-development.js';
import {mountProjectPage} from '../ui/project-page.js';
import {createReminderClient} from '../ui/reminder-client.js';
import {createNotebookLoader, createSerialWriter} from '../ui/notebook-loader.js';
import {createNativeWorkbenchHost,createNotebookSettingControl,hasWorkbenchDraft,saveCheckedData} from '../ui/workbench-host.js';
import '../ui/workbench.css';
import '../ui/calendar-day-preview.css';
import '../ui/workbench-shell.css';
import '../ui/notes-library.css';
import '../ui/planner.css';
import '../ui/reminder-center.css';
import '../ui/focus-controls.css';
import '../ui/agent-workspace.css';
import '../ui/calendar-workspace.css';
import '../ui/agent-jobs.css';
import '../ui/job-batch-panel.css';
import '../ui/diagnostics.css';
import '../ui/pomodoro-dock.css';
import '../ui/record-dock.css';
import '../ui/category-organizer.css';
import '../ui/toolbox.css';
import '../ui/task-template-center.css';
import '../ui/unified-search.css';
import '../ui/commodity-incidents.css';
import '../ui/projects.css';
import '../ui/document-tree.css';
import '../ui/record-page.css';
import '../ui/support-development.css';

const SETTINGS_KEY = 'workbench-settings.json';
const POMODORO_KEY = 'workbench-pomodoro.json';
const WORKBENCH_VERSION = '1.11.0';

export default class SiYuanWorkbench extends Plugin {
    async onload() {
        this.disposed = false;
        this.configurationSaveUnconfirmed = false;
        this.selectedNotebookId = '';
        this.hasLoadedNotebookSelection = false;
        this.agentSyncGeneration = 0;
        this.agentRuns = new Set();
        this.agentBusy = false;
        this.notebookLoaders = new Set();
        this.workspaceRefreshers = new Set();
        this.workspaceClockRefreshers = new Set();
        this.dockContextRefreshers = new Set();
        this.calendarControllers = new Set();
        this.agentStatusElements = new Set();
        this.workspaceWrites = new Set();
        this.toolboxManager=null;
        this.searchViewStores=new Map();
        this.recurrenceRepositories=new Map();
        this.recurrenceNotices=new Map();
        this.openTaskAttachment=createAttachmentOpener({app:this.app,open:options=>openTab(options),download:createAttachmentDownloader({document})});
        this.taskRecurrenceService=createTaskRecurrenceService({
            post:(path,body)=>fetchSyncPost(path,body,undefined,false),
            repositoryFactory:notebookId=>{if(!this.recurrenceRepositories.has(notebookId))this.recurrenceRepositories.set(notebookId,new WorkbenchRepository(notebookId));return this.recurrenceRepositories.get(notebookId);},
            runWrite:(book,operation)=>this.runWorkspaceWrite(book,operation),
            onChanged:()=>this.notifyWorkspaceChange(),
            isDisposed:()=>this.disposed,
            maxCatchUp:7,
        });
        this.taskDeletions = new Map();
        this.categoryOrganizer = null;
        const nativeNoteRepositories=new Map();
        this.nativeNoteOpener=createNativeNoteOpener({
            assertAvailable:notebookId=>this.assertWorkspaceAvailable(notebookId),
            create:(notebookId,draft)=>{
                if(!nativeNoteRepositories.has(notebookId))nativeNoteRepositories.set(notebookId,new WorkbenchRepository(notebookId));
                return nativeNoteRepositories.get(notebookId).createNativeNote(draft);
            },
            open:id=>openTab({app:this.app,doc:{id},openNewTab:true}),
            onCreated:()=>{this.notifyWorkspaceChange();},
        });
        this.resolveWorkbenchReady = null;
        this.workbenchReady = new Promise(resolve => {this.resolveWorkbenchReady=resolve;});
        this.writePomodoroSnapshot=createSerialWriter(state=>saveCheckedData((name,value)=>this.saveData(name,value),POMODORO_KEY,state));
        this.addIcons('<symbol id="iconWorkbenchPomodoro" viewBox="0 0 32 32"><text x="16" y="25" text-anchor="middle" font-size="27" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">🍅</text></symbol>');
        this.pomodoroDock=createPomodoroDockHost({
            register:callbacks=>this.addDock({id:'pomodoro',type:'pomodoro',config:{position:'RightBottom',size:{width:280,height:0},icon:'iconWorkbenchPomodoro',title:'番茄钟',show:false},data:{},...callbacks}),
            ready:this.workbenchReady,
            mount:model=>{
                const controller=mountPomodoroDock(model.element,{persistSnapshot:state=>this.writePomodoroSnapshot(state),onOpenWorkbench:()=>this.openWorkbench(),loadContext:()=>this.loadPomodoroContext(),getNotebookId:()=>this.selectedNotebookId});
                const refresh=()=>controller.refresh?.();
                this.workspaceRefreshers.add(refresh);this.dockContextRefreshers.add(refresh);
                return {dispose:()=>{this.workspaceRefreshers.delete(refresh);this.dockContextRefreshers.delete(refresh);controller.dispose();}};
            },
            onError:(error,model)=>{model.element.textContent='番茄钟加载失败：'+(error?.message||'请重新启用插件');},
        });
        this.workbenchHost = createNativeWorkbenchHost({
            register: callbacks => this.addTab({type:'workbench',...callbacks}),
            open: () => openTab({app:this.app,custom:{id:this.name+'workbench',icon:'iconCalendar',title:'工作台',data:{}}}),
            mount: model => this.mountWorkbenchTab(model),
            onError: (error,model) => {model.element.textContent=error?.message||'工作台加载失败';},
        });
        this.addIcons('<symbol id="iconWorkbenchTasks" viewBox="0 0 24 24"><path d="m2 7 2 2 4-5M2 17l2 2 4-5M11 7h10M11 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol><symbol id="iconWorkbenchReminders" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9zm-8 12a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>');
        this.recordDocks = [['planner','task','任务','iconWorkbenchTasks'],['reminders','reminder','提醒中心','iconWorkbenchReminders']].map(([id,kind,title,icon])=>createPomodoroDockHost({
            register:callbacks=>this.addDock({id,type:id,config:{position:'RightTop',size:{width:260,height:0},icon,title,show:false},data:{},...callbacks}),
            ready:this.workbenchReady,
            mount:model=>{
                const controller=mountRecordDock(model.element,{
                    kind,
                    getNotebookId:()=>this.selectedNotebookId,
                    listTasks:book=>new WorkbenchPlannerRepository(book).listTasks(),
                    listEvents:book=>new WorkbenchPlannerRepository(book).listEvents(),
                    onOpenRecord:(recordId,book)=>{
                        this.assertWorkspaceAvailable(book ?? this.selectedNotebookId);
                        return openTab({app:this.app,doc:{id:recordId},openNewTab:true});
                    },
                    onOpenWorkbench:()=>this.openWorkbench(id),
                });
                const refresh=()=>controller.refresh();
                this.workspaceRefreshers.add(refresh);this.dockContextRefreshers.add(refresh);
                return {dispose:()=>{this.workspaceRefreshers.delete(refresh);this.dockContextRefreshers.delete(refresh);controller.dispose();}};
            },
        }));
        this.addIcons(AGENT_DOCK_ICON);
        this.agentDock=createAgentDock({
            register:callbacks=>this.addDock({id:'agent',type:'agent',config:{position:'RightTop',size:{width:360,height:0},icon:'iconWorkbenchAgent',title:'Agent 助手',show:false},data:{},...callbacks}),
            ready:this.workbenchReady,
            getContext:()=>({notebookId:this.selectedNotebookId,notebookName:(window.siyuan?.notebooks||[]).find(book=>book.id===this.selectedNotebookId)?.name}),
            post:(path,body)=>fetchSyncPost(path,body,undefined,false),
            runWrite:(book,operation)=>this.runWorkspaceWrite(book,operation),
            assertAvailable:book=>this.assertWorkspaceAvailable(book),
            onOpenAttachment:path=>this.openTaskAttachment(path),
            onBusyChange:(busy,token)=>{if(busy)this.agentRuns.add(token);else this.agentRuns.delete(token);this.agentBusy=this.agentRuns.size>0;},
            onRecordChange:()=>this.notifyWorkspaceChange(),
            onOpenWorkbench:()=>this.openWorkbench('agent'),
            onError:(error,model)=>{model.element.textContent=error?.message||'Agent 助手加载失败，请重新打开侧栏。';},
        });
        this.dockContextRefreshers.add(this.agentDock.refresh);
        this.calendarHost = createNativeWorkbenchHost({
            register: callbacks => this.addTab({type:'calendar',...callbacks}),
            open: () => openTab({app:this.app,custom:{id:this.name+'calendar',icon:'iconCalendar',title:'日历',data:{}}}),
            mount: model => this.mountCalendarTab(model),
            onError: (error,model) => {model.element.textContent=error?.message||'日历加载失败';},
        });
        this.writeNotebookSelection = createSerialWriter(notebookId => saveCheckedData((name,value)=>this.saveData(name,value),SETTINGS_KEY,{notebookId}));
        this.writeAgentSelection = createSerialWriter(async ({notebookId, generation}) => {
            if (this.disposed || generation !== this.agentSyncGeneration || this.kernel?.state?.code !== 2) return null;
            return this.kernel.rpc.call.workbenchSetNotebook({notebookId: notebookId || null});
        });
        this.agentStatusElement = null;
        this.reminderClient = createReminderClient({
            clientId: `frontend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            claim: params => this.kernel.rpc.call.workbenchClaimReminders(params),
            ack: params => this.kernel.rpc.call.workbenchAckReminder(params),
            show: message => showMessage(message, 10000),
            getNotebookId: () => this.selectedNotebookId,
        });
        this.kernelStateListener = event => {
            const code = event?.detail?.code;
            if (code === 2) {
                if (this.hasLoadedNotebookSelection) void this.syncAgentNotebook(this.selectedNotebookId);
                else this.renderAgentStatus('等待工作台读取笔记本配置');
            } else {
                this.reminderClient.setEnabled(false);
                this.renderAgentStatus('暂不可用（Kernel 未运行），工作台仍可使用');
            }
        };
        this.eventBus.on('kernel-plugin-state-change', this.kernelStateListener);
        let settings = {};
        try { settings = await this.loadData(SETTINGS_KEY) || {}; } catch { /* Select a notebook from the workbench to recover. */ }
        if (this.disposed) return;
        try {
            const clock = await this.loadData(POMODORO_KEY);
            if (this.disposed) return;
            restorePomodoroState(clock);
        } catch { /* Invalid or unreadable timer state keeps the default idle clock. */ }
        if (this.disposed) return;
        this.selectedNotebookId = settings.notebookId || '';
        setPomodoroNotifier(message=>showMessage(message,10000));
        this.hasLoadedNotebookSelection = true;
        this.setting = new Setting({width:'min(1000px, 90vw)',destroyCallback:()=>{this.categoryOrganizer?.dispose();this.categoryOrganizer=null;this.supportDevelopment?.dispose();this.supportDevelopment=null;}});
        this.setting.addItem({title:'工作台数据位置',description:'确认保存后生效；切换笔记本不会搬动已有文档。',direction:'column',
            createActionElement: () => createNotebookSettingControl({document,
                getNotebooks:()=>window.siyuan?.notebooks||[],getValue:()=>this.selectedNotebookId,
                save:id=>this.saveNotebookSetting(id),
            }),
        });
        this.setting.addItem({title:'按分类整理已有任务与日程',description:'先预览目录，再确认整理。每批最多20条；保留文档ID、正文和附件，已完成的条目不会自动重放。',direction:'column',
            createActionElement:()=>{
                this.categoryOrganizer?.dispose();
                const container=document.createElement('div');let organizer=null,previewNotebookId='';
                const available=()=>!this.disposed&&!this.configurationSaving&&!this.agentBusy&&!this.workspaceWrites.size&&Boolean(this.selectedNotebookId)&&
                    (window.siyuan?.notebooks||[]).some(book=>book.id===this.selectedNotebookId&&!book.closed);
                const requireAvailable=()=>{if(!available())throw Object.assign(new Error('请先选择可用的数据笔记本，等待当前写入完成并停止 Agent，再整理分类。'),{commitState:'none'});};
                this.categoryOrganizer=mountCategoryOrganizer(container,{
                    isAvailable:available,getNotebookId:()=>this.selectedNotebookId,
                    plan:async()=>{
                        requireAvailable();const notebookId=this.selectedNotebookId;
                        const next=new CategoryOrganizerRepository(notebookId),result=await next.plan();
                        this.assertWorkspaceAvailable(notebookId);requireAvailable();organizer=next;previewNotebookId=notebookId;
                        return {...result,notebookName:(window.siyuan?.notebooks||[]).find(book=>book.id===notebookId)?.name||notebookId};
                    },
                    execute:item=>{
                        requireAvailable();if(!organizer||previewNotebookId!==this.selectedNotebookId)throw Object.assign(new Error('整理预览已失效，请重新预览。'),{commitState:'none'});
                        return this.runWorkspaceWrite(previewNotebookId,async()=>{
                            const result=await organizer.execute(item);
                            if(!this.disposed)this.notifyWorkspaceChange();return result;
                        });
                    },
                });return container;
            },
        });
        this.setting.addItem({title:'支持开发',description:'自愿支持后续维护，不影响任何功能。',direction:'column',createActionElement:()=>{
            this.supportDevelopment?.dispose();
            const host=document.createElement('div');
            this.supportDevelopment=mountSupportDevelopment(host);
            return host;
        }});
        this.resolveWorkbenchReady();
        this.disposeVisibleRefresh=createVisibleRefresh({document,
            onClock:()=>{if(!this.disposed)for(const refresh of this.workspaceClockRefreshers)refresh();},
            onResume:context=>{if(!context.isCurrent()||this.disposed||this.agentBusy||this.configurationSaving||this.hostModels().some(model=>hasWorkbenchDraft(model.element)))return;return this.notifyWorkspaceChange();},
        });
        this.addTopBar({
            icon: 'iconCalendar',
            title: '工作台',
            position: 'right',
            callback: () => this.openWorkbench(),
        });
        if (this.kernel?.state?.code === 2) void this.syncAgentNotebook(this.selectedNotebookId);
        this.recurrenceTimer=setInterval(()=>void this.runRecurrenceTick(),60_000);
        void this.runRecurrenceTick();
    }

    getToolboxManager(){
        if(this.disposed)throw new Error('插件已停止');
        if(!this.toolboxManager){
            const key=toolboxClientStorageKey({storage:window.localStorage,randomUUID:()=>globalThis.crypto.randomUUID()});
            this.toolboxManager=createToolboxManager({load:async()=>normalizeToolboxClientData(await this.loadData(key)),save:async state=>{if(this.disposed)throw new Error('插件已停止，工具配置未写入');const result=await this.saveData(key,state);if(result?.code&&result.code!==0)throw new Error('工具配置保存未确认，请重新加载核查');}});
        }
        return this.toolboxManager;
    }

    getSearchViewStore(notebookId){
        this.assertWorkspaceAvailable(notebookId);
        if(!this.searchViewStores.has(notebookId)){
            const clientKey=toolboxClientStorageKey({storage:window.localStorage,randomUUID:()=>globalThis.crypto.randomUUID()});
            const clientId=clientKey.slice('workbench-toolbox-'.length,-'.json'.length);
            const storage=createNativeSearchViewStorage({key:`workbench-search-${clientId}-${notebookId}.json`,getAppId:()=>this.app?.appId});
            const store=createSavedSearchStore({
                load:async()=>{this.assertWorkspaceAvailable(notebookId);const value=await storage.load();this.assertWorkspaceAvailable(notebookId);return value;},
                save:value=>this.runWorkspaceWrite(notebookId,()=>storage.save(value)),
                randomUUID:()=>globalThis.crypto.randomUUID(),
            });
            this.searchViewStores.set(notebookId,store);
        }
        return this.searchViewStores.get(notebookId);
    }

    async openSearchRecord(notebookId,id,path){
        this.assertWorkspaceAvailable(notebookId);
        if(typeof id!=='string'||!/^\d{14}-[a-z0-9]{7}$/.test(id))throw new Error('搜索结果文档标识无效，请重新搜索');
        const response=await fetchSyncPost('/api/block/getBlockInfo',{id},undefined,false);
        this.assertWorkspaceAvailable(notebookId);
        if(response?.code!==0||response.data?.box!==notebookId||response.data.rootID!==id)throw new Error('该文档已移动或不可读，请重新搜索');
        if(path!==undefined){
            if(!isAttachmentAssetPath(path))throw new Error('搜索结果不是有效的原生附件');
            const attrs=await fetchSyncPost('/api/attr/getBlockAttrs',{id},undefined,false);
            if(attrs?.code!==0)throw new Error('无法核对附件所属文档，请重新搜索');
            if(attrs.data?.['custom-workbench-type']==='task'&&attrs.data['custom-workbench-id']===id){
                const task=await new WorkbenchPlannerRepository(notebookId).get(id);
                if(!task.attachmentPaths?.includes(path))throw new Error('任务已解除该附件关联，请重新搜索');
            }else{
                const escaped=path.replaceAll("'","''");
                const refs=await fetchSyncPost('/api/query/sql',{mode:'readonly',stmt:`SELECT a.path FROM assets a JOIN blocks d ON d.id=a.root_id AND d.type='d' WHERE a.box='${notebookId}' AND d.box='${notebookId}' AND a.root_id='${id}' AND a.path='${escaped}' LIMIT 1`},undefined,false);
                if(refs?.code!==0||!Array.isArray(refs.data)||!refs.data.some(row=>row.path===path))throw new Error('该附件的当前文档引用已改变，请重新搜索');
            }
            this.assertWorkspaceAvailable(notebookId);
            return this.openTaskAttachment(path);
        }
        return openTab({app:this.app,doc:{id},openNewTab:true});
    }

    async runRecurrenceTick(){
        const book=this.selectedNotebookId;
        if(this.disposed||!book||this.configurationSaving)return;
        try{
            const result=await this.taskRecurrenceService.tick({notebookId:book});
            if(this.disposed||this.selectedNotebookId!==book)return;
            const message=result.errors?.length?'重复计划需要核查：'+result.errors.map(item=>item.message).join('；'):result.hasMore?'重复任务正在分批补齐，可在任务模板中查看计划。':'';
            if(message&&this.recurrenceNotices.get(book)!==message)showMessage(message);
            this.recurrenceNotices.set(book,message);
        }catch(error){
            if(this.disposed||this.configurationSaving||this.selectedNotebookId!==book)return;
            const message='重复计划暂未完成，请到任务模板核查：'+(error?.message||'读取失败');
            if(this.recurrenceNotices.get(book)!==message)showMessage(message);
            this.recurrenceNotices.set(book,message);
        }
    }

    onLayoutReady() {
        if (!this.disposed && this.hasLoadedNotebookSelection) void this.syncAgentNotebook(this.selectedNotebookId);
    }

    onDataChanged() {
        // Overriding the SDK default prevents storage notifications from
        // unloading the plugin and writing a new clock snapshot back to peers.
        // Keep the running clock and drafts; preferences are read explicitly
        // by their refresh actions or on the next normal plugin startup.
    }

    async onunload() {
        this.disposed = true;
        this.categoryOrganizer?.dispose();this.categoryOrganizer=null;
        this.supportDevelopment?.dispose();this.supportDevelopment=null;
        this.agentSyncGeneration += 1;
        this.reminderClient?.stop();
        this.disposeVisibleRefresh?.();
        this.resolveWorkbenchReady?.();
        this.pomodoroDock?.dispose();
        this.recordDocks?.forEach(dock=>dock.dispose());
        this.agentDock?.dispose();
        this.workbenchHost?.dispose();
        this.calendarHost?.dispose();
        clearInterval(this.recurrenceTimer);
        this.taskRecurrenceService?.dispose();
        this.searchViewStores?.clear();
        this.recurrenceRepositories?.clear();
        this.toolboxManager=null;
        this.workspaceRefreshers?.clear();
        this.workspaceClockRefreshers?.clear();
        this.dockContextRefreshers?.clear();
        this.calendarControllers?.clear();
        for (const loader of this.notebookLoaders) loader.dispose();
        this.notebookLoaders.clear();
        suspendPomodoro();
        this.eventBus.off('kernel-plugin-state-change', this.kernelStateListener);
        this.agentStatusElement = null;
        this.agentStatusElements?.clear();
        const finalClock=getPomodoroState();
        try { await saveCheckedData(()=>this.writePomodoroSnapshot(finalClock),POMODORO_KEY,finalClock,{timeoutMs:3000}); } catch { /* Cleanup above must not depend on storage availability. */ }
    }

    async openWorkbench(view) {
        if(this.disposed)return;
        if(view)this.requestedWorkbenchView=view;
        let result;
        try{result=await this.workbenchHost.open();}
        catch(error){if(this.requestedWorkbenchView===view)this.requestedWorkbenchView=null;throw error;}
        for(const host of this.workbenchHost.hosts.values()){
            if(!this.requestedWorkbenchView)break;
            const selected=host.selectView?.(this.requestedWorkbenchView);
            if(selected===undefined)continue;
            this.requestedWorkbenchView=null;
            if(!selected)showMessage('请先保存或取消正在编辑的内容，再打开所选页面');
            break;
        }
        return result;
    }

    async openCalendar(date) {
        if(this.disposed)return;
        if(date)this.calendarRequestedDate=date;
        const result=await this.calendarHost.open();
        if(date)for(const controller of this.calendarControllers)controller.selectDate(date);
        return result;
    }

    hostModels() {
        return [...(this.workbenchHost?.hosts?.keys()||[]),...(this.calendarHost?.hosts?.keys()||[])];
    }

    notifyWorkspaceChange() {
        if(this.disposed)return;
        return Promise.allSettled([...(this.workspaceRefreshers||[])].map(async refresh=>refresh()));
    }

    assertWorkspaceAvailable(notebookId) {
        const reject=message=>{throw Object.assign(new Error(message),{commitState:'none'});};
        if(this.disposed)reject('插件已关闭，请重新启用后操作');
        if(this.configurationSaving||notebookId!==this.selectedNotebookId)reject('数据位置已变化，请刷新后操作');
        if(!(window.siyuan?.notebooks||[]).some(book=>book.id===notebookId&&!book.closed))reject('数据笔记本已不可用，请检查插件设置');
    }

    async listWorkspaceCategories(notebookId,kind) {
        this.assertWorkspaceAvailable(notebookId);
        const categories=await readWorkbenchCategories({notebookId,kind,post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
        this.assertWorkspaceAvailable(notebookId);
        return categories;
    }

    async runWorkspaceWrite(notebookId,operation) {
        this.assertWorkspaceAvailable(notebookId);
        const token={};this.workspaceWrites.add(token);
        try{return await operation();}finally{this.workspaceWrites.delete(token);}
    }

    async deleteWorkbenchTask(repository,id,options) {
        const key=`${repository.notebookId}:${id}`;
        if(this.taskDeletions.has(key))return this.taskDeletions.get(key);
        const operation=this.runWorkspaceWrite(repository.notebookId,async()=>{
            if(this.agentBusy)throw Object.assign(new Error('请先等待或停止正在执行的 Agent，再删除任务'),{commitState:'none'});
            return deleteTaskAndRefresh({
                remove:()=>repository.deleteTask(id,options),
                isDisposed:()=>this.disposed,
                detachTarget:()=>detachPomodoroTask(repository.notebookId,id),
                persistClock:()=>this.writePomodoroSnapshot(getPomodoroState()),
                notify:()=>this.notifyWorkspaceChange(),
                onPersistenceError:()=>showMessage('任务已删除，专注关联已取消，但计时设置保存失败，请在专注页重新保存。',10000),
            });
        }).finally(()=>this.taskDeletions.delete(key));
        this.taskDeletions.set(key,operation);return operation;
    }

    async loadPomodoroContext() {
        const notebookId=this.selectedNotebookId;
        if(!notebookId)return {notebookId:'',notebookName:'未配置',tasks:[]};
        const book=(window.siyuan?.notebooks||[]).find(item=>item.id===notebookId&&!item.closed);
        if(!book)throw new Error('数据笔记本当前不可用，请在插件设置中检查');
        const tasks=await new WorkbenchPlannerRepository(notebookId).listTasks();
        if(this.disposed||notebookId!==this.selectedNotebookId)throw new Error('数据位置已变化，请刷新后重新选择任务');
        if(!(window.siyuan?.notebooks||[]).some(item=>item.id===notebookId&&!item.closed))throw new Error('数据笔记本已关闭，请重新选择');
        return {notebookId,notebookName:book.name||notebookId,tasks:tasks.filter(task=>task.status!=='done')};
    }

    async saveNotebookSetting(notebookId) {
        if(this.disposed)throw new Error('插件已关闭');
        if(this.configurationSaveUnconfirmed)throw new Error('上次笔记本设置保存结果未确认，请重新启用插件后核查，暂不继续写入设置');
        if(this.configurationSaving)throw new Error('设置正在保存，请稍后');
        if(notebookId && !(window.siyuan?.notebooks||[]).some(book=>book.id===notebookId&&!book.closed))throw new Error('该笔记本已不可用');
        if(notebookId===this.selectedNotebookId)return;
        if(this.workspaceWrites?.size)throw new Error('工作台正在保存或删除文档，请完成后再切换笔记本');
        if(this.agentBusy || this.hostModels().some(model=>hasWorkbenchDraft(model.element)))throw new Error('请先保存或取消工作台中未完成的编辑，并停止 Agent 对话，再切换笔记本');
        this.configurationSaving=true;
        for(const model of this.hostModels())model.element.inert=true;
        try {
            await this.writeNotebookSelection(notebookId);
            if(this.disposed)return;
            this.selectedNotebookId=notebookId;
            this.hasLoadedNotebookSelection=true;
            this.agentSyncGeneration+=1;
            this.reminderClient?.setEnabled(false);
            await this.syncAgentNotebook(notebookId);
            await Promise.all([...this.notebookLoaders].map(loader=>loader.load(notebookId)));
            await Promise.allSettled([...(this.dockContextRefreshers||[])].map(async refresh=>refresh()));
        } catch(error) {
            if(error?.commitState==='unknown')this.configurationSaveUnconfirmed=true;
            throw error;
        } finally {
            this.configurationSaving=false;
            for(const model of this.hostModels())model.element.inert=false;
            this.categoryOrganizer?.refreshAvailability();
        }
    }

    async mountWorkbenchTab(model) {
        await this.workbenchReady;
        if(this.disposed || !this.workbenchHost.isAlive(model))return;
        const savedId=(window.siyuan?.notebooks||[]).some(book=>book.id===this.selectedNotebookId&&!book.closed)?this.selectedNotebookId:'';
        let cleanup = null;
        const refresh=()=>cleanup?.refreshViews();
        this.workspaceRefreshers.add(refresh);
        const clock=()=>cleanup?.refreshClock?.();this.workspaceClockRefreshers.add(clock);
        let notebookLoader = null;
        model.element.innerHTML='<div class="swb-host"><header class="swb-location" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 18px;border-bottom:1px solid var(--b3-border-color)"><span data-workbench-location></span><button type="button" class="b3-button b3-button--text" data-workbench-settings>设置</button><span class="swb-agent-status" role="status" aria-live="polite" style="padding:0;flex:1"></span></header><div class="swb-workspace"></div></div>';
        const mount = model.element.querySelector('.swb-workspace');
        const agentStatus = model.element.querySelector('.swb-agent-status');
        this.agentStatusElements.add(agentStatus);
        const onSettings=()=>this.openSetting();
        model.element.querySelector('[data-workbench-settings]').addEventListener('click',onSettings);
        this.renderAgentStatus(this.kernel?.state?.code === 2
            ? (savedId ? '正在同步所选笔记本…' : '请选择笔记本以启用今日任务查询')
            : '暂不可用（Kernel 未运行），工作台仍可使用');
        notebookLoader = createNotebookLoader({
          onSelect: notebookId => {
            const book=(window.siyuan?.notebooks||[]).find(item=>item.id===notebookId);
            model.element.querySelector('[data-workbench-location]').textContent='数据位置：'+(book?.name||'未配置');
            this.renderAgentStatus(this.selectedNotebookId
                ? '正在同步所选笔记本…'
                : '请选择笔记本以启用今日任务查询');
            cleanup?.();
            cleanup = null;
            mount.innerHTML = '';
            if (notebookId) mount.innerHTML = '<div class="swb-onboarding">正在读取工作台记录…</div>';
          },
          persist: async notebookId => {
                if (!this.disposed && this.selectedNotebookId === notebookId) void this.syncAgentNotebook(notebookId);
          },
          read: async notebookId => {
                if (!notebookId) return null;
                const repository = new WorkbenchRepository(notebookId);
                const selectedDate = localDate(new Date());
                const [tasks, events] = await Promise.all([
                    repository.list('task', dayRange(selectedDate)),
                    repository.list('event', dayRange(selectedDate)),
                ]);
                return {repository, selectedDate, tasks, events};
          },
          apply: data => {
                if (!data) {
                    mount.innerHTML = '<div class="swb-onboarding">请点击上方“设置”，选择并保存数据笔记本后开始使用。已有文档不会随设置变更搬动。</div>';
                    return;
                }
                const {repository, selectedDate, tasks, events} = data;
                mount.innerHTML = '';
                const notesRepository = new WorkbenchNotesRepository(repository.notebookId);
                const plannerRepository = new WorkbenchPlannerRepository(repository.notebookId);
                const listCategories = kind => this.listWorkspaceCategories(repository.notebookId,kind);
                let suspendArrangementRefresh=0;
                const recordActions=createWorkbenchRecordActions({
                    repository,planner:plannerRepository,
                    runWrite:(notebookId,operation)=>this.runWorkspaceWrite(notebookId,operation),
                    flush:async()=>{const result=await fetchSyncPost('/api/sqlite/flushTransaction',{},undefined,false);if(result?.code!==0)throw new Error(result?.msg||'思源未确认写入队列');},
                    isDisposed:()=>this.disposed,
                    onChanged:()=>{if(!suspendArrangementRefresh)this.notifyWorkspaceChange();},
                });
                const arrangements=createTaskArrangementService({getTask:id=>plannerRepository.get(id),patchTask:recordActions.patchTask,isDisposed:()=>this.disposed||!this.workbenchHost.isAlive(model)||this.selectedNotebookId!==repository.notebookId});
                const executeTaskBatch=async plan=>{suspendArrangementRefresh++;try{return await arrangements.execute(plan);}finally{suspendArrangementRefresh--;if(!this.disposed)this.notifyWorkspaceChange();}};
                const jobRepository = new AgentJobRepository(repository.notebookId);
                let taskPage,projectPage,sideNavigation=0;
                const bodyRepository=createTaskBodyRepository({
                    notebookId:repository.notebookId,
                    post:(path,body)=>fetchSyncPost(path,body,undefined,false),
                    getTask:id=>plannerRepository.get(id),
                });
                const openTaskPage=async id=>{
                    const request=++sideNavigation;
                    if(projectPage.isOpen()&&!await projectPage.close())return false;
                    return request===sideNavigation&&taskPage.open(id,{trigger:document.activeElement});
                };
                const openProjectPage=async(id,{trigger}={})=>{
                    const request=++sideNavigation;
                    if(taskPage.isOpen()&&!await taskPage.close())return false;
                    return request===sideNavigation&&projectPage.open(id,{trigger:trigger||document.activeElement});
                };
                const jobRunner = createAgentJobRunner({repository:jobRepository,client:createEditorAIClient(),plannerRepository,workbenchRepository:repository});
                const batchRunner = createJobBatch({repository:jobRepository,runner:jobRunner});
                const delegate=task=>cleanup?.createAgentJob(task);
                const treeBook=repository.notebookId;
                const tree=createDocumentTreeRepository({notebookId:treeBook,post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
                const documentTree={
                    notebookId:treeBook,
                    list:async path=>{
                        this.assertWorkspaceAvailable(treeBook);
                        const rows=await tree.list(path);
                        this.assertWorkspaceAvailable(treeBook);
                        return rows;
                    },
                    open:async id=>{
                        this.assertWorkspaceAvailable(treeBook);
                        await tree.assertDocument(id);
                        this.assertWorkspaceAvailable(treeBook);
                        return openTab({app:this.app,doc:{id},openNewTab:true});
                    },
                    create:(id,draft)=>this.runWorkspaceWrite(treeBook,()=>{
                        if(window.siyuan?.config?.readonly || window.siyuan?.config?.editor?.readOnly)throw new Error('当前思源工作区为只读');
                        return tree.create(id,draft);
                    }),
                };
                const mounted = mountWorkbenchShell(mount, {mountDay: mountWorkbench, documentTree, dayOptions: {
                    date: selectedDate,
                    tasks,
                    events,
                    listCategories,
                    showReviewOverview:true,
                    loadOverview: async () => {const [tasks,events,reviews]=await Promise.all([plannerRepository.listTasks(),plannerRepository.listEvents(),jobRepository.list().then(jobs=>({jobs}),error=>({reviewError:error.message}))]);return {tasks,events,...reviews};},
                    onOverviewSelect: key => key==='awaitingReviewJobs'?cleanup?.selectAgentJobsState('awaiting_review'):key==='todayEvents'?this.openCalendar(localDate(new Date())):cleanup?.selectPlannerView({todayTasks:'today',overdueTasks:'overdue',unscheduledTasks:'unscheduled'}[key],{unfinishedOnly:true}),
                    onOpenCalendar: date => this.openCalendar(date),
                    onDelegateTask:delegate,
                    onOpenAgentJob:id=>cleanup?.openAgentJob(id),
                    onSave: recordActions.saveRecord,
                    onOpenTask:openTaskPage,
                    onCreateProject:async()=>{
                        ++sideNavigation;
                        if(!await taskPage.close()||!await projectPage.close())return false;
                        return cleanup.openNewProject();
                    },
                    onUploadAttachments:createTaskAttachmentUploader({post:(path,body)=>fetchSyncPost(path,body,undefined,false)}),
                    onOpenAttachment:path=>this.openTaskAttachment(path),
                    onCreateNote: () => this.runWorkspaceWrite(repository.notebookId,()=>this.nativeNoteOpener.open(repository.notebookId)),
                    onDeleteTask: task => this.deleteWorkbenchTask(plannerRepository,task.id,{expectedUpdatedAt:task.updatedAt}),
                    onPatchTask: recordActions.patchTask,
                    onDateChange: async date => {
                        const [tasks, events] = await Promise.all([
                            repository.list('task', dayRange(date)),
                            repository.list('event', dayRange(date)),
                        ]);
                        return {tasks, events};
                    },
                    onMonthChange: async month => {
                        const range = monthRange(month);
                        const [tasks, events] = await Promise.all([
                            repository.list('task', range),
                            repository.list('event', range),
                        ]);
                        return {tasks, events};
                    },
                    onNotify: message => showMessage(message),
                }, notesOptions: {
                    listNotes: () => notesRepository.list(),
                    updateMetadata: (id, metadata) => notesRepository.updateMetadata(id, metadata),
                    onOpenNote: async id => {
                        await openTab({app: this.app, doc: {id}, openNewTab: true});
                    },
                }, views: [{id:'projects',label:'项目',description:'在原生数据库中管理项目，从工作台直达项目文档。',mount:panel=>{
                    const notebookId=repository.notebookId;
                    const key=`workbench-projects-${notebookId}.json`;
                    const projects=createWorkbenchProjects({
                        notebookId,post:(path,body)=>fetchSyncPost(path,body,undefined,false),
                        isReadOnly:()=>Boolean(window.siyuan?.config?.readonly || window.siyuan?.config?.editor?.readOnly),
                    });
                    const list=async binding=>{
                        this.assertWorkspaceAvailable(notebookId);
                        const result=await projects.list(binding);
                        this.assertWorkspaceAvailable(notebookId);
                        return result;
                    };
                    return mountProjects(panel,{
                        notebookId,
                        createDatabase:()=>this.runWorkspaceWrite(notebookId,async()=>{
                            const binding=await projects.createDatabase();
                            await list(binding);
                            await saveCheckedData((name,value)=>this.saveData(name,value),key,binding);
                            return binding;
                        }),
                        updateProject:(binding,change)=>this.runWorkspaceWrite(notebookId,()=>projects.update(binding,change)),
                        loadBinding:async()=>{
                            this.assertWorkspaceAvailable(notebookId);
                            const binding=await this.loadData(key);
                            this.assertWorkspaceAvailable(notebookId);
                            return binding?.avId ? binding : null;
                        },
                        saveBinding:input=>this.runWorkspaceWrite(notebookId,async()=>{
                            const binding=await projects.resolve(input);
                            await list(binding);
                            await saveCheckedData((name,value)=>this.saveData(name,value),key,binding);
                            return binding;
                        }),
                        list,
                        create:(binding,draft)=>this.runWorkspaceWrite(notebookId,()=>projects.create(binding,draft)),
                        onOpenProject:openProjectPage,
                        onOpenDocument:async id=>{
                            this.assertWorkspaceAvailable(notebookId);
                            const result=await fetchSyncPost('/api/block/getBlockInfo',{id},undefined,false);
                            this.assertWorkspaceAvailable(notebookId);
                            if(result?.code!==0||result.data?.box!==notebookId||result.data.rootID!==id)throw new Error('该项目文档已移动或不可读，请刷新项目列表');
                            await openTab({app:this.app,doc:{id},openNewTab:true});
                            cleanup?.selectDocument(id);
                        },
                    });
                }},{id:'search',label:'统一搜索',description:'搜索当前笔记本的任务、日程、笔记与附件名称。',mount:panel=>{
                    const nativeRepository=createNativeSearchRepository({notebookId:repository.notebookId,post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
                    const search=createUnifiedSearchService({listTasks:()=>plannerRepository.listTasks(),listEvents:()=>plannerRepository.listEvents(),nativeRepository});
                    let store;
                    return mountUnifiedSearch(panel,{
                        search:async criteria=>{this.assertWorkspaceAvailable(repository.notebookId);const result=await search.search(criteria);this.assertWorkspaceAvailable(repository.notebookId);return result;},
                        loadViews:()=>{store ||= this.getSearchViewStore(repository.notebookId);return store.reload();},
                        saveView:input=>{store ||= this.getSearchViewStore(repository.notebookId);return store.upsert(input);},
                        deleteView:id=>{store ||= this.getSearchViewStore(repository.notebookId);return store.remove(id);},
                        onOpenRecord:id=>this.openSearchRecord(repository.notebookId,id),
                        onOpenAttachment:(path,id)=>this.openSearchRecord(repository.notebookId,id,path),
                    });
                }},{id:'toolbox',label:'工具箱',heading:'扩展工具箱',description:'统一工具目录，按需安装，工具在这里打开。',autoRefresh:false,mount:panel=>{
                    try{return mountToolbox(panel,{manager:this.getToolboxManager()});}
                    catch(error){panel.textContent=error?.message||'工具箱无法加载';return {dispose(){}};}
                }},{id:'task-templates',label:'任务模板',heading:'任务模板与重复计划',description:'复用常用任务，每期工作独立保留。',autoRefresh:false,mount:panel=>{
                    const templates=createTaskTemplateRepository({notebookId:repository.notebookId,post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
                    const guarded={list:options=>templates.list(options),get:id=>templates.get(id),upsert:(input,options)=>this.runWorkspaceWrite(repository.notebookId,()=>templates.upsert(input,options)),archive:(id,options)=>this.runWorkspaceWrite(repository.notebookId,()=>templates.archive(id,options))};
                    return mountTaskTemplateCenter(panel,{templates:guarded,recurrence:this.taskRecurrenceService,notebookId:repository.notebookId,listCategories,showHeading:false,onCreateTask:fields=>cleanup.openNewTask(fields),onRecordChange:()=>this.notifyWorkspaceChange()});
                }},{id:'planner', label:'任务与周计划',description:'把待办排进这一周。', mount: panel => mountPlanner(panel, {
                    notebookId:repository.notebookId,
                    listCategories,
                    listTasks: () => plannerRepository.listTasks(),
                    listEvents: () => plannerRepository.listEvents(),
                    patchTask: recordActions.patchTask,
                    previewTaskBatch:(ids,patch)=>arrangements.preview(ids,patch),
                    executeTaskBatch,
                    deleteTask: (id, options) => this.deleteWorkbenchTask(plannerRepository,id,options),
                    onDelegateTask:delegate,
                    onFocusTask: async task => {
                        const state = getPomodoroState();
                        if (!['idle','finished'].includes(state.status)) throw new Error('请先重置当前专注，再选择其他任务');
                        configurePomodoro({...getPomodoroConfiguration(),target:{notebookId:repository.notebookId,id:task.id,title:task.title}});
                        try {await this.writePomodoroSnapshot(getPomodoroState());}
                        catch {throw new Error('专注目标已应用，但保存失败，重新启用插件时可能丢失，请到专注页重新保存');}
                        cleanup.select('focus');
                    },
                    onOpenRecord:openTaskPage,
                })}, {id:'reminders',label:'提醒中心',description:'统一安排任务和日程的提醒时间。',mount: panel => mountReminderCenter(panel, {
                    listTasks: () => plannerRepository.listTasks(),
                    listEvents: () => plannerRepository.listEvents(),
                    patchReminder: async (id, patch) => {const saved=await plannerRepository.patchReminder(id, patch);this.notifyWorkspaceChange();return saved;},
                    onOpenRecord: async id => {
                        await openTab({app:this.app,doc:{id},openNewTab:true});
                    },
                })}, {id:'focus',label:'专注',heading:'专注与休息',description:'选择一件事，为它留出专注时间。',mount: panel => mountFocusControls(panel, {
                    notebookId: repository.notebookId,
                    listTasks: () => plannerRepository.listTasks(),
                    persistSnapshot: state => this.writePomodoroSnapshot(state),
                })}, {id:'commodity-incidents',label:'商品异常台账',description:'按次记录禁售与整改，凭证、时间线和处理结果保存在事件原文。',mount:panel=>mountCommodityIncidents(panel,{
                    repository:new CommodityIncidentRepository(repository.notebookId,{
                        post:(path,body)=>fetchSyncPost(path,body,undefined,false),
                        runWrite:operation=>this.runWorkspaceWrite(repository.notebookId,operation),
                    }),
                    onOpenRecord:id=>openTab({app:this.app,doc:{id},openNewTab:true}),
                    onCreateTask:fields=>{
                        if(!cleanup.openNewTask(fields))throw new Error('请先保存或取消正在编辑的任务');
                    },
                })}, {id:'agent',label:'Agent 助手',mount: panel => {
                    const client=createNativeAgentClient();
                    const upload=createTaskAttachmentUploader({post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
                    const prepareAttachments=createChatAttachmentPreparer(files=>this.runWorkspaceWrite(repository.notebookId,()=>upload(files)),()=>this.assertWorkspaceAvailable(repository.notebookId));
                    const runToken={};
                    return mountAgentWorkspace(panel, {
                        notebookId:repository.notebookId,
                        notebookName:(window.siyuan?.notebooks||[]).find(book=>book.id===repository.notebookId)?.name||'当前笔记本',
                        chat:(input,options)=>client.chat(input,options),
                        prepareAttachments,
                        onOpenAttachment:path=>this.openTaskAttachment(path),
                        confirm:(id,approved)=>client.confirm(id,approved),
                        answerQuestion:(id,answers)=>client.answerQuestion(id,answers),
                        onBusyChange:busy=>{if(busy)this.agentRuns.add(runToken);else this.agentRuns.delete(runToken);this.agentBusy=this.agentRuns.size>0;},
                        onRecordChange:()=>this.notifyWorkspaceChange(),
                    });
                }}, {id:'jobs',label:'Agent 委托',description:'交给助手整理，成果由你拍板。',mount:panel=>{
                    const runToken={};
                    return mountAgentJobs(panel,{repository:jobRepository,runner:jobRunner,batchRunner,prepareWeekly:async({from,to})=>{
                        const range=reportRange(from,to);
                        const [tasks,events]=await Promise.all([plannerRepository.listTasks(),plannerRepository.listEvents()]);
                        const snapshot=workReportSnapshot(tasks,events,range);
                        const referenceIds=[...new Set(['completed','reopened','rescheduled','overdue','events'].flatMap(key=>snapshot[key].map(record=>record.id)))];
                        if(referenceIds.length>1000)throw new Error('事实底稿超过1000项来源，请缩小范围后整理');
                        return {title:`工作周报 ${from} 至 ${to}`,objective:WORK_TEMPLATES.weekly.goal,pastedMaterial:formatWorkReport(snapshot),referenceIds};
                    },listTasks:()=>plannerRepository.listTasks(),listMaterials:()=>notesRepository.list(),onOpenRecord:id=>openTab({app:this.app,doc:{id},openNewTab:true}),onBusyChange:busy=>{if(busy)this.agentRuns.add(runToken);else this.agentRuns.delete(runToken);this.agentBusy=this.agentRuns.size>0;},onRecordChange:()=>this.notifyWorkspaceChange()});
                }}, {id:'diagnostics',label:'运行检查',description:'确认数据是否可读，找到需要继续处理的工作。',autoRefresh:false,mount:panel=>mountDiagnostics(panel,{
                    load:async()=>{
                        const results=await Promise.allSettled([plannerRepository.listTasks(),plannerRepository.listEvents(),notesRepository.list(),jobRepository.list(),fetchSyncPost('/api/system/version',{},undefined,false)]);
                        const names=['任务','日程','笔记','Agent 委托'];
                        const arrays=results.slice(0,4).map(result=>result.status==='fulfilled'&&Array.isArray(result.value)?result.value:null);
                        const checks=names.map((label,index)=>({label,status:arrays[index]?'ok':'error',...(arrays[index]?{count:arrays[index].length}:{detail:'读取未完成，请检查笔记本、记录格式和原生文档位置后重试。'})}));
                        checks.push({label:'Kernel 插件',status:this.kernel?.state?.code===2?'ok':'error',detail:this.kernel?.state?.code===2?'当前已运行；提醒仍依赖应用运行。':'当前未运行，请检查插件信任与启用状态。'});
                        const [tasks,,,jobs]=arrays;
                        const versionResult=results[4].status==='fulfilled'?results[4].value:null;
                        return {version:WORKBENCH_VERSION,appVersion:versionResult?.code===0?versionResult.data:'未知',notebook:{id:repository.notebookId,name:(window.siyuan?.notebooks||[]).find(book=>book.id===repository.notebookId)?.name||'当前笔记本'},checks,
                            jobs:jobs?{awaiting_review:jobs.filter(job=>job.state==='awaiting_review').length,needs_input:jobs.filter(job=>job.state==='needs_input').length,failed:jobs.filter(job=>job.state==='failed').length,running:jobs.filter(job=>['queued','validating','running'].includes(job.state)).length}:{},
                            history:tasks?{totalTasks:tasks.length,unknownCompletion:tasks.filter(task=>task.status==='done'&&!Number.isFinite(Date.parse(task.completedAt))).length}:{},
                            notes:['已验证 Windows、SiYuan 3.8.9 Kernel 与 browser-desktop；其他平台以实际验收为准。','本页仅检查读取状态，不调用模型、批准工具或重跑委托。','记录保存在普通思源文档；关闭、禁用和卸载插件不会删除业务文档。'],
                        };
                    },onOpenJobs:state=>cleanup?.selectAgentJobsState(state==='running'?'active':state),
                })}]} );
                taskPage=mountRecordPage(mount,{
                    loadRecord:id=>this.runWorkspaceWrite(repository.notebookId,()=>bodyRepository.ensure(id)),
                    createPropertiesEditor:(element,{record,onSaved})=>mounted.mountTaskEditor(element,record,{onSaved,onCancel:()=>taskPage.close()}),
                    createEditor:(element,{record})=>createNativeTaskEditor(this.app,element,record,error=>showMessage(error?.message||'正文保存未确认，请重新打开核查')),
                    beforeClose:async({editor})=>{
                        await editor?.flush();
                        const result=await fetchSyncPost('/api/sqlite/flushTransaction',{},undefined,false);
                        if(result?.code!==0)throw new Error(result?.msg||'无法确认正文保存，请重试');
                    },
                    onOpenNative:async id=>{
                        const record=await bodyRepository.ensure(id);
                        openTab({app:this.app,doc:{id:record.bodyId},openNewTab:true});
                    },
                    onClosed:()=>this.notifyWorkspaceChange(),
                });
                projectPage=mountProjectPage(mount,{
                    loadRecord:async id=>{
                        this.assertWorkspaceAvailable(repository.notebookId);
                        const binding=await this.loadData(`workbench-projects-${repository.notebookId}.json`);
                        const projects=createWorkbenchProjects({notebookId:repository.notebookId,post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
                        const snapshot=await projects.list(binding);
                        const project=snapshot.projects.find(row=>row.documentId===id);
                        const info=await fetchSyncPost('/api/block/getBlockInfo',{id},undefined,false);
                        this.assertWorkspaceAvailable(repository.notebookId);
                        if(!project||info?.code!==0||info.data?.box!==repository.notebookId||info.data.rootID!==id)throw new Error('项目已移出当前项目库或文档不可读，请刷新项目列表。');
                        await this.runWorkspaceWrite(repository.notebookId,()=>prepareProjectBody({notebookId:repository.notebookId,avId:binding.avId,documentId:id,post:(path,body)=>fetchSyncPost(path,body,undefined,false)}));
                        return {...project,bodyId:id};
                    },
                    createEditor:(element,{record})=>createNativeTaskEditor(this.app,element,record,error=>showMessage(error?.message||'项目正文保存未确认，请重新打开核查')),
                    beforeClose:async({editor})=>{
                        await editor?.flush();
                        const result=await fetchSyncPost('/api/sqlite/flushTransaction',{},undefined,false);
                        if(result?.code!==0)throw new Error(result?.msg||'无法确认项目正文保存，请重试。');
                    },
                    onOpenNative:id=>this.openSearchRecord(repository.notebookId,id),
                    onClosed:()=>this.notifyWorkspaceChange(),
                });
                cleanup=Object.assign(()=>{++sideNavigation;projectPage.dispose();taskPage.dispose();arrangements.dispose();mounted();},mounted);
                if(this.requestedWorkbenchView&&cleanup.select(this.requestedWorkbenchView))this.requestedWorkbenchView=null;
          },
          onError: error => {
                mount.innerHTML = `<div class="swb-onboarding swb-onboarding--error">${escapeHTML(error?.message || '读取失败')}<br>请确认所选笔记本可写，然后重新打开工作台。</div>`;
          },
          onDispose: () => { cleanup?.(); cleanup = null; },
        });
        this.notebookLoaders.add(notebookLoader);
        let closed=false;
        const disposeTab = () => {
            if(closed)return;closed=true;
            notebookLoader.dispose();this.notebookLoaders.delete(notebookLoader);
            this.workspaceRefreshers.delete(refresh);
            this.workspaceClockRefreshers.delete(clock);
            this.agentStatusElements.delete(agentStatus);
            model.element.querySelector('[data-workbench-settings]')?.removeEventListener('click',onSettings);
        };
        const host=this.workbenchHost.hosts.get(model);
        host.cleanup=disposeTab;
        host.selectView=view=>cleanup?.select(view);
        await notebookLoader.load(savedId);
        return disposeTab;
    }

    async mountCalendarTab(model) {
        await this.workbenchReady;
        if(this.disposed||!this.calendarHost.isAlive(model))return;
        model.element.innerHTML='<div class="swb-calendar-host"><header class="swb-location" style="display:flex;align-items:center;gap:12px;padding:8px 18px;border-bottom:1px solid var(--b3-border-color)"><span data-calendar-location></span><button type="button" class="b3-button b3-button--text" data-calendar-settings>设置</button></header><div data-calendar-mount></div></div>';
        const mount=model.element.querySelector('[data-calendar-mount]');
        const settings=model.element.querySelector('[data-calendar-settings]');
        const onSettings=()=>this.openSetting();settings.addEventListener('click',onSettings);
        let controller=null,arrangements=null;
        const refresh=()=>controller?.refresh();this.workspaceRefreshers.add(refresh);
        const clock=()=>controller?.refreshClock?.();this.workspaceClockRefreshers.add(clock);
        const release=()=>{arrangements?.dispose();arrangements=null;if(controller){this.calendarControllers.delete(controller);controller.dispose();controller=null;}};
        const loader=createNotebookLoader({
            onSelect:id=>{release();const book=(window.siyuan?.notebooks||[]).find(item=>item.id===id);model.element.querySelector('[data-calendar-location]').textContent='数据位置：'+(book?.name||'未配置');mount.textContent='正在读取日历…';},
            persist:async()=>{},
            read:async id=>id?new WorkbenchPlannerRepository(id):null,
            apply:repository=>{
                if(!repository){mount.innerHTML='<div class="swb-onboarding">请在插件设置中选择并保存数据笔记本。</div>';return;}
                const actions=createCalendarActions({
                    repository:new WorkbenchRepository(repository.notebookId),planner:repository,
                    runWrite:(notebookId,operation)=>this.runWorkspaceWrite(notebookId,operation),
                    flush:async()=>{const result=await fetchSyncPost('/api/sqlite/flushTransaction',{},undefined,false);if(result?.code!==0)throw new Error(result?.msg||'思源未确认写入队列');},
                    isDisposed:()=>this.disposed,
                    onChanged:()=>this.notifyWorkspaceChange(),
                    canDelete:()=>{if(this.agentBusy)throw Object.assign(new Error('请先等待或停止正在执行的 Agent，再删除日程'),{commitState:'none'});},
                });
                const taskActions=createWorkbenchRecordActions({repository:new WorkbenchRepository(repository.notebookId),planner:repository,runWrite:(book,operation)=>this.runWorkspaceWrite(book,operation),flush:async()=>{const result=await fetchSyncPost('/api/sqlite/flushTransaction',{},undefined,false);if(result?.code!==0)throw new Error(result?.msg||'思源未确认写入队列');},isDisposed:()=>this.disposed,onChanged:()=>this.notifyWorkspaceChange()});
                const taskArrangements=createTaskArrangementService({getTask:id=>repository.get(id),patchTask:taskActions.patchTask,isDisposed:()=>this.disposed||!this.calendarHost.isAlive(model)||this.selectedNotebookId!==repository.notebookId});
                arrangements=taskArrangements;
                controller=mountCalendarWorkspace(mount,{...actions,
                    listCategories:kind=>this.listWorkspaceCategories(repository.notebookId,kind),
                    moveTask:(id,date,options)=>taskArrangements.move(id,date,options),
                    undoTaskMove:token=>taskArrangements.undo(token),
                    verifyEventCategory:async record=>{
                        this.assertWorkspaceAvailable(repository.notebookId);
                        const location=await assertWorkbenchLocation({notebookId:repository.notebookId,id:record.id,kind:'event',post:(path,body)=>fetchSyncPost(path,body,undefined,false)});
                        if(!location.categoryFolderId||location.category!==normalizeCategory(record.category))throw new Error('分类归档尚未确认，请在插件设置中预览并整理该日程。');return true;
                    },
                    listTasks:()=>repository.listTasks(),listEvents:()=>repository.listEvents(),initialDate:this.calendarRequestedDate||localDate(new Date()),onOpenRecord:id=>openTab({app:this.app,doc:{id},openNewTab:true})});
                this.calendarControllers.add(controller);
            },
            onError:error=>{mount.textContent='读取失败：'+(error?.message||'请重新打开日历');},
            onDispose:release,
        });
        this.notebookLoaders.add(loader);
        let closed=false;
        const dispose=()=>{if(closed)return;closed=true;loader.dispose();this.notebookLoaders.delete(loader);this.workspaceRefreshers.delete(refresh);this.workspaceClockRefreshers.delete(clock);settings.removeEventListener('click',onSettings);};
        this.calendarHost.hosts.get(model).cleanup=dispose;
        await loader.load(this.selectedNotebookId);
        return dispose;
    }

    async syncAgentNotebook(notebookId) {
        if (this.disposed) return false;
        const generation = (this.agentSyncGeneration || 0) + 1;
        this.agentSyncGeneration = generation;
        this.reminderClient?.setEnabled(false);
        if (this.kernel?.state?.code !== 2) {
            this.renderAgentStatus('暂不可用（Kernel 未运行），工作台仍可使用');
            return false;
        }
        try {
            const result = await this.writeAgentSelection({notebookId, generation});
            if (this.disposed || generation !== this.agentSyncGeneration) return false;
            if (Boolean(result?.configured) !== Boolean(notebookId) || result?.notebookId !== (notebookId || null)) {
                throw new Error('Kernel 未确认笔记本配置');
            }
            this.renderAgentStatus(notebookId
                ? '笔记本已同步；所需能力需在思源 Agent 能力设置启用，写操作仍遵循审批策略'
                : '请选择笔记本以启用今日任务查询');
            this.reminderClient?.setEnabled(Boolean(notebookId));
            return true;
        } catch (error) {
            if (generation === this.agentSyncGeneration) {
                this.renderAgentStatus(`同步失败：${error?.message || 'Kernel RPC 不可用'}；工作台仍可使用`);
            }
            return false;
        }
    }

    renderAgentStatus(message) {
        for(const element of this.agentStatusElements||[])if(element.isConnected){element.textContent=`内置 Agent：${message}`;element.title=element.textContent;}
    }
}

function dayRange(date) {
    const [year, month, day] = date.split('-').map(Number);
    const from = new Date(year, month - 1, day);
    const to = new Date(year, month - 1, day + 1);
    to.setMilliseconds(to.getMilliseconds() - 1);
    return {from: from.toISOString(), to: to.toISOString()};
}
function monthRange(month) {
    const [year, monthNumber] = month.split('-').map(Number);
    const from = new Date(year, monthNumber - 1, 1);
    from.setDate(from.getDate() - (from.getDay() + 6) % 7);
    const to = new Date(from);
    to.setDate(to.getDate() + 42);
    to.setMilliseconds(-1);
    return {from: from.toISOString(), to: to.toISOString()};
}
function localDate(date) { const y = date.getFullYear(); const m = String(date.getMonth() + 1).padStart(2, '0'); const d = String(date.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
function escapeHTML(value = '') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttribute(value = '') { return escapeHTML(value); }
function reportRange(from,to) {
    const parse=value=>{const date=new Date(`${value}T00:00:00`);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(date.getTime())||localDate(date)!==value)throw new Error('请选择有效的周报起止日期');return date;};
    const start=parse(from),end=parse(to);end.setDate(end.getDate()+1);
    if(end<=start||end-start>93*24*60*60*1000)throw new Error('周报周期需为1至93天');
    return {from:start.toISOString(),to:end.toISOString()};
}
