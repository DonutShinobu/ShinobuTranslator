import type { UiLocale } from '@shinobu/shared-config';
import type { ImageImportRejectionCode } from './features/import/imageImporter';

export type AppCopy = {
  appSubtitle: string;
  workbench: string;
  history: string;
  historyTitle: string;
  historySubtitle: string;
  historyRefresh: string;
  historyImportProject: string;
  historyExportResults: string;
  historyExportProject: string;
  historyExportWarning: string;
  historyLoading: string;
  historyEmptyTitle: string;
  historyEmptyBody: string;
  historyStorageError: string;
  historyBatchImages: (count: number) => string;
  historyBatchStatus: (status: 'running' | 'paused' | 'completed' | 'failed') => string;
  historyPartial: string;
  historyModelVersion: string;
  historyDownloadResult: string;
  historyNoResult: string;
  historyClone: string;
  historyResume: string;
  historyResumeReady: string;
  historyExitResume: string;
  historyResultsOnly: string;
  historyKeepResults: string;
  historyKeepResultsWarning: string;
  historyDelete: string;
  historyDeletePending: string;
  historyUndoDelete: string;
  settings: string;
  settingsTitle: string;
  settingsSubtitle: string;
  settingsLocked: string;
  interfaceLanguage: string;
  providerSettingsTitle: string;
  providerSettingsDetail: string;
  openProviderSettings: string;
  storageTitle: string;
  storageDetail: string;
  storageChecking: string;
  storageUnavailable: string;
  storageUsage: (usage: string, quota: string) => string;
  storageAvailable: (available: string) => string;
  storagePersistent: string;
  storageTemporary: string;
  storageRefresh: string;
  storageManageHistory: string;
  storageManageHint: string;
  storageLow: (available: string) => string;
  storageImportBlocked: (required: string, available: string) => string;
  localMode: string;
  networkGate: string;
  onlineReady: string;
  offlineHistoryOnly: string;
  updateReady: string;
  updateDetail: string;
  updateWaitBatch: string;
  applyUpdate: string;
  installApp: string;
  appInstalled: string;
  installTitle: string;
  installNativeDetail: string;
  installIosDetail: string;
  installManualDetail: string;
  installNow: string;
  notNow: string;
  addImages: string;
  cameraCapture: string;
  continuousCamera: string;
  cameraPageCount: (count: number) => string;
  cameraExit: string;
  cameraViewfinder: string;
  cameraFramePage: string;
  cameraHoldSteady: string;
  cameraCaptureTranslate: string;
  cameraStarting: string;
  cameraPermissionPrompt: string;
  cameraAccessFailed: string;
  cameraSecureContext: string;
  cameraPermissionDenied: string;
  cameraUnavailable: string;
  cameraBusy: string;
  cameraInterrupted: string;
  cameraRetry: string;
  cameraNotReady: string;
  cameraCaptureFailed: string;
  cameraCapturedPage: string;
  cameraTranslatedPage: string;
  cameraPreparing: string;
  cameraTranslating: string;
  cameraResultReady: string;
  cameraNextPage: string;
  cameraNextHint: string;
  cameraTranslationFailed: string;
  importing: string;
  queue: string;
  queueCount: (count: number) => string;
  queueEmptyTitle: string;
  queueEmptyBody: string;
  dropHint: string;
  supportedHint: (maxFileMiB: number) => string;
  pasteHint: string;
  duplicate: string;
  workingCopy: string;
  remove: string;
  moveUp: string;
  moveDown: string;
  preview: string;
  previewEmptyTitle: string;
  previewEmptyBody: string;
  original: string;
  result: string;
  compareUnavailable: string;
  previewZoom: string;
  previewFit: string;
  zoomIn: string;
  zoomOut: string;
  batchSettings: string;
  processMode: string;
  translate: string;
  originalReflow: string;
  eraseOnly: string;
  targetLanguage: string;
  simplifiedChinese: string;
  traditionalChinese: string;
  provider: string;
  providerHint: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  sessionKeyHint: string;
  deviceKeyHint: string;
  deviceKeyRestoring: string;
  deviceKeyTargetMismatch: string;
  deviceKeyCorrupt: string;
  rememberDevice: string;
  deleteProviderConfig: string;
  providerReady: string;
  runtime: string;
  importGate: string;
  importGateReady: string;
  importGateWaiting: string;
  coreGate: string;
  coreGatePending: string;
  coreGateReady: (support: string, backend: string, workMegapixels: number) => string;
  supportDesktop: string;
  supportBeta: string;
  supportExperimental: string;
  backendWebgpu: string;
  backendWasm: string;
  legal: string;
  modelSources: string;
  privacyPolicy: string;
  thirdPartyNotices: string;
  sourceCode: string;
  troubleshooting: string;
  diagnostics: string;
  diagnosticsDetail: string;
  diagnosticsExport: string;
  diagnosticsPreparing: string;
  modelGate: string;
  modelGatePending: string;
  modelGateChecking: string;
  modelGateInstalling: string;
  modelGateVerifying: string;
  modelGatePaused: string;
  modelGateFailed: string;
  modelGateReady: string;
  modelGateProbing: (modelId: string, completed: number, total: number) => string;
  modelGateProbeFailed: string;
  modelProbeRetry: string;
  modelConsent: string;
  modelConsentDetail: string;
  modelDownloadProgress: (percent: number, downloaded: string, total: string) => string;
  modelCancel: string;
  modelResume: string;
  modelRetry: string;
  providerGatePending: string;
  queueRequired: string;
  start: string;
  startUnavailable: string;
  stopBatch: string;
  cancelCurrent: string;
  batchRunning: string;
  batchStopped: string;
  statusQueued: string;
  statusRunning: string;
  statusDone: string;
  statusFailed: string;
  statusCancelled: string;
  batchLockHint: string;
  issues: string;
  clearIssues: string;
  selectImage: string;
  imageMeta: (width: number, height: number, size: string) => string;
  workMeta: (width: number, height: number, scale: number) => string;
  totalSize: (size: string) => string;
  webBadge: string;
};

const copies: Record<UiLocale, AppCopy> = {
  'zh-CN': {
    appSubtitle: '漫画图片翻译助手',
    workbench: '工作台',
    history: '历史',
    historyTitle: '历史',
    historySubtitle: '原图、结果和恢复点保存在此浏览器；重要内容请另行导出备份。',
    historyRefresh: '刷新历史',
    historyImportProject: '导入项目包',
    historyExportResults: '结果 ZIP',
    historyExportProject: '完整项目包',
    historyExportWarning: '将导出未加密的 .shinobu.zip，其中包含原图、结果、缩略图、OCR/译文摘要、配置、顺序、状态和版本信息。项目包不含模型、API Key 或诊断日志。任何拿到文件的人都可查看其内容，是否继续？',
    historyLoading: '正在读取本地历史',
    historyEmptyTitle: '暂无记录',
    historyEmptyBody: '成功启动第一个批次后，恢复点和结果会显示在这里。',
    historyStorageError: '无法完整读取本地历史',
    historyBatchImages: (count) => `${count} 张图片`,
    historyBatchStatus: (status) => ({
      running: '处理中',
      paused: '可恢复',
      completed: '已完成',
      failed: '部分失败',
    })[status],
    historyPartial: '部分损坏',
    historyModelVersion: '模型版本',
    historyDownloadResult: '下载 PNG',
    historyNoResult: '暂无结果',
    historyClone: '克隆为新批次',
    historyResume: '继续未完成任务',
    historyResumeReady: '恢复批次已载入；配置保持锁定，已完成结果不会重复处理。',
    historyExitResume: '退出恢复',
    historyResultsOnly: '此记录只保留结果，不能重新运行。',
    historyKeepResults: '只保留结果',
    historyKeepResultsWarning: '这会删除此批次的原图和缩略图，并永久取消重跑能力；结果 PNG 会保留。是否继续？',
    historyDelete: '删除记录',
    historyDeletePending: '历史记录将在 10 秒后永久删除',
    historyUndoDelete: '撤销',
    settings: '设置',
    settingsTitle: '应用设置',
    settingsSubtitle: '管理翻译提供商、界面语言、浏览器存储与脱敏诊断。任务模式和目标语言仍按批次设置。',
    settingsLocked: '当前批次正在处理或恢复，提供商配置暂时只读。',
    interfaceLanguage: '界面语言',
    providerSettingsTitle: '翻译提供商',
    providerSettingsDetail: '每个提供商保留独立的服务地址、模型和 API Key。图片始终在本机处理，只有待翻译文本会发往你选择的服务。',
    openProviderSettings: '配置提供商',
    storageTitle: '浏览器存储',
    storageDetail: '模型、原图、恢复点和结果保存在此站点的浏览器私有空间。',
    storageChecking: '正在读取站点存储用量',
    storageUnavailable: '无法验证浏览器剩余配额；在恢复可验证的配额前，新图片导入已停用。',
    storageUsage: (usage, quota) => `已使用 ${usage} / ${quota}`,
    storageAvailable: (available) => `剩余 ${available}`,
    storagePersistent: '浏览器已授予持久存储保护',
    storageTemporary: '浏览器可能在空间紧张时回收站点数据，请导出重要项目备份',
    storageRefresh: '刷新用量',
    storageManageHistory: '打开历史管理',
    storageManageHint: '空间不足时不会自动删除历史；请先导出重要项目，再手动仅保留结果或删除记录。',
    storageLow: (available) => `当前仅剩 ${available}；新导入需要至少保留 100 MiB 安全余量。`,
    storageImportBlocked: (required, available) =>
      `本次导入预计至少需要 ${required} 可用空间，当前仅剩 ${available}。请到历史页导出并清理不再需要的记录。`,
    localMode: '图片仅在本机处理',
    networkGate: '网络状态',
    onlineReady: '在线；允许启动新的本地处理批次',
    offlineHistoryOnly: '离线时只能查看历史和下载已有结果',
    updateReady: 'Web 应用更新已就绪',
    updateDetail: '现在重新载入即可使用新版本。',
    updateWaitBatch: '当前批次结束后才能安全激活更新。',
    applyUpdate: '应用更新',
    installApp: '安装应用',
    appInstalled: '已安装',
    installTitle: '把 Shinobu 放到桌面',
    installNativeDetail: '安装后可从系统入口打开；本地历史仍保存在当前浏览器站点数据中。',
    installIosDetail: '在 Safari 中点击“分享”，再选择“添加到主屏幕”。',
    installManualDetail: '可从浏览器菜单中的“安装应用”或“创建快捷方式”入口安装。',
    installNow: '立即安装',
    notNow: '暂不提示',
    addImages: '添加图片',
    cameraCapture: '连续拍摄',
    continuousCamera: '连续拍摄',
    cameraPageCount: (count) => count > 0 ? `已完成 ${count} 页` : '准备拍摄第一页',
    cameraExit: '退出连续拍摄',
    cameraViewfinder: '相机取景画面',
    cameraFramePage: '将整页漫画放入取景框',
    cameraHoldSteady: '保持平稳，尽量避免反光和阴影',
    cameraCaptureTranslate: '拍摄并翻译',
    cameraStarting: '正在启动相机',
    cameraPermissionPrompt: '首次使用时，请允许浏览器访问相机。',
    cameraAccessFailed: '无法打开相机',
    cameraSecureContext: '连续拍摄需要通过 HTTPS 或本机安全环境打开网页。',
    cameraPermissionDenied: '相机权限被拒绝，请在浏览器的网站设置中允许相机访问。',
    cameraUnavailable: '没有找到可用相机，或当前浏览器不支持网页内拍摄。',
    cameraBusy: '相机正被其他应用占用，请关闭其他相机应用后重试。',
    cameraInterrupted: '相机连接已中断，请重新启动取景。',
    cameraRetry: '重试相机',
    cameraNotReady: '相机画面尚未就绪，请稍等片刻。',
    cameraCaptureFailed: '拍摄失败，请重试。',
    cameraCapturedPage: '刚刚拍摄的漫画页面',
    cameraTranslatedPage: '翻译后的漫画页面',
    cameraPreparing: '正在准备图片',
    cameraTranslating: '正在翻译这一页',
    cameraResultReady: '这一页已翻译完成',
    cameraNextPage: '开始拍摄下一张',
    cameraNextHint: '点 × 回到取景，继续拍下一页',
    cameraTranslationFailed: '这一页翻译失败',
    importing: '正在验证图片',
    queue: '图片队列',
    queueCount: (count) => `${count} / 100 张`,
    queueEmptyTitle: '暂无图片',
    queueEmptyBody: '可以多选、拖放或直接粘贴。图片会按加入顺序排队。',
    dropHint: '将图片拖到这里',
    supportedHint: (maxFileMiB) =>
      `PNG、JPEG、WebP、AVIF，单张不超过 ${maxFileMiB} MiB`,
    pasteHint: '也可按 Ctrl+V 粘贴剪贴板图片',
    duplicate: '重复',
    workingCopy: '将缩小处理',
    remove: '移除',
    moveUp: '上移',
    moveDown: '下移',
    preview: '图片预览',
    previewEmptyTitle: '暂无预览',
    previewEmptyBody: '导入后可在这里检查原图、工作分辨率和最终结果。',
    original: '原图',
    result: '结果',
    compareUnavailable: '完成处理后可比较结果',
    previewZoom: '预览缩放',
    previewFit: '适应',
    zoomIn: '放大',
    zoomOut: '缩小',
    batchSettings: '翻译设置',
    processMode: '处理模式',
    translate: '翻译',
    originalReflow: '原文',
    eraseOnly: '去字',
    targetLanguage: '目标语言',
    simplifiedChinese: '简体中文',
    traditionalChinese: '繁体中文',
    provider: '翻译提供商',
    providerHint: '每个提供商保留独立地址和模型配置',
    baseUrl: 'Base URL',
    model: '模型名称',
    apiKey: 'API Key',
    sessionKeyHint: '默认只保存在当前标签页会话；不会写入普通本地存储。',
    deviceKeyHint: '已用不可导出的设备密钥加密；仅绑定当前域名、端口和路径前缀。',
    deviceKeyRestoring: '正在解锁此设备保存的 API Key',
    deviceKeyTargetMismatch: '服务目标已改变，请重新输入并确认 API Key。',
    deviceKeyCorrupt: '无法解锁此设备保存的 API Key，请重新输入。',
    rememberDevice: '记住此设备',
    deleteProviderConfig: '清除配置',
    providerReady: '当前提供商、服务地址、模型与设备密钥均已就绪',
    runtime: '运行准备',
    importGate: '图片安全闸门',
    importGateReady: '当前队列已通过格式、尺寸与批量限制',
    importGateWaiting: '等待导入图片',
    coreGate: '本地翻译核心',
    coreGatePending: '正在检测目标 Canvas、Worker、OPFS、ORT 与 GPU',
    coreGateReady: (support, backend, workMegapixels) =>
      `${support} · ${backend} · 工作档位 ${workMegapixels} MP`,
    supportDesktop: '桌面正式支持',
    supportBeta: 'Android Beta',
    supportExperimental: 'iOS/iPadOS 实验支持',
    backendWebgpu: 'WebGPU 可用',
    backendWasm: 'WASM 降级',
    legal: '隐私与开源',
    modelSources: '模型来源',
    privacyPolicy: '隐私政策',
    thirdPartyNotices: '第三方组件与模型声明',
    sourceCode: 'GPL-3.0 源代码',
    troubleshooting: 'Web 故障排查与安全反馈',
    diagnostics: '脱敏诊断',
    diagnosticsDetail: '仅导出版本、能力、阶段、错误码、存储量和提供商主机；不含图片、文件名、OCR、译文、请求正文或 API Key。',
    diagnosticsExport: '导出诊断 JSON',
    diagnosticsPreparing: '正在准备…',
    modelGate: '模型资产',
    modelGatePending: '未安装',
    modelGateChecking: '正在检查',
    modelGateInstalling: '正在下载',
    modelGateVerifying: '正在校验',
    modelGatePaused: '已暂停',
    modelGateFailed: '安装失败',
    modelGateReady: '已安装',
    modelGateProbing: (modelId, completed, total) =>
      `正在验证生产模型 ${modelId} · ${completed} / ${total}`,
    modelGateProbeFailed: '生产模型能力测试失败，不能启动任务',
    modelProbeRetry: '重试模型能力测试',
    modelConsent: '安装模型',
    modelConsentDetail: '约 196 MiB，用于本地检测、OCR 和修复；保存在浏览器站点数据中，图片不会随模型请求上传。',
    modelDownloadProgress: (percent, downloaded, total) =>
      `${percent}% · ${downloaded} / ${total}`,
    modelCancel: '取消下载',
    modelResume: '继续下载',
    modelRetry: '重试安装',
    providerGatePending: '请填写有效的 Base URL、模型和当前会话 API Key。',
    queueRequired: '请先添加要处理的图片。',
    start: '开始处理',
    startUnavailable: '请先通过运行能力和模型下载确认',
    stopBatch: '停止批次',
    cancelCurrent: '取消当前图片',
    batchRunning: '批次正在串行处理',
    batchStopped: '批次已停止；已完成和待处理图片均已保留',
    statusQueued: '等待中',
    statusRunning: '处理中',
    statusDone: '已完成',
    statusFailed: '失败',
    statusCancelled: '已取消',
    batchLockHint: '开始后将锁定本批次配置；后续改动会创建新批次。',
    issues: '未导入的文件',
    clearIssues: '清除',
    selectImage: '选择图片',
    imageMeta: (width, height, size) => `${width} × ${height} · ${size}`,
    workMeta: (width, height, scale) =>
      `工作副本 ${width} × ${height} · ${Math.round(scale * 100)}%`,
    totalSize: (size) => `原文件共 ${size}`,
    webBadge: 'Web',
  },
  'zh-TW': {
    appSubtitle: '漫畫圖片翻譯助手',
    workbench: '工作臺',
    history: '歷史',
    historyTitle: '歷史',
    historySubtitle: '原圖、結果和恢復點保存在此瀏覽器；重要內容請另行匯出備份。',
    historyRefresh: '重新整理歷史',
    historyImportProject: '匯入專案包',
    historyExportResults: '結果 ZIP',
    historyExportProject: '完整專案包',
    historyExportWarning: '將匯出未加密的 .shinobu.zip，其中包含原圖、結果、縮圖、OCR/譯文摘要、設定、順序、狀態和版本資訊。專案包不含模型、API Key 或診斷日誌。任何取得檔案的人都可查看其內容，是否繼續？',
    historyLoading: '正在讀取本機歷史',
    historyEmptyTitle: '暫無記錄',
    historyEmptyBody: '成功啟動第一個批次後，恢復點和結果會顯示在這裡。',
    historyStorageError: '無法完整讀取本機歷史',
    historyBatchImages: (count) => `${count} 張圖片`,
    historyBatchStatus: (status) => ({
      running: '處理中',
      paused: '可恢復',
      completed: '已完成',
      failed: '部分失敗',
    })[status],
    historyPartial: '部分損壞',
    historyModelVersion: '模型版本',
    historyDownloadResult: '下載 PNG',
    historyNoResult: '暫無結果',
    historyClone: '複製為新批次',
    historyResume: '繼續未完成工作',
    historyResumeReady: '恢復批次已載入；設定保持鎖定，已完成結果不會重複處理。',
    historyExitResume: '退出恢復',
    historyResultsOnly: '此記錄只保留結果，不能重新執行。',
    historyKeepResults: '只保留結果',
    historyKeepResultsWarning: '這會刪除此批次的原圖和縮圖，並永久取消重新執行能力；結果 PNG 會保留。是否繼續？',
    historyDelete: '刪除記錄',
    historyDeletePending: '歷史記錄將在 10 秒後永久刪除',
    historyUndoDelete: '復原',
    settings: '設定',
    settingsTitle: '應用設定',
    settingsSubtitle: '管理翻譯供應商、介面語言、瀏覽器儲存與去識別診斷。工作模式和目標語言仍依批次設定。',
    settingsLocked: '目前批次正在處理或恢復，供應商設定暫時為唯讀。',
    interfaceLanguage: '介面語言',
    providerSettingsTitle: '翻譯供應商',
    providerSettingsDetail: '每個供應商保留獨立的服務網址、模型和 API Key。圖片始終在本機處理，只有待翻譯文字會傳送至你選擇的服務。',
    openProviderSettings: '設定供應商',
    storageTitle: '瀏覽器儲存',
    storageDetail: '模型、原圖、恢復點和結果保存在此網站的瀏覽器私有空間。',
    storageChecking: '正在讀取網站儲存用量',
    storageUnavailable: '無法驗證瀏覽器剩餘配額；在恢復可驗證的配額前，新圖片匯入已停用。',
    storageUsage: (usage, quota) => `已使用 ${usage} / ${quota}`,
    storageAvailable: (available) => `剩餘 ${available}`,
    storagePersistent: '瀏覽器已授予持久儲存保護',
    storageTemporary: '瀏覽器可能在空間不足時回收網站資料，請匯出重要專案備份',
    storageRefresh: '重新整理用量',
    storageManageHistory: '開啟歷史管理',
    storageManageHint: '空間不足時不會自動刪除歷史；請先匯出重要專案，再手動只保留結果或刪除記錄。',
    storageLow: (available) => `目前僅剩 ${available}；新匯入需要至少保留 100 MiB 安全餘量。`,
    storageImportBlocked: (required, available) =>
      `本次匯入預計至少需要 ${required} 可用空間，目前僅剩 ${available}。請到歷史頁匯出並清理不再需要的記錄。`,
    localMode: '圖片僅在本機處理',
    networkGate: '網路狀態',
    onlineReady: '已連線；允許啟動新的本機處理批次',
    offlineHistoryOnly: '離線時只能查看歷史和下載已有結果',
    updateReady: 'Web 應用程式更新已就緒',
    updateDetail: '現在重新載入即可使用新版本。',
    updateWaitBatch: '目前批次結束後才能安全啟用更新。',
    applyUpdate: '套用更新',
    installApp: '安裝應用程式',
    appInstalled: '已安裝',
    installTitle: '把 Shinobu 放到桌面',
    installNativeDetail: '安裝後可從系統入口開啟；本機歷史仍保存在目前瀏覽器網站資料中。',
    installIosDetail: '在 Safari 中點擊「分享」，再選擇「加入主畫面」。',
    installManualDetail: '可從瀏覽器選單中的「安裝應用程式」或「建立捷徑」入口安裝。',
    installNow: '立即安裝',
    notNow: '暫不提示',
    addImages: '加入圖片',
    cameraCapture: '連續拍攝',
    continuousCamera: '連續拍攝',
    cameraPageCount: (count) => count > 0 ? `已完成 ${count} 頁` : '準備拍攝第一頁',
    cameraExit: '退出連續拍攝',
    cameraViewfinder: '相機取景畫面',
    cameraFramePage: '將整頁漫畫放入取景框',
    cameraHoldSteady: '保持平穩，盡量避免反光和陰影',
    cameraCaptureTranslate: '拍攝並翻譯',
    cameraStarting: '正在啟動相機',
    cameraPermissionPrompt: '首次使用時，請允許瀏覽器存取相機。',
    cameraAccessFailed: '無法開啟相機',
    cameraSecureContext: '連續拍攝需要透過 HTTPS 或本機安全環境開啟網頁。',
    cameraPermissionDenied: '相機權限被拒絕，請在瀏覽器的網站設定中允許相機存取。',
    cameraUnavailable: '找不到可用相機，或目前瀏覽器不支援網頁內拍攝。',
    cameraBusy: '相機正被其他應用程式占用，請關閉其他相機應用程式後重試。',
    cameraInterrupted: '相機連線已中斷，請重新啟動取景。',
    cameraRetry: '重試相機',
    cameraNotReady: '相機畫面尚未就緒，請稍等片刻。',
    cameraCaptureFailed: '拍攝失敗，請重試。',
    cameraCapturedPage: '剛剛拍攝的漫畫頁面',
    cameraTranslatedPage: '翻譯後的漫畫頁面',
    cameraPreparing: '正在準備圖片',
    cameraTranslating: '正在翻譯這一頁',
    cameraResultReady: '這一頁已翻譯完成',
    cameraNextPage: '開始拍攝下一張',
    cameraNextHint: '點 × 回到取景，繼續拍下一頁',
    cameraTranslationFailed: '這一頁翻譯失敗',
    importing: '正在驗證圖片',
    queue: '圖片佇列',
    queueCount: (count) => `${count} / 100 張`,
    queueEmptyTitle: '暫無圖片',
    queueEmptyBody: '可以多選、拖放或直接貼上。圖片會依加入順序排隊。',
    dropHint: '將圖片拖到這裡',
    supportedHint: (maxFileMiB) =>
      `PNG、JPEG、WebP、AVIF，單張不超過 ${maxFileMiB} MiB`,
    pasteHint: '也可按 Ctrl+V 貼上剪貼簿圖片',
    duplicate: '重複',
    workingCopy: '將縮小處理',
    remove: '移除',
    moveUp: '上移',
    moveDown: '下移',
    preview: '圖片預覽',
    previewEmptyTitle: '暫無預覽',
    previewEmptyBody: '匯入後可在這裡檢查原圖、工作解析度和最終結果。',
    original: '原圖',
    result: '結果',
    compareUnavailable: '完成處理後可比較結果',
    previewZoom: '預覽縮放',
    previewFit: '適應',
    zoomIn: '放大',
    zoomOut: '縮小',
    batchSettings: '翻譯設定',
    processMode: '處理模式',
    translate: '翻譯',
    originalReflow: '原文',
    eraseOnly: '去字',
    targetLanguage: '目標語言',
    simplifiedChinese: '簡體中文',
    traditionalChinese: '繁體中文',
    provider: '翻譯供應商',
    providerHint: '每個供應商保留獨立網址和模型設定',
    baseUrl: 'Base URL',
    model: '模型名稱',
    apiKey: 'API Key',
    sessionKeyHint: '預設只保存在目前分頁工作階段；不會寫入一般本機儲存。',
    deviceKeyHint: '已用不可匯出的裝置密鑰加密；僅綁定目前網域、連接埠和路徑前綴。',
    deviceKeyRestoring: '正在解鎖此裝置保存的 API Key',
    deviceKeyTargetMismatch: '服務目標已改變，請重新輸入並確認 API Key。',
    deviceKeyCorrupt: '無法解鎖此裝置保存的 API Key，請重新輸入。',
    rememberDevice: '記住此裝置',
    deleteProviderConfig: '清除設定',
    providerReady: '目前供應商、服務位址、模型與裝置密鑰均已就緒',
    runtime: '執行準備',
    importGate: '圖片安全閘門',
    importGateReady: '目前佇列已通過格式、尺寸與批次限制',
    importGateWaiting: '等待匯入圖片',
    coreGate: '本機翻譯核心',
    coreGatePending: '正在檢測目標 Canvas、Worker、OPFS、ORT 與 GPU',
    coreGateReady: (support, backend, workMegapixels) =>
      `${support} · ${backend} · 工作檔位 ${workMegapixels} MP`,
    supportDesktop: '桌面正式支援',
    supportBeta: 'Android Beta',
    supportExperimental: 'iOS/iPadOS 實驗支援',
    backendWebgpu: 'WebGPU 可用',
    backendWasm: 'WASM 降級',
    legal: '隱私與開源',
    modelSources: '模型來源',
    privacyPolicy: '隱私政策',
    thirdPartyNotices: '第三方元件與模型聲明',
    sourceCode: 'GPL-3.0 原始碼',
    troubleshooting: 'Web 疑難排解與安全回報',
    diagnostics: '去識別診斷',
    diagnosticsDetail: '只匯出版本、能力、階段、錯誤碼、儲存量與供應商主機；不含圖片、檔名、OCR、譯文、請求內容或 API Key。',
    diagnosticsExport: '匯出診斷 JSON',
    diagnosticsPreparing: '正在準備…',
    modelGate: '模型資產',
    modelGatePending: '未安裝',
    modelGateChecking: '正在檢查',
    modelGateInstalling: '正在下載',
    modelGateVerifying: '正在驗證',
    modelGatePaused: '已暫停',
    modelGateFailed: '安裝失敗',
    modelGateReady: '已安裝',
    modelGateProbing: (modelId, completed, total) =>
      `正在驗證生產模型 ${modelId} · ${completed} / ${total}`,
    modelGateProbeFailed: '生產模型能力測試失敗，不能啟動工作',
    modelProbeRetry: '重試模型能力測試',
    modelConsent: '安裝模型',
    modelConsentDetail: '約 196 MiB，用於本機偵測、OCR 和修復；保存在瀏覽器網站資料中，圖片不會隨模型請求上傳。',
    modelDownloadProgress: (percent, downloaded, total) =>
      `${percent}% · ${downloaded} / ${total}`,
    modelCancel: '取消下載',
    modelResume: '繼續下載',
    modelRetry: '重試安裝',
    providerGatePending: '請填寫有效的 Base URL、模型和目前工作階段 API Key。',
    queueRequired: '請先加入要處理的圖片。',
    start: '開始處理',
    startUnavailable: '請先通過執行能力和模型下載確認',
    stopBatch: '停止批次',
    cancelCurrent: '取消目前圖片',
    batchRunning: '批次正在依序處理',
    batchStopped: '批次已停止；已完成和待處理圖片均已保留',
    statusQueued: '等待中',
    statusRunning: '處理中',
    statusDone: '已完成',
    statusFailed: '失敗',
    statusCancelled: '已取消',
    batchLockHint: '開始後將鎖定本批次設定；後續變更會建立新批次。',
    issues: '未匯入的檔案',
    clearIssues: '清除',
    selectImage: '選擇圖片',
    imageMeta: (width, height, size) => `${width} × ${height} · ${size}`,
    workMeta: (width, height, scale) =>
      `工作副本 ${width} × ${height} · ${Math.round(scale * 100)}%`,
    totalSize: (size) => `原始檔案共 ${size}`,
    webBadge: 'Web',
  },
};

export function getCopy(locale: UiLocale): AppCopy {
  return copies[locale];
}

export function describeImportRejection(
  locale: UiLocale,
  code: ImageImportRejectionCode,
): string {
  const traditional = locale === 'zh-TW';
  const messages: Record<ImageImportRejectionCode, [string, string]> = {
    'empty-file': ['文件为空', '檔案是空的'],
    'file-too-large': ['单文件超过 32 MiB', '單一檔案超過 32 MiB'],
    'batch-count-limit': ['批次最多 100 张', '批次最多 100 張'],
    'batch-size-limit': ['批次原文件总量超过 500 MiB', '批次原始檔案總量超過 500 MiB'],
    'unsupported-format': ['不是受支持的静态图片格式', '不是支援的靜態圖片格式'],
    'animated-image': ['暂不支持动画图片', '暫不支援動畫圖片'],
    'decode-failed': ['浏览器无法解码此图片', '瀏覽器無法解碼此圖片'],
    'invalid-dimensions': ['图片尺寸无效', '圖片尺寸無效'],
    'dimensions-too-large': ['图片超过 40 MP 或长边超过 8,192 px', '圖片超過 40 MP 或長邊超過 8,192 px'],
    'thumbnail-failed': ['无法生成本地缩略图', '無法產生本機縮圖'],
  };
  return messages[code][traditional ? 1 : 0];
}
