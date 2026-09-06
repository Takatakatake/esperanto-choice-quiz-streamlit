import {
  buildVocabGroups,
  computeResultSummary,
  scaleSpartanPoints,
  scoreForCorrect,
} from "./quiz_core.mjs";

import { buildLocalizedQuestion } from "./quiz_questions.mjs";
import { inspectLegacySession, commitLegacySessionImport, hasClassicMigrationProvenance, isLegacyScoreSaveBlocked } from "./legacy_session_migration.mjs";
import { addToOutbox, matchesAccountResult, filterUserHistory, SerializedBridge, DurableScoreOutbox, canReplaceSession, persistPresentSession, isAccountCacheFresh, matchesScoreRecord, scoreRecordFromSession, hasConfirmedScoreEvidence } from "./learning_sync.mjs";

const APP_VERSION = "2026-09-06-unified-learning-4";
const STORAGE_PREFIX = "esperanto-choice-mobile";
const SESSION_KEY = `${STORAGE_PREFIX}:session:v2`;
const SETTINGS_KEY = `${STORAGE_PREFIX}:settings:v2`;
const HISTORY_KEY = `${STORAGE_PREFIX}:history:v2`;
const OUTBOX_KEY = `${STORAGE_PREFIX}:outbox:v1`;
const OUTBOX_ENTRY_PREFIX = `${STORAGE_PREFIX}:outbox:v2:`;

const DATA_URLS = {
  vocab: "./data/vocab.json",
  sentences: "./data/sentences.json",
  audioManifest: "./data/audio_manifest.json",
};

const IS_STREAMLIT_COMPONENT = window.location.pathname.includes("/component/");
const VOCAB_AUDIO_BASE = IS_STREAMLIT_COMPONENT ? "./audio/" : "../audio/";
const SENTENCE_AUDIO_BASE = IS_STREAMLIT_COMPONENT ? "./sentence-audio/" : "../Esperanto例文5000文_収録音声/";
const DRIVE_AUDIO_DOWNLOAD_BASE = "https://drive.google.com/uc?export=download&id=";
const AUDIO_PLAYBACK_TIMEOUT_MS = 12000;
const DEFAULT_AUDIO_CONFIG = {
  enabled: true,
  vocabBaseUrl: VOCAB_AUDIO_BASE,
  sentenceBaseUrl: SENTENCE_AUDIO_BASE,
  driveDownloadBaseUrl: DRIVE_AUDIO_DOWNLOAD_BASE,
  useDriveManifest: false,
};
const PUBLIC_APP_URLS = {
  ja: "https://esperanto-quiz.streamlit.app/",
  zh: "https://esperanto-quiz-zh.streamlit.app/",
  ko: "https://esperanto-quiz-ko.streamlit.app/",
};
const HISTORY_MAX_ITEMS = 100;
const HISTORY_RECOVERY_LIMITS = [50, 20, 5, 0];
const RANKING_CACHE_TTL_MS = 120000;
const SCORE_SYNC_RETRY_DELAY_MS = 10000;
const SCORE_SYNC_AUTO_RETRY_MAX = 3;
const SUPPORTED_TARGET_LANGS = new Set(["ja", "zh", "ko"]);

const TARGET_LANG_META = {
  ja: {
    htmlLang: "ja",
    intlLocale: "ja-JP",
    name: "日本語",
    esperantoName: "エスペラント",
    appTitle: "Esperanto 4択",
    modeVocab: "単語",
    modeSentence: "例文",
    wordUnit: "語",
    pointUnit: "点",
    labels: {
      legacyViewOnly: "旧版の結果（閲覧のみ）",
      legacyUnknownSaveHint: "旧版の保存状況を確認できないため、この結果は閲覧のみで引き継ぎます。重複加算を防ぐため再送は行いません。",
      rankingVisibilityUpdating: "公開設定を確認してからランキングを更新します。",
      saveBeforeNewQuiz: "この結果の未送信データを保存できていません。結果を保持しました。保存を再試行してから新しいクイズを始めてください。",
      legacyTitle: "旧版の学習データがあります",
      legacyImport: "この画面に引き継ぐ",
      legacyResumeHint: "保存されていた問題と得点を引き継いで再開できます。旧版の保存データも残ります。",
      legacyCompleteHint: "完了したクイズを引き継げます。未送信の得点は、元の名前の学習記録に自動保存します。旧版の保存データも残ります。",
      legacyUnsupported: "旧版の保存データは保持されていますが、自動で引き継げない形式です。現在のクイズには影響しません。",
      legacyImportFailed: "データの変更、または端末への保存失敗のため引き継げませんでした。再読み込みして確認してください。",
      legacyImported: "旧版の問題と得点を引き継ぎました。",
      loading: "データを読み込んでいます",
      ready: "準備完了",
      userName: "ユーザー名",
      direction: "出題方向",
      seed: "シード",
      pos: "品詞",
      group: "グループ",
      topic: "トピック",
      subtopic: "サブトピック",
      levels: "レベル",
      audio: "音声",
      audioPrompt: "問題を自動再生",
      audioAll: "問題自動＋選択肢",
      audioOff: "オフ",
      spartan: "スパルタ復習",
      start: "クイズ開始",
      resumeShort: "続き",
      resumeTitle: "保存されたクイズがあります",
      resumeAction: "続きから再開",
      result: "結果",
      complete: "完了",
      accuracy: "正答率",
      points: "得点",
      correct: "正解",
      saveRanking: "学習記録を保存",
      retry: "同じ設定でもう一度",
      newQuiz: "新しいクイズ",
      review: "復習",
      history: "学習記録",
      clearHistory: "端末履歴のみ消去",
      ranking: "ランキング",
      rankingBeforeLoad: "読み込み前",
      refresh: "更新",
      rankingOverall: "累積",
      rankingToday: "本日",
      rankingMonth: "今月",
      rankingHof: "殿堂",
      diagnostics: "診断",
      reload: "再読み込み",
      navHome: "ホーム",
      navQuiz: "クイズ",
      navHistory: "学習記録",
      navDiagnostics: "診断",
      languageLinks: "言語",
      loadFailed: "読み込みに失敗しました",
      next: "次へ",
      unknown: "不明",
      none: "なし",
      error: "エラー",
      dataShortage: "クイズデータが不足しています。",
      clearHistoryConfirm: "この名前の端末内の履歴だけを消去します。累積得点、未送信の記録、進行中のクイズは消えません。実行しますか？",
      clearHistoryDone: "この名前の端末履歴だけを消去しました。累積得点と未送信の記録は残っています。",
      scoreSavedMessage: "学習記録を保存しました。",
      scoreSaveFailedMessage: "保存に失敗しました。",
      rankingUpdatedMessage: "ランキングを表示しました。",
      rankingFailedMessage: "ランキングを取得できませんでした。",
      scorePendingRestored: "前回の保存結果を確認中です。重複を防ぎながら自動で再送します。",
      saveFailed: "保存できません",
      historySavedAfterCleanup: "履歴を整理して保存済み",
      historyCleanupToast: "端末保存容量が足りないため、古い成績履歴を整理しました。",
      sessionCleanupToast: "端末保存容量が足りないため、成績履歴を整理してクイズ状態を保存しました。",
      autoSaved: "自動保存済み",
      sessionDiscarded: "進行中のクイズを破棄しました",
      rankingUnavailable: "ランキングはオンライン版で利用できます。",
      rankingLoading: "ランキングを読み込んでいます。",
      rankingTimeout: "ランキングの読み込みに時間がかかっています。通信状態を確認して、更新を押してください。",
      replaceActiveConfirm: "進行中のクイズがあります。現在の進行を終了して、新しいクイズを開始しますか？",
      activeKept: "進行中のクイズを保持しました。",
      noQuestions: "選択した条件では問題を作成できません。",
      reviewPhase: "復習",
      streak: "連続",
      remaining: "残り",
      choiceAudioAria: "選択肢の音声を再生",
      incorrectPrefix: "不正解。正解",
      scoreUnavailable: "アカウントへの記録保存はオンライン版で利用できます。",
      scoreNeedsUser: "名前を入力して始めたクイズは、完了時に学習記録を自動保存します。",
      scoreSaving: "保存中...",
      scoreSavingMessage: "学習記録を保存しています。",
      scoreSavedButton: "学習記録を保存済み",
      scoreSavedAdd: "今回の{points}点を学習記録に加算しました。",
      scoreRetryTotals: "累積得点を再更新",
      scoreRetryMessage: "保存に失敗しました。もう一度お試しください。",
      scoreWillAdd: "今回の{points}点を学習記録に保存します。",
      scoreUserRequired: "保存するにはユーザー名が必要です。",
      scoreRetryLimit: "保存結果を確認できませんでした。通信を確認して「学習記録を保存」または学習記録画面の再送を押してください。",
      scoreAutoRetry: "通信を確認しながら自動で再送します。同じ記録は重複加算しません。",
      noWrongTitle: "間違えた問題はありません",
      noWrongBody: "この結果は端末内の学習記録に保存されています。",
      reviewAudioAria: "エスペラント正解の音声を再生",
      answer: "回答",
      rankingRetry: "再試行",
      rankingLoadingShort: "読み込み中です。",
      rankingIdle: "未更新",
      rankingPrompt: "更新を押すとランキングを取得します。",
      rankingSecretHint: "Streamlit CloudのSecrets設定とGoogle Sheets共有権限を確認してください。",
      rankingEmpty: "{tab}のランキングはまだありません。",
      currentUser: "あなた",
      historyEmptyTitle: "この名前の端末履歴はありません",
      historyEmptyBody: "この端末でクイズを完了すると、ここに表示されます。",
      noStoredQuiz: "保存中のクイズなし",
      appVersion: "アプリ版",
      runtime: "実行形式",
      streamlitEmbedded: "Streamlit Cloud組み込み",
      staticPwa: "静的/PWA",
      quizData: "クイズデータ",
      entriesCount: "単語 {vocab}件 / 例文 {sentences}件",
      audioSettings: "音声設定",
      audioManifest: "音声manifest",
      quizSave: "クイズ保存",
      localHistory: "端末履歴",
      storageUse: "端末保存使用量",
      storageApprox: "概算 {value}",
      storageUnused: "未使用",
      scoreSave: "スコア保存",
      vocabAudioTest: "単語音声テスト",
      sentenceAudioTest: "例文音声テスト",
      sessionActive: "進行中",
      audioVocabUrl: "単語URLあり",
      audioSentenceUrl: "例文URLあり",
      audioDriveFallback: "Driveフォールバックあり",
      audioNoUrl: "音声URLなし",
      sample: "サンプル",
      noAudioTest: "テスト可能な音声がありません",
      audioPlaying: "再生中...",
      audioTest: "再生テスト",
      audioTestMissing: "テスト可能な音声が見つかりません。",
      audioTesting: "{key}.wav を再生しています。",
      audioTestSuccess: "{key}.wav を再生できました。",
      audioTestToast: "{mode}音声を再生できました。",
      audioTestFailed: "再生できませんでした。{hint}",
      rankingStatusIdle: "未取得",
      rankingStatusLoading: "取得中",
      rankingStatusReady: "表示済み",
      rankingStatusUnavailable: "Streamlit外",
      scoreStatusNoComplete: "完了済みクイズなし",
      scoreStatusIdle: "未保存",
      scoreStatusPending: "保存中",
      scoreStatusSaved: "保存済み",
      scoreRecoverableTotals: " / 累積再更新可",
      serviceWorkerDisabled: "Streamlit組み込みでは無効",
      unsupported: "非対応",
      serviceWorkerActive: "有効",
      serviceWorkerPending: "登録待ちまたは未制御",
      browserStorage: "ブラウザ保存領域",
      audioMissing: "音声ファイルがありません。",
      audioFailed: "音声を再生できませんでした。通信状態と音量設定を確認してください。",
      ariaModeTabs: "出題モード",
      ariaPromptAudio: "問題文の音声を再生",
      ariaChoices: "選択肢",
      ariaRankingTabs: "ランキング種別",
      ariaLinks: "関連リンク",
      ariaMainNav: "メイン",
      personalProgress: "自分の累積得点",
      showRecords: "記録を見る",
      rankingPublic: "ランキングに表示する",
      rankingPrivacyHint: "オフにするとランキング一覧に掲載されません。学習記録の保存と、名前による閲覧は引き続き利用できます。",
      nameAccountHint: "パスワードは不要です。同じ名前を入力した人は誰でも、記録の閲覧・追加と公開設定の変更ができます。",
      deviceHistoryHint: "この端末の直近100件から、入力した名前の履歴を表示します。累積得点と未送信の記録は、履歴を消去しても残ります。",
      progressNeedsUser: "名前を入力すると、その名前の学習記録を確認できます。",
      progressUnavailable: "累積得点と公開設定はオンライン版で利用できます。",
      progressPrompt: "更新を押すと学習記録を読み込みます。",
      progressLoading: "学習記録を読み込んでいます。",
      progressReady: "保存された学習記録を表示しています。",
      progressFailed: "学習記録を取得できませんでした。通信を確認して更新してください。",
      progressEmpty: "この分野の保存済み記録はまだありません。",
      allFields: "全体",
      vocabBreakdown: "単語・品詞別",
      sentenceBreakdown: "例文・テーマ別",
      uncategorized: "未分類",
      settingsNotLoaded: "公開設定を確認してから変更できます。",
      settingsSaving: "公開設定を保存しています。",
      settingsSaved: "公開設定を保存しました。",
      settingsFailed: "公開設定を保存できませんでした。更新して確認してください。",
      settingsUnconfirmed: "公開設定の保存結果を確認できませんでした。更新して現在の設定を確認してください。",
      connectionRetry: "通信状態を確認して、もう一度更新してください。",
      retryPending: "未送信の記録を再送",
      pendingRecords: "未送信・確認待ちの記録：{count}件。再開後や通信の復帰時にも再送します。",
      recordSaved: "アカウントに保存済み",
      recordPending: "アカウントへの保存を確認中",
      recordUnsent: "未送信・再送できます",
      recordLocal: "端末のみ",
      recordUnknown: "以前の端末履歴・送信状況不明",
      outboxReadFailed: "一部の未送信の記録を読み取れません。端末の保存データを保持しています。保存領域の設定を確認して再読み込みしてください。",
      outboxWriteFailed: "未送信の記録を端末に保存できませんでした。保存領域を確認し、この結果画面で再試行してください。",
    },
  },
  zh: {
    htmlLang: "zh-Hans",
    intlLocale: "zh-CN",
    name: "中文",
    esperantoName: "世界语",
    appTitle: "世界语4选1",
    modeVocab: "单词",
    modeSentence: "例句",
    wordUnit: "词",
    pointUnit: "分",
    labels: {
      legacyViewOnly: "旧版结果（仅查看）",
      legacyUnknownSaveHint: "无法确认旧版的保存状态，此结果只能查看。为防止重复计分，不会重发。",
      rankingVisibilityUpdating: "确认公开设置后将更新排行榜。",
      saveBeforeNewQuiz: "待发送结果尚未安全保存，当前结果已保留。请重试保存后再开始新测验。",
      legacyTitle: "发现旧版学习数据",
      legacyImport: "导入到此界面",
      legacyResumeHint: "可以保留原题目和得分继续测验。旧版数据也会保留。",
      legacyCompleteHint: "可以导入已完成的测验。尚未发送的得分会自动保存到原用户名下，旧版数据也会保留。",
      legacyUnsupported: "旧版数据已保留，但此格式无法自动导入，不影响当前测验。",
      legacyImportFailed: "数据已变更或本机保存失败，无法导入。请重新加载后确认。",
      legacyImported: "已导入旧版题目和得分。",
      loading: "正在读取数据",
      ready: "准备就绪",
      userName: "用户名",
      direction: "出题方向",
      seed: "种子",
      pos: "词性",
      group: "分组",
      topic: "主题",
      subtopic: "子主题",
      levels: "等级",
      audio: "音频",
      audioPrompt: "自动播放题目",
      audioAll: "题目自动＋选项",
      audioOff: "关闭",
      spartan: "错题强化复习",
      start: "开始测验",
      resumeShort: "继续",
      resumeTitle: "有保存的测验",
      resumeAction: "从上次继续",
      result: "结果",
      complete: "完成",
      accuracy: "正确率",
      points: "得分",
      correct: "答对",
      saveRanking: "保存学习记录",
      retry: "用相同设置再做一次",
      newQuiz: "新测验",
      review: "复习",
      history: "学习记录",
      clearHistory: "仅清除本机记录",
      ranking: "排行榜",
      rankingBeforeLoad: "尚未读取",
      refresh: "更新",
      rankingOverall: "累计",
      rankingToday: "今日",
      rankingMonth: "本月",
      rankingHof: "名人堂",
      diagnostics: "诊断",
      reload: "重新读取",
      navHome: "主页",
      navQuiz: "测验",
      navHistory: "学习记录",
      navDiagnostics: "诊断",
      languageLinks: "语言",
      loadFailed: "读取失败",
      next: "下一题",
      unknown: "未知",
      none: "无",
      error: "错误",
      dataShortage: "测验数据不足。",
      clearHistoryConfirm: "仅清除此用户名在本机的记录。累计得分、待发送记录和进行中的测验不会被删除。继续吗？",
      clearHistoryDone: "已清除此用户名的本机记录。累计得分和待发送记录仍然保留。",
      scoreSavedMessage: "已保存学习记录。",
      scoreSaveFailedMessage: "保存失败。",
      rankingUpdatedMessage: "排行榜已显示。",
      rankingFailedMessage: "无法获取排行榜。",
      scorePendingRestored: "正在确认上次保存结果。会用同一保存ID安全重试，避免重复加分。",
      saveFailed: "无法保存",
      historySavedAfterCleanup: "已整理记录并保存",
      historyCleanupToast: "本机存储空间不足，已清理旧的成绩记录。",
      sessionCleanupToast: "本机存储空间不足，已清理成绩记录并保存了测验状态。",
      autoSaved: "已自动保存",
      sessionDiscarded: "已丢弃进行中的测验",
      rankingUnavailable: "在线版可查看排行榜。",
      rankingLoading: "正在读取排行榜。",
      rankingTimeout: "排行榜读取耗时较长。请检查网络状态后点击更新。",
      replaceActiveConfirm: "有进行中的测验。要结束当前进度并开始新测验吗？",
      activeKept: "已保留进行中的测验。",
      noQuestions: "所选条件无法生成题目。",
      reviewPhase: "复习",
      streak: "连续",
      remaining: "剩余",
      choiceAudioAria: "播放选项音频",
      incorrectPrefix: "答错了。正确答案",
      scoreUnavailable: "在线版可将记录保存到用户名下。",
      scoreNeedsUser: "输入用户名后开始测验，完成时会自动保存学习记录。",
      scoreSaving: "保存中...",
      scoreSavingMessage: "正在保存学习记录。",
      scoreSavedButton: "学习记录已保存",
      scoreSavedAdd: "已将本次{points}分加入学习记录。",
      scoreRetryTotals: "重新更新累计得分",
      scoreRetryMessage: "保存失败。请再试一次。",
      scoreWillAdd: "将本次{points}分保存到学习记录。",
      scoreUserRequired: "保存需要用户名。",
      scoreRetryLimit: "无法确认保存结果。请检查网络，然后点击保存学习记录或在学习记录页重发。",
      scoreAutoRetry: "正在等待网络恢复并自动重发，同一记录不会重复计分。",
      noWrongTitle: "没有答错的题目",
      noWrongBody: "此结果已保存在本机学习记录中。",
      reviewAudioAria: "播放世界语正确答案音频",
      answer: "回答",
      rankingRetry: "重试",
      rankingLoadingShort: "正在读取。",
      rankingIdle: "未更新",
      rankingPrompt: "点击更新即可读取排行榜。",
      rankingSecretHint: "请检查 Streamlit Cloud 的 Secrets 设置和 Google Sheets 共享权限。",
      rankingEmpty: "{tab}排行榜还没有数据。",
      currentUser: "你",
      historyEmptyTitle: "此用户名在本机没有记录",
      historyEmptyBody: "在本机完成测验后会显示在这里。",
      noStoredQuiz: "没有已保存的测验",
      appVersion: "应用版本",
      runtime: "运行形式",
      streamlitEmbedded: "Streamlit Cloud 内嵌",
      staticPwa: "静态/PWA",
      quizData: "测验数据",
      entriesCount: "单词 {vocab} 条 / 例句 {sentences} 条",
      audioSettings: "音频设置",
      audioManifest: "音频manifest",
      quizSave: "测验保存",
      localHistory: "本机记录",
      storageUse: "本机存储用量",
      storageApprox: "约 {value}",
      storageUnused: "未使用",
      scoreSave: "分数保存",
      vocabAudioTest: "单词音频测试",
      sentenceAudioTest: "例句音频测试",
      sessionActive: "进行中",
      audioVocabUrl: "有单词URL",
      audioSentenceUrl: "有例句URL",
      audioDriveFallback: "有Drive后备",
      audioNoUrl: "没有音频URL",
      sample: "样本",
      noAudioTest: "没有可测试的音频",
      audioPlaying: "播放中...",
      audioTest: "播放测试",
      audioTestMissing: "找不到可测试的音频。",
      audioTesting: "正在播放 {key}.wav。",
      audioTestSuccess: "已成功播放 {key}.wav。",
      audioTestToast: "已播放{mode}音频。",
      audioTestFailed: "无法播放。{hint}",
      rankingStatusIdle: "未获取",
      rankingStatusLoading: "获取中",
      rankingStatusReady: "已显示",
      rankingStatusUnavailable: "Streamlit外",
      scoreStatusNoComplete: "没有已完成的测验",
      scoreStatusIdle: "未保存",
      scoreStatusPending: "保存中",
      scoreStatusSaved: "已保存",
      scoreRecoverableTotals: " / 可重新更新累计",
      serviceWorkerDisabled: "Streamlit 内嵌时禁用",
      unsupported: "不支持",
      serviceWorkerActive: "有效",
      serviceWorkerPending: "等待注册或尚未接管页面",
      browserStorage: "浏览器存储空间",
      audioMissing: "没有音频文件。",
      audioFailed: "无法播放音频。请检查网络状态和音量设置。",
      ariaModeTabs: "出题模式",
      ariaPromptAudio: "播放题目语音",
      ariaChoices: "选项",
      ariaRankingTabs: "排行榜类型",
      ariaLinks: "相关链接",
      ariaMainNav: "主导航",
      personalProgress: "我的累计得分",
      showRecords: "查看记录",
      rankingPublic: "在排行榜中显示",
      rankingPrivacyHint: "关闭后不会显示在排行榜中。仍可保存学习记录，并通过用户名查看。",
      nameAccountHint: "无需密码。任何输入相同用户名的人都能查看、添加记录和更改公开设置。",
      deviceHistoryHint: "从本机最近100条记录中显示此用户名的记录。清除本机记录不会删除累计得分或待发送记录。",
      progressNeedsUser: "输入用户名即可查看该用户名的学习记录。",
      progressUnavailable: "在线版可查看累计得分和更改公开设置。",
      progressPrompt: "点击更新读取学习记录。",
      progressLoading: "正在读取学习记录。",
      progressReady: "正在显示已保存的学习记录。",
      progressFailed: "无法读取学习记录。请检查网络后更新。",
      progressEmpty: "此领域还没有已保存的记录。",
      allFields: "全部",
      vocabBreakdown: "单词・按词性",
      sentenceBreakdown: "例句・按主题",
      uncategorized: "未分类",
      settingsNotLoaded: "读取公开设置后即可更改。",
      settingsSaving: "正在保存公开设置。",
      settingsSaved: "已保存公开设置。",
      settingsFailed: "无法保存公开设置。请更新后确认。",
      settingsUnconfirmed: "无法确认公开设置是否已保存。请更新以查看当前设置。",
      connectionRetry: "请检查网络后再次更新。",
      retryPending: "重发待发送记录",
      pendingRecords: "待发送或待确认：{count}条。重新打开或网络恢复时也会重发。",
      recordSaved: "已保存到用户名下",
      recordPending: "正在确认保存结果",
      recordUnsent: "尚未发送・可重发",
      recordLocal: "仅本机",
      recordUnknown: "旧的本机记录・发送状态未知",
      outboxReadFailed: "无法读取部分待发送记录，原数据已保留。请检查本机存储设置后重新加载。",
      outboxWriteFailed: "无法在本机保存待发送记录。请检查存储空间，并在此结果页重试。",
    },
  },
  ko: {
    htmlLang: "ko",
    intlLocale: "ko-KR",
    name: "한국어",
    esperantoName: "에스페란토",
    appTitle: "에스페란토 4지선다",
    modeVocab: "단어",
    modeSentence: "예문",
    wordUnit: "단어",
    pointUnit: "점",
    labels: {
      legacyViewOnly: "이전 결과(보기 전용)",
      legacyUnknownSaveHint: "이전 저장 상태를 확인할 수 없어 이 결과는 보기 전용으로 가져옵니다. 중복 합산을 막기 위해 재전송하지 않습니다.",
      rankingVisibilityUpdating: "공개 설정을 확인한 후 랭킹을 업데이트합니다.",
      saveBeforeNewQuiz: "미전송 결과를 저장하지 못해 현재 결과를 유지했습니다. 저장을 다시 시도한 후 새 퀴즈를 시작해 주세요.",
      legacyTitle: "이전 버전의 학습 데이터가 있습니다",
      legacyImport: "이 화면으로 가져오기",
      legacyResumeHint: "저장된 문제와 점수를 유지하여 이어서 풀 수 있습니다. 이전 데이터도 보존됩니다.",
      legacyCompleteHint: "완료된 퀴즈를 가져올 수 있습니다. 미전송 점수는 원래 이름의 학습 기록에 자동 저장되며 이전 데이터도 보존됩니다.",
      legacyUnsupported: "이전 데이터는 보존되었지만 이 형식은 자동으로 가져올 수 없습니다. 현재 퀴즈에는 영향이 없습니다.",
      legacyImportFailed: "데이터가 변경되었거나 기기에 저장하지 못해 가져올 수 없습니다. 다시 불러와서 확인해 주세요.",
      legacyImported: "이전 버전의 문제와 점수를 가져왔습니다.",
      loading: "데이터를 불러오는 중입니다",
      ready: "준비 완료",
      userName: "사용자 이름",
      direction: "출제 방향",
      seed: "시드",
      pos: "품사",
      group: "그룹",
      topic: "주제",
      subtopic: "하위 주제",
      levels: "레벨",
      audio: "음성",
      audioPrompt: "문제 자동 재생",
      audioAll: "문제 자동+선택지",
      audioOff: "끄기",
      spartan: "오답 집중 복습",
      start: "퀴즈 시작",
      resumeShort: "이어하기",
      resumeTitle: "저장된 퀴즈가 있습니다",
      resumeAction: "이어하기",
      result: "결과",
      complete: "완료",
      accuracy: "정답률",
      points: "점수",
      correct: "정답",
      saveRanking: "학습 기록 저장",
      retry: "같은 설정으로 다시",
      newQuiz: "새 퀴즈",
      review: "복습",
      history: "학습 기록",
      clearHistory: "기기 기록만 삭제",
      ranking: "랭킹",
      rankingBeforeLoad: "불러오기 전",
      refresh: "새로고침",
      rankingOverall: "누적",
      rankingToday: "오늘",
      rankingMonth: "이번 달",
      rankingHof: "명예의 전당",
      diagnostics: "진단",
      reload: "다시 불러오기",
      navHome: "홈",
      navQuiz: "퀴즈",
      navHistory: "학습 기록",
      navDiagnostics: "진단",
      languageLinks: "언어",
      loadFailed: "불러오기에 실패했습니다",
      next: "다음",
      unknown: "알 수 없음",
      none: "없음",
      error: "오류",
      dataShortage: "퀴즈 데이터가 부족합니다.",
      clearHistoryConfirm: "이 이름의 기기 기록만 지웁니다. 누적 점수, 미전송 기록, 진행 중인 퀴즈는 남습니다. 계속할까요?",
      clearHistoryDone: "이 이름의 기기 기록만 지웠습니다. 누적 점수와 미전송 기록은 남아 있습니다.",
      scoreSavedMessage: "학습 기록을 저장했습니다.",
      scoreSaveFailedMessage: "저장에 실패했습니다.",
      rankingUpdatedMessage: "랭킹을 표시했습니다.",
      rankingFailedMessage: "랭킹을 가져오지 못했습니다.",
      scorePendingRestored: "이전 저장 결과를 확인 중입니다. 같은 저장 ID로 안전하게 재전송하여 중복 가산을 막습니다.",
      saveFailed: "저장할 수 없습니다",
      historySavedAfterCleanup: "기록을 정리하고 저장함",
      historyCleanupToast: "기기 저장 공간이 부족하여 오래된 성적 기록을 정리했습니다.",
      sessionCleanupToast: "기기 저장 공간이 부족하여 성적 기록을 정리하고 퀴즈 상태를 저장했습니다.",
      autoSaved: "자동 저장됨",
      sessionDiscarded: "진행 중인 퀴즈를 폐기했습니다",
      rankingUnavailable: "랭킹은 온라인 버전에서 볼 수 있습니다.",
      rankingLoading: "랭킹을 불러오는 중입니다.",
      rankingTimeout: "랭킹을 불러오는 데 시간이 걸리고 있습니다. 통신 상태를 확인한 뒤 새로고침을 누르세요.",
      replaceActiveConfirm: "진행 중인 퀴즈가 있습니다. 현재 진행을 끝내고 새 퀴즈를 시작할까요?",
      activeKept: "진행 중인 퀴즈를 유지했습니다.",
      noQuestions: "선택한 조건으로는 문제를 만들 수 없습니다.",
      reviewPhase: "복습",
      streak: "연속",
      remaining: "남음",
      choiceAudioAria: "선택지 음성 재생",
      incorrectPrefix: "오답. 정답",
      scoreUnavailable: "온라인 버전에서 계정에 기록을 저장할 수 있습니다.",
      scoreNeedsUser: "이름을 입력하고 시작한 퀴즈는 완료 시 학습 기록이 자동 저장됩니다.",
      scoreSaving: "저장 중...",
      scoreSavingMessage: "학습 기록을 저장하고 있습니다.",
      scoreSavedButton: "학습 기록 저장 완료",
      scoreSavedAdd: "이번 {points}점을 학습 기록에 더했습니다.",
      scoreRetryTotals: "누적 점수 다시 업데이트",
      scoreRetryMessage: "저장에 실패했습니다. 다시 시도해 주세요.",
      scoreWillAdd: "이번 {points}점을 학습 기록에 저장합니다.",
      scoreUserRequired: "저장하려면 사용자 이름이 필요합니다.",
      scoreRetryLimit: "저장 결과를 확인하지 못했습니다. 연결을 확인하고 학습 기록 저장 또는 학습 기록 화면의 재전송을 눌러 주세요.",
      scoreAutoRetry: "연결을 확인하며 자동으로 재전송합니다. 같은 기록은 중복 합산되지 않습니다.",
      noWrongTitle: "틀린 문제가 없습니다",
      noWrongBody: "이 결과는 기기의 학습 기록에 저장되어 있습니다.",
      reviewAudioAria: "에스페란토 정답 음성 재생",
      answer: "선택",
      rankingRetry: "재시도",
      rankingLoadingShort: "불러오는 중입니다.",
      rankingIdle: "업데이트 전",
      rankingPrompt: "새로고침을 누르면 랭킹을 가져옵니다.",
      rankingSecretHint: "Streamlit Cloud Secrets 설정과 Google Sheets 공유 권한을 확인하세요.",
      rankingEmpty: "{tab} 랭킹은 아직 없습니다.",
      currentUser: "나",
      historyEmptyTitle: "이 이름의 기기 기록이 없습니다",
      historyEmptyBody: "이 기기에서 퀴즈를 완료하면 여기에 표시됩니다.",
      noStoredQuiz: "저장된 퀴즈 없음",
      appVersion: "앱 버전",
      runtime: "실행 환경",
      streamlitEmbedded: "Streamlit Cloud 내장",
      staticPwa: "정적/PWA",
      quizData: "퀴즈 데이터",
      entriesCount: "단어 {vocab}개 / 예문 {sentences}개",
      audioSettings: "음성 설정",
      audioManifest: "음성 manifest",
      quizSave: "퀴즈 저장",
      localHistory: "기기 기록",
      storageUse: "기기 저장 사용량",
      storageApprox: "대략 {value}",
      storageUnused: "사용 안 함",
      scoreSave: "점수 저장",
      vocabAudioTest: "단어 음성 테스트",
      sentenceAudioTest: "예문 음성 테스트",
      sessionActive: "진행 중",
      audioVocabUrl: "단어 URL 있음",
      audioSentenceUrl: "예문 URL 있음",
      audioDriveFallback: "Drive 대체 있음",
      audioNoUrl: "음성 URL 없음",
      sample: "샘플",
      noAudioTest: "테스트 가능한 음성이 없습니다",
      audioPlaying: "재생 중...",
      audioTest: "재생 테스트",
      audioTestMissing: "테스트 가능한 음성을 찾을 수 없습니다.",
      audioTesting: "{key}.wav를 재생하고 있습니다.",
      audioTestSuccess: "{key}.wav를 재생했습니다.",
      audioTestToast: "{mode} 음성을 재생했습니다.",
      audioTestFailed: "재생할 수 없었습니다. {hint}",
      rankingStatusIdle: "가져오기 전",
      rankingStatusLoading: "가져오는 중",
      rankingStatusReady: "표시됨",
      rankingStatusUnavailable: "Streamlit 외부",
      scoreStatusNoComplete: "완료된 퀴즈 없음",
      scoreStatusIdle: "미저장",
      scoreStatusPending: "저장 중",
      scoreStatusSaved: "저장됨",
      scoreRecoverableTotals: " / 누적 재업데이트 가능",
      serviceWorkerDisabled: "Streamlit 내장에서는 비활성",
      unsupported: "미지원",
      serviceWorkerActive: "활성",
      serviceWorkerPending: "등록 대기 또는 제어되지 않음",
      browserStorage: "브라우저 저장 공간",
      audioMissing: "음성 파일이 없습니다.",
      audioFailed: "음성을 재생할 수 없었습니다. 통신 상태와 음량 설정을 확인하세요.",
      ariaModeTabs: "출제 모드",
      ariaPromptAudio: "문항 음성 재생",
      ariaChoices: "선택지",
      ariaRankingTabs: "랭킹 종류",
      ariaLinks: "관련 링크",
      ariaMainNav: "메인",
      personalProgress: "나의 누적 점수",
      showRecords: "기록 보기",
      rankingPublic: "랭킹에 표시하기",
      rankingPrivacyHint: "끄면 랭킹 목록에 표시되지 않습니다. 학습 기록 저장과 이름으로 조회하는 기능은 계속 사용할 수 있습니다.",
      nameAccountHint: "비밀번호는 필요 없습니다. 같은 이름을 입력하면 누구나 기록 조회·추가 및 공개 설정 변경을 할 수 있습니다.",
      deviceHistoryHint: "이 기기의 최근 100건 중 입력한 이름의 기록을 표시합니다. 기록을 지워도 누적 점수와 미전송 기록은 남습니다.",
      progressNeedsUser: "이름을 입력하면 해당 이름의 학습 기록을 볼 수 있습니다.",
      progressUnavailable: "누적 점수와 공개 설정은 온라인 버전에서 사용할 수 있습니다.",
      progressPrompt: "새로고침을 누르면 학습 기록을 불러옵니다.",
      progressLoading: "학습 기록을 불러오고 있습니다.",
      progressReady: "저장된 학습 기록을 표시합니다.",
      progressFailed: "학습 기록을 불러오지 못했습니다. 연결을 확인하고 새로고침해 주세요.",
      progressEmpty: "이 분야에는 아직 저장된 기록이 없습니다.",
      allFields: "전체",
      vocabBreakdown: "단어·품사별",
      sentenceBreakdown: "예문·주제별",
      uncategorized: "미분류",
      settingsNotLoaded: "공개 설정을 확인한 후 변경할 수 있습니다.",
      settingsSaving: "공개 설정을 저장하고 있습니다.",
      settingsSaved: "공개 설정을 저장했습니다.",
      settingsFailed: "공개 설정을 저장하지 못했습니다. 새로고침하여 확인해 주세요.",
      settingsUnconfirmed: "공개 설정의 저장 결과를 확인하지 못했습니다. 새로고침하여 현재 설정을 확인해 주세요.",
      connectionRetry: "연결을 확인하고 다시 새로고침해 주세요.",
      retryPending: "미전송 기록 재전송",
      pendingRecords: "미전송·확인 대기 기록: {count}건. 다시 열거나 연결이 복구되면 재전송합니다.",
      recordSaved: "계정에 저장됨",
      recordPending: "계정 저장 확인 중",
      recordUnsent: "미전송·재전송 가능",
      recordLocal: "기기에만 저장됨",
      recordUnknown: "이전 기기 기록·전송 상태 알 수 없음",
      outboxReadFailed: "일부 미전송 기록을 읽지 못했습니다. 기존 데이터는 보존했습니다. 저장 공간 설정을 확인하고 다시 불러와 주세요.",
      outboxWriteFailed: "미전송 기록을 기기에 저장하지 못했습니다. 저장 공간을 확인한 후 이 결과 화면에서 다시 시도해 주세요.",
    },
  },
};

const POS_LABELS = {
  ja: {
    noun: "名詞",
    verb: "動詞",
    adjective: "形容詞",
    adverb: "副詞",
    preposition: "前置詞",
    conjunction: "接続詞",
    prefix: "接頭辞",
    suffix: "接尾辞",
    correlative: "相関詞",
    numeral: "数詞",
    bare_adverb: "原形副詞",
    pronoun: "代名詞",
    personal_pronoun: "代名詞",
    other: "その他",
  },
  zh: {
    noun: "名词",
    verb: "动词",
    adjective: "形容词",
    adverb: "副词",
    preposition: "介词",
    conjunction: "连词",
    prefix: "前缀",
    suffix: "后缀",
    correlative: "相关词",
    numeral: "数词",
    bare_adverb: "原形副词",
    pronoun: "代词",
    personal_pronoun: "代词",
    other: "其他",
  },
  ko: {
    noun: "명사",
    verb: "동사",
    adjective: "형용사",
    adverb: "부사",
    preposition: "전치사",
    conjunction: "접속사",
    prefix: "접두사",
    suffix: "접미사",
    correlative: "상관사",
    numeral: "수사",
    bare_adverb: "원형 부사",
    pronoun: "대명사",
    personal_pronoun: "대명사",
    other: "기타",
  },
};

const POS_ORDER = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "preposition",
  "conjunction",
  "pronoun",
  "correlative",
  "numeral",
  "prefix",
  "suffix",
  "bare_adverb",
  "other",
];

const STAGE_LABELS = {
  ja: {
    beginner: "初級",
    intermediate: "中級",
    advanced: "上級",
  },
  zh: {
    beginner: "初级",
    intermediate: "中级",
    advanced: "高级",
  },
  ko: {
    beginner: "초급",
    intermediate: "중급",
    advanced: "고급",
  },
};

const DEFAULT_SETTINGS = {
  mode: "vocab",
  userName: "",
  direction: "eo_to_ja",
  seed: 1,
  pos: "noun",
  groupId: "",
  topic: "",
  subtopic: "",
  levels: [],
  audioMode: "prompt",
  spartanMode: true,
};

const STREAMLIT_API_VERSION = 1;

const streamlitHost = {
  send(type, payload = {}) {
    if (window.parent === window) {
      return;
    }
    window.parent.postMessage({
      isStreamlitMessage: true,
      type,
      ...payload,
    }, "*");
  },
  ready() {
    this.send("streamlit:componentReady", { apiVersion: STREAMLIT_API_VERSION });
  },
  setFrameHeight(height) {
    this.send("streamlit:setFrameHeight", { height });
  },
  setComponentValue(value) {
    this.send("streamlit:setComponentValue", { value });
  },
};

const els = {
  app: document.querySelector("#app"),
  saveStatus: document.querySelector("#saveStatus"),
  resumeButton: document.querySelector("#resumeButton"),
  loadingView: document.querySelector("#loadingView"),
  setupView: document.querySelector("#setupView"),
  quizView: document.querySelector("#quizView"),
  resultView: document.querySelector("#resultView"),
  historyView: document.querySelector("#historyView"),
  diagnosticsView: document.querySelector("#diagnosticsView"),
  errorView: document.querySelector("#errorView"),
  errorMessage: document.querySelector("#errorMessage"),
  reloadButton: document.querySelector("#reloadButton"),
  modeVocab: document.querySelector("#modeVocab"),
  modeSentence: document.querySelector("#modeSentence"),
  loadingText: document.querySelector("#loadingView p"),
  legacyNotice: document.querySelector("#legacyNotice"),
  legacyNoticeTitle: document.querySelector("#legacyNoticeTitle"),
  legacyNoticeMessage: document.querySelector("#legacyNoticeMessage"),
  legacyImportButton: document.querySelector("#legacyImportButton"),
  resumeNotice: document.querySelector("#resumeNotice"),
  resumeNoticeTitle: document.querySelector("#resumeNotice strong"),
  resumeMeta: document.querySelector("#resumeMeta"),
  resumeNoticeButton: document.querySelector("#resumeNoticeButton"),
  setupForm: document.querySelector("#setupForm"),
  userName: document.querySelector("#userName"),
  directionSelect: document.querySelector("#directionSelect"),
  vocabSettings: document.querySelector("#vocabSettings"),
  sentenceSettings: document.querySelector("#sentenceSettings"),
  seedInput: document.querySelector("#seedInput"),
  posSelect: document.querySelector("#posSelect"),
  groupSelect: document.querySelector("#groupSelect"),
  topicSelect: document.querySelector("#topicSelect"),
  subtopicSelect: document.querySelector("#subtopicSelect"),
  levelChips: document.querySelector("#levelChips"),
  audioMode: document.querySelector("#audioMode"),
  spartanMode: document.querySelector("#spartanMode"),
  startButton: document.querySelector("#startButton"),
  phaseLabel: document.querySelector("#phaseLabel"),
  promptText: document.querySelector("#promptText"),
  promptAudioButton: document.querySelector("#promptAudioButton"),
  progressBar: document.querySelector("#progressBar"),
  correctStat: document.querySelector("#correctStat"),
  streakStat: document.querySelector("#streakStat"),
  remainingStat: document.querySelector("#remainingStat"),
  feedbackPanel: document.querySelector("#feedbackPanel"),
  feedbackText: document.querySelector("#feedbackText"),
  nextButton: document.querySelector("#nextButton"),
  choiceGrid: document.querySelector("#choiceGrid"),
  resultTitle: document.querySelector("#resultTitle"),
  accuracyMetric: document.querySelector("#accuracyMetric"),
  pointsMetric: document.querySelector("#pointsMetric"),
  countMetric: document.querySelector("#countMetric"),
  syncScoreButton: document.querySelector("#syncScoreButton"),
  syncScoreStatus: document.querySelector("#syncScoreStatus"),
  retryButton: document.querySelector("#retryButton"),
  newQuizButton: document.querySelector("#newQuizButton"),
  reviewList: document.querySelector("#reviewList"),
  cloudRankingTitle: document.querySelector("#cloudRankingTitle"),
  historyList: document.querySelector("#historyList"),
  progressTitle: document.querySelector("#progressTitle"),
  progressStatus: document.querySelector("#progressStatus"),
  progressRefreshButton: document.querySelector("#progressRefreshButton"),
  progressContent: document.querySelector("#progressContent"),
  rankingPublic: document.querySelector("#rankingPublic"),
  rankingPublicLabel: document.querySelector("#rankingPublicLabel"),
  rankingPrivacyHint: document.querySelector("#rankingPrivacyHint"),
  rankingSettingsStatus: document.querySelector("#rankingSettingsStatus"),
  historyUserForm: document.querySelector("#historyUserForm"),
  historyUserName: document.querySelector("#historyUserName"),
  historyUserButton: document.querySelector("#historyUserButton"),
  deviceHistoryTitle: document.querySelector("#deviceHistoryTitle"),
  deviceHistoryHint: document.querySelector("#deviceHistoryHint"),
  retryPendingButton: document.querySelector("#retryPendingButton"),
  outboxStatus: document.querySelector("#outboxStatus"),
  cloudRankingSection: document.querySelector("#cloudRankingSection"),
  rankingStatus: document.querySelector("#rankingStatus"),
  rankingRefreshButton: document.querySelector("#rankingRefreshButton"),
  rankingTabs: document.querySelectorAll("[data-ranking-tab]"),
  rankingList: document.querySelector("#rankingList"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  diagnosticsRefreshButton: document.querySelector("#diagnosticsRefreshButton"),
  diagnosticsList: document.querySelector("#diagnosticsList"),
  resultPhaseLabel: document.querySelector("#resultView .phase-label"),
  resultMetricLabels: document.querySelectorAll("#resultView .result-metrics small"),
  reviewTitle: document.querySelector(".review-section h3"),
  historyTitle: document.querySelector("#historyView h2"),
  diagnosticsTitle: document.querySelector("#diagnosticsView h2"),
  errorTitle: document.querySelector("#errorView h2"),
  languageLinksLabel: document.querySelector("#languageLinksLabel"),
  jaAppLink: document.querySelector("#jaAppLink"),
  zhAppLink: document.querySelector("#zhAppLink"),
  koAppLink: document.querySelector("#koAppLink"),
  homeNav: document.querySelector("#homeNav"),
  quizNav: document.querySelector("#quizNav"),
  historyNav: document.querySelector("#historyNav"),
  diagnosticsNav: document.querySelector("#diagnosticsNav"),
  toast: document.querySelector("#toast"),
};

const state = {
  data: {
    vocab: [],
    sentences: [],
    audioManifest: createEmptyAudioManifest(),
  },
  vocabGroups: [],
  settings: { ...DEFAULT_SETTINGS },
  mobileConfig: {
    targetLang: detectInitialTargetLang(),
    defaultMode: detectInitialDefaultMode(),
    source: "static",
  },
  audioConfig: { ...DEFAULT_AUDIO_CONFIG },
  session: null,
  history: [],
  currentView: "loading",
  saveTimer: null,
  frameHeightTimer: null,
  lastFrameHeight: 0,
  latestScoreSyncResult: null,
  rankings: createEmptyRankingsState(),
  progress: createEmptyProgressState(),
  outbox: [],
  outboxReadFailed: false,
  outboxRetryTimeout: null,
  mobileConfigReady: !IS_STREAMLIT_COMPONENT,
  legacyCandidate: null,
  legacyInspectionToken: 0,
  audioPlayer: null,
  audioPlaybackToken: 0,
  autoPromptAudioAllowedUntil: 0,
  lastAutoPromptAudioKey: "",
  audioDiagnostics: {
    vocab: { status: "idle", message: "", audioKey: "" },
    sentence: { status: "idle", message: "", audioKey: "" },
  },
  diagnosticsRenderToken: 0,
};

const bridgeQueue = new SerializedBridge({
  send: (payload) => streamlitHost.setComponentValue(payload),
  onTimeout: handleBridgeTimeout,
});

init().catch((error) => {
  showFatalError(error);
});

async function init() {
  installStreamlitMessageHandler();
  streamlitHost.ready();
  installFrameHeightSync();
  bindEvents();
  loadLocalState();
  applyDefaultModeToIdleState();
  applyStaticText();
  setView("loading");
  await registerServiceWorker();
  const [vocabPayload, sentencePayload, audioManifestPayload] = await Promise.all([
    fetchJson(DATA_URLS.vocab),
    fetchJson(DATA_URLS.sentences),
    fetchOptionalJson(DATA_URLS.audioManifest, createEmptyAudioManifest()),
  ]);
  state.data.vocab = Array.isArray(vocabPayload.entries) ? vocabPayload.entries : [];
  state.data.sentences = Array.isArray(sentencePayload.entries) ? sentencePayload.entries : [];
  state.data.audioManifest = sanitizeAudioManifest(audioManifestPayload);
  state.audioConfig = normalizeAudioConfig(state.audioConfig);
  if (state.data.vocab.length < 4 || state.data.sentences.length < 4) {
    throw new Error(t("dataShortage"));
  }
  state.vocabGroups = buildVocabGroups(state.data.vocab, state.settings.seed);
  normalizeSettings();
  renderSetup();
  refreshResumeButton();
  if (isActiveSession(state.session)) {
    setView("quiz");
    renderQuiz();
  } else if (isCompleteSession(state.session)) {
    setView("result");
    renderResult();
  } else {
    setView("setup");
  }
  restorePendingScores();
  inspectStoredLegacyQuiz();
  updateSaveStatus(t("ready"));
}

function bindEvents() {
  els.reloadButton.addEventListener("click", () => window.location.reload());
  els.resumeButton.addEventListener("click", resumeStoredSession);
  els.resumeNoticeButton.addEventListener("click", resumeStoredSession);
  els.legacyImportButton.addEventListener("click", importLegacyQuiz);

  els.modeVocab.addEventListener("click", () => switchMode("vocab"));
  els.modeSentence.addEventListener("click", () => switchMode("sentence"));
  els.setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    allowAutoPromptAudioFromUserAction();
    startQuiz();
  });

  els.userName.addEventListener("input", persistSettingsFromForm);
  els.historyUserForm.addEventListener("submit", (event) => {
    event.preventDefault();
    changeCurrentUser(els.historyUserName.value);
    requestProgress({ force: true });
    requestRankings({ force: true });
  });
  els.progressRefreshButton.addEventListener("click", () => requestProgress({ force: true }));
  els.rankingPublic.addEventListener("change", saveRankingVisibility);
  els.retryPendingButton.addEventListener("click", () => retryPendingScores(currentUserName()));
  els.directionSelect.addEventListener("change", persistSettingsFromForm);
  els.seedInput.addEventListener("change", () => {
    persistSettingsFromForm();
    state.vocabGroups = buildVocabGroups(state.data.vocab, state.settings.seed);
    ensureVocabSelection();
    renderVocabControls();
    saveSettings();
  });
  els.posSelect.addEventListener("change", () => {
    state.settings.pos = els.posSelect.value;
    ensureVocabSelection(true);
    renderVocabControls();
    saveSettings();
  });
  els.groupSelect.addEventListener("change", persistSettingsFromForm);
  els.topicSelect.addEventListener("change", () => {
    state.settings.topic = els.topicSelect.value;
    ensureSentenceSelection(true);
    renderSentenceControls();
    saveSettings();
  });
  els.subtopicSelect.addEventListener("change", () => {
    state.settings.subtopic = els.subtopicSelect.value;
    ensureSentenceLevels(true);
    renderSentenceControls();
    saveSettings();
  });
  els.audioMode.addEventListener("change", persistSettingsFromForm);
  els.spartanMode.addEventListener("change", persistSettingsFromForm);

  els.promptAudioButton.addEventListener("click", () => {
    const current = getCurrentQuestion();
    if (current && state.session && canPlayPromptAudio(state.session, current)) {
      playAudio(current.mode, current.options[current.answerIndex]);
    }
  });
  els.nextButton.addEventListener("click", advanceAfterFeedback);
  els.syncScoreButton.addEventListener("click", syncScoreToSheets);
  els.retryButton.addEventListener("click", () => {
    allowAutoPromptAudioFromUserAction();
    retrySession();
  });
  els.newQuizButton.addEventListener("click", () => {
    if (clearStoredSession()) setView("setup");
  });
  els.clearHistoryButton.addEventListener("click", () => {
    if (!state.history.length) {
      return;
    }
    if (window.confirm(t("clearHistoryConfirm"))) {
      state.history = state.history.filter((record) => String(record.userName || "").trim() !== currentUserName());
      saveHistory();
      renderHistory();
      showToast(t("clearHistoryDone"));
    }
  });
  els.rankingRefreshButton.addEventListener("click", () => requestRankings({ force: true }));
  els.rankingTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.rankings.activeTab = button.dataset.rankingTab || "overall";
      renderCloudRankings();
    });
  });

  els.homeNav.addEventListener("click", () => setView("setup"));
  els.quizNav.addEventListener("click", () => {
    if (isActiveSession(state.session)) {
      allowAutoPromptAudioFromUserAction();
      setView("quiz");
      renderQuiz();
    } else if (isCompleteSession(state.session)) {
      setView("result");
      renderResult();
    } else {
      allowAutoPromptAudioFromUserAction();
      setView("setup");
      startQuiz();
    }
  });
  els.historyNav.addEventListener("click", () => {
    renderHistory();
    setView("history");
    requestProgress();
    requestRankings();
  });
  els.diagnosticsNav.addEventListener("click", () => setView("diagnostics"));
  els.diagnosticsRefreshButton.addEventListener("click", renderDiagnostics);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveSession();
      saveSettings();
    }
  });
  window.addEventListener("online", () => retryPendingScores());
  window.addEventListener("storage", (event) => {
    if (event.key === OUTBOX_KEY || event.key?.startsWith(OUTBOX_ENTRY_PREFIX)) {
      loadPendingScoresFromStorage();
      refreshScoreViews();
    }
  });
  window.addEventListener("beforeunload", () => {
    saveSession();
    saveSettings();
  });
}

async function inspectStoredLegacyQuiz() {
  if (!state.mobileConfigReady || !hasLoadedQuizData()) return;
  const token = ++state.legacyInspectionToken;
  const targetLang = state.mobileConfig.targetLang;
  const mode = state.settings.mode;
  try {
    const candidate = await inspectLegacySession({
      storage: window.localStorage, targetLang, mode,
      source: state.mobileConfig.source, appVersion: APP_VERSION,
      currentSession: state.session, sentenceEntries: state.data.sentences, sessionKey: SESSION_KEY,
    });
    if (token !== state.legacyInspectionToken || targetLang !== state.mobileConfig.targetLang
        || mode !== state.settings.mode) return;
    if (state.session) {
      state.legacyCandidate = null;
      els.legacyNotice.hidden = true;
      return;
    }
    state.legacyCandidate = candidate.status === "ready" ? candidate : null;
    els.legacyNotice.hidden = !["ready", "unsupported", "invalid"].includes(candidate.status);
    els.legacyImportButton.hidden = candidate.status !== "ready";
    els.legacyNoticeMessage.textContent = candidate.status !== "ready" ? t("legacyUnsupported")
      : isLegacyScoreSaveBlocked(candidate.session) ? t("legacyUnknownSaveHint")
      : candidate.session.status === "complete" && candidate.session.scoreSyncStatus !== "saved"
        ? t("legacyCompleteHint") : t("legacyResumeHint");
    requestFrameHeightSync();
  } catch (error) {
    console.warn("Could not inspect previous quiz", error);
    els.legacyNotice.hidden = false;
    els.legacyImportButton.hidden = true;
    els.legacyNoticeMessage.textContent = t("legacyUnsupported");
  }
}

function importLegacyQuiz() {
  const candidate = state.legacyCandidate;
  if (!candidate || state.session) return;
  const converted = sanitizeSession(candidate.session);
  if (!converted) {
    els.legacyNoticeMessage.textContent = t("legacyUnsupported");
    return;
  }
  const imported = commitLegacySessionImport({ storage: window.localStorage, candidate, sessionKey: SESSION_KEY });
  if (!imported.ok) {
    els.legacyNoticeMessage.textContent = t("legacyImportFailed");
    return;
  }
  state.session = converted;
  state.settings = { ...converted.settings };
  invalidateAccountData();
  normalizeSettings();
  renderSetup();
  state.legacyCandidate = null;
  els.legacyNotice.hidden = true;
  if (isCompleteSession(converted)) {
    finishSession();
    setView("result");
    renderResult();
  } else {
    setView("quiz");
    renderQuiz();
  }
  showToast(t("legacyImported"));
}

function resumeStoredSession() {
  if (isActiveSession(state.session)) {
    allowAutoPromptAudioFromUserAction();
    setView("quiz");
    renderQuiz();
  } else if (isCompleteSession(state.session)) {
    setView("result");
    renderResult();
    pumpScoreOutbox();
  }
}

function installStreamlitMessageHandler() {
  if (!IS_STREAMLIT_COMPONENT) {
    return;
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent || !message || message.type !== "streamlit:render") {
      return;
    }
    if (message.args?.audioConfig) {
      applyAudioConfig(message.args.audioConfig);
    }
    if (message.args?.mobileConfig) {
      applyMobileConfig(message.args.mobileConfig);
    }
    if (message.args?.progressResult) handleProgressResult(message.args.progressResult);
    if (message.args?.userSettingsResult) handleUserSettingsResult(message.args.userSettingsResult);
    const result = message.args?.scoreSyncResult;
    if (result) {
      handleScoreSyncResult(result);
    }
    const rankingResult = message.args?.rankingResult;
    if (rankingResult) {
      handleRankingResult(rankingResult);
    }
  });
}

function detectInitialTargetLang() {
  const params = new URLSearchParams(window.location.search);
  return normalizeTargetLang(params.get("lang") || params.get("target_lang") || params.get("targetLang") || "ja");
}

function detectInitialDefaultMode() {
  const params = new URLSearchParams(window.location.search);
  const mode = String(params.get("quiz") || params.get("mode") || params.get("defaultMode") || "").trim().toLowerCase();
  return ["vocab", "sentence"].includes(mode) ? mode : DEFAULT_SETTINGS.mode;
}

function normalizeTargetLang(value) {
  const text = String(value || "").trim().toLowerCase().replace("_", "-");
  if (["zh", "cn", "zh-cn", "zh-hans", "chinese"].includes(text)) {
    return "zh";
  }
  if (["ko", "kr", "korean"].includes(text)) {
    return "ko";
  }
  return SUPPORTED_TARGET_LANGS.has(text) ? text : "ja";
}

function normalizeDefaultMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["vocab", "sentence"].includes(mode) ? mode : DEFAULT_SETTINGS.mode;
}

function currentLangMeta() {
  return TARGET_LANG_META[state.mobileConfig.targetLang] || TARGET_LANG_META.ja;
}

function t(key) {
  const meta = currentLangMeta();
  return meta.labels[key] || TARGET_LANG_META.ja.labels[key] || key;
}

function formatText(key, replacements = {}) {
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    t(key),
  );
}

function modeLabel(mode) {
  return mode === "sentence" ? currentLangMeta().modeSentence : currentLangMeta().modeVocab;
}

function currentModeForLinks() {
  return normalizeDefaultMode(state.settings.mode || state.mobileConfig.defaultMode);
}

function buildPublicAppUrl(lang, params = {}) {
  const base = PUBLIC_APP_URLS[normalizeTargetLang(lang)] || PUBLIC_APP_URLS.ja;
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function setCurrentLink(link, isCurrent) {
  if (!link) {
    return;
  }
  link.setAttribute("target", "_blank");
  link.classList.toggle("is-active", Boolean(isCurrent));
  if (isCurrent) {
    link.setAttribute("aria-current", "page");
  } else {
    link.removeAttribute("aria-current");
  }
}

function renderAppLinks() {
  const mode = currentModeForLinks();
  const lang = state.mobileConfig.targetLang;
  const languageLinks = [
    [els.jaAppLink, "ja", TARGET_LANG_META.ja.name],
    [els.zhAppLink, "zh", TARGET_LANG_META.zh.name],
    [els.koAppLink, "ko", TARGET_LANG_META.ko.name],
  ];

  languageLinks.forEach(([link, targetLang, label]) => {
    if (!link) {
      return;
    }
    link.textContent = label;
    link.href = buildPublicAppUrl(targetLang, { quiz: mode });
    link.setAttribute("rel", "noopener noreferrer");
    setCurrentLink(link, targetLang === lang);
  });


}

function applyMobileConfig(config) {
  state.mobileConfigReady = true;
  const candidate = isPlainObject(config) ? config : {};
  const next = {
    source: String(candidate.source || state.mobileConfig.source || "static"),
    targetLang: normalizeTargetLang(candidate.targetLang || state.mobileConfig.targetLang),
    defaultMode: normalizeDefaultMode(candidate.defaultMode || state.mobileConfig.defaultMode),
  };
  const previousLang = state.mobileConfig.targetLang;
  const previous = JSON.stringify(state.mobileConfig);
  state.mobileConfig = next;
  if (previousLang !== next.targetLang) invalidateAccountData();
  if (previous !== JSON.stringify(state.mobileConfig)) {
    const isIdle = !isActiveSession(state.session) && !isCompleteSession(state.session);
    if (isIdle) {
      applyDefaultModeToIdleState();
    }
    applyStaticText();
    if (isIdle && hasLoadedQuizData()) {
      renderSetup();
    } else if (state.currentView === "history") {
      renderHistory();
    } else if (state.currentView === "diagnostics") {
      renderDiagnostics();
    }
  }
  inspectStoredLegacyQuiz();
}

function applyDefaultModeToIdleState() {
  if (!isActiveSession(state.session) && !isCompleteSession(state.session)) {
    state.settings.mode = state.mobileConfig.defaultMode;
  }
}

function hasLoadedQuizData() {
  return state.data.vocab.length >= 4 && state.data.sentences.length >= 4;
}

function applyStaticText() {
  const meta = currentLangMeta();
  document.documentElement.lang = meta.htmlLang;
  document.title = meta.appTitle;
  const appleTitle = document.querySelector("meta[name='apple-mobile-web-app-title']");
  if (appleTitle) {
    appleTitle.setAttribute("content", meta.appTitle);
  }
  const brandTitle = document.querySelector(".brand-copy h1");
  if (brandTitle) {
    brandTitle.textContent = meta.appTitle;
  }
  setText(els.loadingText, t("loading"));
  setText(els.modeVocab, meta.modeVocab);
  setText(els.modeSentence, meta.modeSentence);
  setText(els.resumeButton, t("resumeShort"));
  setText(els.resumeNoticeTitle, t("resumeTitle"));
  setText(els.legacyNoticeTitle, t("legacyTitle"));
  setText(els.legacyImportButton, t("legacyImport"));
  setText(els.resumeNoticeButton, t("resumeAction"));
  setText(document.querySelector("label[for='userName']"), t("userName"));
  setText(document.querySelector("label[for='directionSelect']"), t("direction"));
  setText(document.querySelector("label[for='seedInput']"), t("seed"));
  setText(document.querySelector("label[for='posSelect']"), t("pos"));
  setText(document.querySelector("label[for='groupSelect']"), t("group"));
  setText(document.querySelector("label[for='topicSelect']"), t("topic"));
  setText(document.querySelector("label[for='subtopicSelect']"), t("subtopic"));
  setText(document.querySelector(".chip-fieldset legend"), t("levels"));
  setText(document.querySelector("label[for='audioMode']"), t("audio"));
  setText(document.querySelector("#spartanMode + span"), t("spartan"));
  setText(els.startButton, t("start"));
  setText(els.resultPhaseLabel, t("result"));
  setText(els.syncScoreButton, t("saveRanking"));
  setText(els.retryButton, t("retry"));
  setText(els.newQuizButton, t("newQuiz"));
  setText(els.reviewTitle, t("review"));
  setText(els.historyTitle, t("history"));
  setText(els.clearHistoryButton, t("clearHistory"));
  setText(els.cloudRankingTitle, t("ranking"));
  if (els.rankingStatus?.textContent === TARGET_LANG_META.ja.labels.rankingBeforeLoad || !els.rankingStatus?.textContent) {
    setText(els.rankingStatus, t("rankingBeforeLoad"));
  }
  setText(els.rankingRefreshButton, t("refresh"));
  setText(els.diagnosticsTitle, t("diagnostics"));
  setText(els.diagnosticsRefreshButton, t("refresh"));
  setText(els.errorTitle, t("loadFailed"));
  setText(els.reloadButton, t("reload"));
  setText(els.nextButton, t("next"));
  setText(els.homeNav, t("navHome"));
  setText(els.quizNav, t("navQuiz"));
  setText(els.historyNav, t("navHistory"));
  setText(els.diagnosticsNav, t("navDiagnostics"));
  setText(els.languageLinksLabel, t("languageLinks"));
  setText(els.progressTitle, t("personalProgress"));
  setText(els.progressRefreshButton, t("refresh"));
  setText(els.rankingPublicLabel, t("rankingPublic"));
  setText(els.rankingPrivacyHint, t("rankingPrivacyHint"));
  setText(els.historyUserButton, t("showRecords"));
  setText(document.querySelector("label[for='historyUserName']"), t("userName"));
  setText(els.deviceHistoryTitle, t("localHistory"));
  setText(els.deviceHistoryHint, t("deviceHistoryHint"));
  setText(els.retryPendingButton, t("retryPending"));
  document.querySelectorAll(".name-account-hint").forEach((element) => setText(element, t("nameAccountHint")));
  els.resultMetricLabels.forEach((node, index) => {
    setText(node, [t("accuracy"), t("points"), t("correct")][index]);
  });
  [
    [".segmented-control[role='tablist']", t("ariaModeTabs")],
    ["#promptAudioButton", t("ariaPromptAudio")],
    ["#choiceGrid", t("ariaChoices")],
    [".ranking-tabs[role='tablist']", t("ariaRankingTabs")],
    ["#appLinkPanel", t("ariaLinks")],
    [".bottom-nav", t("ariaMainNav")],
  ].forEach(([selector, label]) => {
    const node = document.querySelector(selector);
    if (node && label) {
      node.setAttribute("aria-label", label);
    }
  });
  setAudioModeLabels();
  setRankingTabLabels();
  updateDirectionLabels();
  renderAppLinks();
}

function setText(element, text) {
  if (element) {
    element.textContent = text;
  }
}

function setAudioModeLabels() {
  [...els.audioMode.options].forEach((option) => {
    option.textContent = {
      prompt: t("audioPrompt"),
      all: t("audioAll"),
      off: t("audioOff"),
    }[option.value] || option.textContent;
  });
}

function setRankingTabLabels() {
  els.rankingTabs.forEach((button) => {
    button.textContent = rankingTabLabel(button.dataset.rankingTab || "overall");
  });
}

function updateDirectionLabels() {
  const meta = currentLangMeta();
  [...els.directionSelect.options].forEach((option) => {
    option.textContent = option.value === "ja_to_eo"
      ? `${meta.name} → ${meta.esperantoName}`
      : `${meta.esperantoName} → ${meta.name}`;
  });
}

function applyAudioConfig(config) {
  const previous = JSON.stringify(state.audioConfig);
  state.audioConfig = normalizeAudioConfig(config);
  if (previous === JSON.stringify(state.audioConfig)) {
    return;
  }
  normalizeSettings();
  if (state.currentView === "setup") {
    renderSetup();
  } else if (state.currentView === "quiz") {
    renderQuiz();
  }
}

function normalizeAudioConfig(config) {
  const candidate = isPlainObject(config) ? config : {};
  const vocabBaseUrl = String(candidate.vocabBaseUrl || DEFAULT_AUDIO_CONFIG.vocabBaseUrl || "").trim();
  const sentenceBaseUrl = String(candidate.sentenceBaseUrl || DEFAULT_AUDIO_CONFIG.sentenceBaseUrl || "").trim();
  const driveDownloadBaseUrl = String(
    candidate.driveDownloadBaseUrl
    || state.data.audioManifest.downloadBaseUrl
    || DRIVE_AUDIO_DOWNLOAD_BASE,
  ).trim();
  const hasManifestAudio = hasAudioManifestForMode("vocab") || hasAudioManifestForMode("sentence");
  const useManifestAudio = (!IS_STREAMLIT_COMPONENT || candidate.useDriveManifest !== false)
    && Boolean(candidate.useDriveManifest || hasManifestAudio);
  if (!IS_STREAMLIT_COMPONENT) {
    return {
      ...DEFAULT_AUDIO_CONFIG,
      driveDownloadBaseUrl,
      useDriveManifest: useManifestAudio,
      enabled: Boolean(DEFAULT_AUDIO_CONFIG.enabled && (
        DEFAULT_AUDIO_CONFIG.vocabBaseUrl
        || DEFAULT_AUDIO_CONFIG.sentenceBaseUrl
        || useManifestAudio
      )),
    };
  }
  return {
    enabled: Boolean(candidate.enabled !== false && (vocabBaseUrl || sentenceBaseUrl || useManifestAudio)),
    vocabBaseUrl: ensureTrailingSlash(vocabBaseUrl),
    sentenceBaseUrl: ensureTrailingSlash(sentenceBaseUrl),
    driveDownloadBaseUrl,
    useDriveManifest: useManifestAudio,
  };
}

function createEmptyAudioManifest() {
  return {
    provider: "",
    downloadBaseUrl: DRIVE_AUDIO_DOWNLOAD_BASE,
    vocab: {},
    sentence: {},
  };
}

function createEmptyRankingsState() {
  return {
    status: "idle",
    user: "",
    targetLang: "",
    activeTab: "overall",
    requestId: "",
    message: "",
    updatedAt: "",
    loadedAt: 0,
    rankings: {
      overall: [],
      today: [],
      month: [],
      hof: [],
    },
    own: {},
  };
}

function sanitizeAudioManifest(payload) {
  const manifest = isPlainObject(payload) ? payload : {};
  return {
    provider: String(manifest.provider || ""),
    downloadBaseUrl: String(manifest.downloadBaseUrl || DRIVE_AUDIO_DOWNLOAD_BASE).trim() || DRIVE_AUDIO_DOWNLOAD_BASE,
    vocab: sanitizeAudioIdMap(manifest.vocab),
    sentence: sanitizeAudioIdMap(manifest.sentence),
  };
}

function sanitizeAudioIdMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, fileId]) => [String(key || "").trim(), String(fileId || "").trim()])
      .filter(([key, fileId]) => key && /^[-_A-Za-z0-9]+$/.test(fileId)),
  );
}

function handleScoreSyncResult(result) {
  if (!isPlainObject(result) || result.type !== "score_save_result") return;
  bridgeQueue.accept(result);
  const entry = state.outbox.find((item) => item.payload.saveId === result.saveId
    && item.payload.requestId === result.requestId);
  if (!entry) return;
  state.latestScoreSyncResult = result;
  entry.status = result.ok ? "saved" : "error";
  entry.message = String(result.message || t(result.ok ? "scoreSavedMessage" : "scoreSaveFailedMessage"));
  entry.payload.retryMode = result.ok ? "" : String(result.recoverable || "");
  if (result.ok) {
    updateScoreRecord(entry);
    try {
      scoreOutboxStorage().acknowledge(entry.payload.saveId);
    } catch (error) {
      // Durable saved session/history can repair this receipt on the next refresh.
      console.warn("Could not store the score acknowledgement", error);
    }
    state.outbox = state.outbox.filter((item) => item !== entry);
  } else {
    persistOutboxEntry(entry);
    updateScoreRecord(entry);
  }
  if (result.ok && entry.payload.user === currentUserName()) {
    state.rankings.loadedAt = 0;
    state.progress.loadedAt = 0;
    if (state.currentView === "history") {
      requestProgress({ force: true });
      requestRankings({ force: true });
    }
  }
  refreshScoreViews();
  pumpScoreOutbox();
}

function handleRankingResult(result) {
  if (!isPlainObject(result) || result.type !== "rankings_result") return;
  bridgeQueue.accept(result);
  if (!matchesAccountResult(result, state.rankings, currentUserName(), state.mobileConfig.targetLang)) return;
  state.rankings.requestId = "";
  state.rankings.status = result.ok ? "ready" : "error";
  state.rankings.message = String(result.message || t(result.ok ? "rankingUpdatedMessage" : "rankingFailedMessage"));
  state.rankings.updatedAt = String(result.updatedAt || "");
  state.rankings.loadedAt = result.ok ? Date.now() : 0;
  state.rankings.rankings = sanitizeRankingsPayload(result.rankings);
  state.rankings.own = isPlainObject(result.own) ? result.own : {};
  if (state.currentView === "history") renderCloudRankings();
}

function installFrameHeightSync() {
  if (!IS_STREAMLIT_COMPONENT) {
    return;
  }
  const observer = new ResizeObserver(() => requestFrameHeightSync());
  observer.observe(document.documentElement);
  observer.observe(document.body);
  if (els.app) {
    observer.observe(els.app);
  }
  window.addEventListener("resize", requestFrameHeightSync);
  window.visualViewport?.addEventListener("resize", requestFrameHeightSync);
  requestFrameHeightSync();
}

function requestFrameHeightSync() {
  if (!IS_STREAMLIT_COMPONENT) {
    return;
  }
  window.clearTimeout(state.frameHeightTimer);
  state.frameHeightTimer = window.setTimeout(syncFrameHeight, 40);
}

function syncFrameHeight() {
  if (!IS_STREAMLIT_COMPONENT) {
    return;
  }
  const viewportHeight = Math.ceil(window.visualViewport?.height || window.innerHeight || 720);
  const screenHeight = Math.ceil(window.screen?.height || viewportHeight);
  const interactiveHeight = Math.max(640, Math.min(viewportHeight, screenHeight, 900));
  const minHeight = Math.max(640, Math.min(viewportHeight, screenHeight));
  const contentHeight = Math.ceil(Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    els.app?.scrollHeight || 0,
  ));
  const fixedNavView = ["quiz", "result", "history", "diagnostics", "error"].includes(state.currentView);
  const desiredHeight = fixedNavView
    ? interactiveHeight
    // The document includes the iframe viewport through min-height: 100dvh.
    // Adding padding here feeds it back into the next measurement forever.
    : Math.max(minHeight, contentHeight);
  if (Math.abs(desiredHeight - state.lastFrameHeight) >= 4) {
    state.lastFrameHeight = desiredHeight;
    streamlitHost.setFrameHeight(desiredHeight);
  }
}

function scrollHostToTop() {
  if (els.app) {
    els.app.scrollTop = 0;
  }
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  if (!IS_STREAMLIT_COMPONENT) {
    return;
  }
  try {
    window.parent?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const parentDoc = window.parent?.document;
    parentDoc?.querySelectorAll?.(
      "section[data-testid='stMain'], [data-testid='stMain'], [data-testid='stAppViewContainer']",
    ).forEach((node) => {
      node.scrollTop = 0;
    });
    if (parentDoc?.scrollingElement) {
      parentDoc.scrollingElement.scrollTop = 0;
    }
  } catch (error) {
    window.parent?.scrollTo?.(0, 0);
  }
  try {
    window.top?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  } catch (error) {
    window.top?.scrollTo?.(0, 0);
  }
}

async function registerServiceWorker() {
  if (
    !("serviceWorker" in navigator)
    || window.location.protocol === "file:"
    || window.location.pathname.includes("/component/")
  ) {
    return;
  }
  try {
    await navigator.serviceWorker.register("../mobile-sw.js", { scope: "../" });
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function fetchOptionalJson(url, fallback) {
  try {
    return await fetchJson(url);
  } catch (error) {
    console.warn(`Optional data not available: ${url}`, error);
    return fallback;
  }
}

function loadLocalState() {
  state.settings = sanitizeSettings(readJson(SETTINGS_KEY, {}));
  state.session = sanitizeSession(readJson(SESSION_KEY, null));
  state.history = sanitizeHistory(readJson(HISTORY_KEY, []));
  loadPendingScoresFromStorage();
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn(`Failed to read ${key}`, error);
    return fallback;
  }
}

function sanitizeSettings(value) {
  const candidate = isPlainObject(value) ? value : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...candidate,
  };
  settings.userName = String(settings.userName || "").trim();
  settings.seed = clampInteger(settings.seed, 1, 8192, DEFAULT_SETTINGS.seed);
  if (!["vocab", "sentence"].includes(settings.mode)) {
    settings.mode = DEFAULT_SETTINGS.mode;
  }
  if (!["eo_to_ja", "ja_to_eo"].includes(settings.direction)) {
    settings.direction = DEFAULT_SETTINGS.direction;
  }
  if (!["prompt", "all", "off"].includes(settings.audioMode)) {
    settings.audioMode = DEFAULT_SETTINGS.audioMode;
  }
  delete settings.length;
  settings.pos = String(settings.pos || DEFAULT_SETTINGS.pos);
  settings.groupId = String(settings.groupId || "");
  settings.topic = String(settings.topic || "");
  settings.subtopic = String(settings.subtopic || "");
  settings.levels = Array.isArray(settings.levels)
    ? unique(settings.levels.map((level) => Number(level)).filter(Number.isFinite))
    : [];
  settings.spartanMode = Boolean(settings.spartanMode);
  return settings;
}

function sanitizeSession(value) {
  if (!isPlainObject(value) || !["active", "complete"].includes(value.status)) {
    return null;
  }
  if (!Array.isArray(value.questions) || !value.questions.length || !value.questions.every((question) => isValidQuestion(question, hasClassicMigrationProvenance(value) && value.settings?.mode === "vocab"))) {
    return null;
  }
  const questionCount = value.questions.length;
  const answers = Array.isArray(value.answers)
    ? value.answers.filter((answer) => isValidAnswer(answer, questionCount))
    : [];
  const spartanPending = unique(
    (Array.isArray(value.spartanPending) ? value.spartanPending : [])
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < questionCount),
  );
  const scoreSyncStatus = ["pending", "saved", "error"].includes(value.scoreSyncStatus)
    ? value.scoreSyncStatus
    : "idle";
  const session = {
    ...value,
    source: String(value.source || ""),
    targetLang: normalizeTargetLang(value.targetLang || state.mobileConfig.targetLang),
    settings: sanitizeSettings(value.settings),
    qIndex: clampInteger(value.qIndex, 0, questionCount, 0),
    correct: clampInteger(value.correct, 0, questionCount, 0),
    streak: clampInteger(value.streak, 0, questionCount, 0),
    answers,
    showingFeedback: Boolean(value.showingFeedback && isPlainObject(value.feedback)),
    feedback: isPlainObject(value.feedback) ? value.feedback : null,
    mainPoints: finiteNumber(value.mainPoints, 0),
    spartanRawPoints: finiteNumber(value.spartanRawPoints, 0),
    spartanScaledPoints: finiteNumber(value.spartanScaledPoints, 0),
    spartanPending,
    inSpartan: Boolean(value.inSpartan && spartanPending.length),
    spartanAttempts: clampInteger(value.spartanAttempts, 0, 99999, 0),
    spartanCorrect: clampInteger(value.spartanCorrect, 0, 99999, 0),
    savedToHistory: Boolean(value.savedToHistory),
    scoreSaveId: String(value.scoreSaveId || ""),
    scoreSyncRequestId: String(value.scoreSyncRequestId || ""),
    scoreSyncStatus,
    scoreSyncRecoverable: String(value.scoreSyncRecoverable || ""),
    scoreSyncMessage: scoreSyncStatus === "pending"
      ? t("scorePendingRestored")
      : String(value.scoreSyncMessage || ""),
    startedAt: String(value.startedAt || new Date().toISOString()),
    updatedAt: String(value.updatedAt || new Date().toISOString()),
  };
  session.spartanCurrent = Number.isInteger(value.spartanCurrent) && spartanPending.includes(value.spartanCurrent)
    ? value.spartanCurrent
    : null;
  if (session.status === "complete") {
    session.completedAt = String(value.completedAt || session.updatedAt);
  }
  return session;
}

function sanitizeHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isPlainObject)
    .map((record) => ({
      id: String(record.id || createId()),
      userName: String(record.userName || "").trim(),
      mode: record.mode === "sentence" ? "sentence" : "vocab",
      direction: record.direction === "ja_to_eo" ? "ja_to_eo" : "eo_to_ja",
      correct: clampInteger(record.correct, 0, 99999, 0),
      total: clampInteger(record.total, 1, 99999, 1),
      accuracy: Math.min(1, Math.max(0, finiteNumber(record.accuracy, 0))),
      points: finiteNumber(record.points, 0),
      completedAt: String(record.completedAt || ""),
      scoreSaveId: String(record.scoreSaveId || ""),
      scoreSyncStatus: ["pending", "saved", "error", "local"].includes(record.scoreSyncStatus) ? record.scoreSyncStatus : "unknown",
    }))
    .slice(0, HISTORY_MAX_ITEMS);
}

function isValidQuestion(question, legacyVocab = false) {
  return Boolean(
    isPlainObject(question)
    && Array.isArray(question.options)
    && question.options.length >= (legacyVocab ? 2 : 4)
    && question.options.length <= 4
    && Number.isInteger(question.answerIndex)
    && question.answerIndex >= 0
    && question.answerIndex < question.options.length
    && question.options.every((option) => isPlainObject(option) && "eo" in option && "ja" in option),
  );
}

function isValidAnswer(answer, questionCount) {
  return Boolean(
    isPlainObject(answer)
    && Number.isInteger(answer.qIndex)
    && answer.qIndex >= 0
    && answer.qIndex < questionCount
    && Number.isInteger(answer.selectedIndex)
    && Number.isInteger(answer.answerIndex),
  );
}

function writeJson(key, value, { allowRecovery = true } = {}) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`Failed to write ${key}`, error);
    if (allowRecovery && recoverLocalStorageWrite(key, value, error)) {
      return true;
    }
    updateSaveStatus(t("saveFailed"));
    return false;
  }
}

function recoverLocalStorageWrite(key, value, error) {
  if (!isQuotaExceededError(error)) {
    return false;
  }
  if (key === HISTORY_KEY && Array.isArray(value)) {
    for (const limit of HISTORY_RECOVERY_LIMITS) {
      const trimmed = value.slice(0, limit);
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
        state.history = trimmed;
        updateSaveStatus(t("historySavedAfterCleanup"));
        showToast(t("historyCleanupToast"));
        return true;
      } catch (retryError) {
        console.warn(`Failed to recover ${HISTORY_KEY} with ${limit} items`, retryError);
      }
    }
    return false;
  }
  try {
    window.localStorage.removeItem(HISTORY_KEY);
    state.history = [];
    window.localStorage.setItem(key, JSON.stringify(value));
    updateSaveStatus(t("historySavedAfterCleanup"));
    showToast(t("sessionCleanupToast"));
    return true;
  } catch (retryError) {
    console.warn(`Failed to recover ${key}`, retryError);
    return false;
  }
}

function isQuotaExceededError(error) {
  return Boolean(
    error
    && (
      error.name === "QuotaExceededError"
      || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
      || error.code === 22
      || error.code === 1014
    ),
  );
}

function saveSettings() {
  writeJson(SETTINGS_KEY, state.settings);
}

function saveSession() {
  return persistPresentSession(state.session, (session) => {
    session.updatedAt = new Date().toISOString();
    // A failed confirmation write must not delete the history's only durable acknowledgement.
    const saved = writeJson(SESSION_KEY, session, { allowRecovery: session.scoreSyncStatus !== "saved" });
    if (saved) updateSaveStatus(t("autoSaved"));
    return saved;
  });
}

function ensureSessionCanBeReplaced() {
  const allowed = canReplaceSession(state.session, {
    cloudEnabled: IS_STREAMLIT_COMPONENT,
    viewOnly: isLegacyScoreSaveBlocked(state.session),
    ensureDurable: enqueueCompletedScore,
  });
  if (!allowed) {
    setView("result");
    renderResult();
    showToast(t("saveBeforeNewQuiz"));
  }
  return allowed;
}

function clearStoredSession() {
  if (!ensureSessionCanBeReplaced()) return false;
  window.clearTimeout(state.saveTimer);
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch (error) {
    console.warn(`Failed to remove ${SESSION_KEY}`, error);
    showToast(t("saveFailed"));
    return false;
  }
  state.session = null;
  updateSaveStatus(t("sessionDiscarded"));
  refreshResumeButton();
  inspectStoredLegacyQuiz();
  return true;
}

function queueSessionSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    saveSession();
    refreshResumeButton();
  }, 80);
}

function saveHistory({ allowRecovery = true } = {}) {
  state.history = state.history.slice(0, HISTORY_MAX_ITEMS);
  writeJson(HISTORY_KEY, state.history, { allowRecovery });
}

function requestRankings({ force = false } = {}) {
  if (state.progress.settingsPending || state.progress.settingsUncertain) {
    renderCloudRankings();
    return;
  }
  if (!IS_STREAMLIT_COMPONENT) {
    state.rankings.status = "unavailable";
    state.rankings.message = t("rankingUnavailable");
    renderCloudRankings();
    return;
  }
  const user = currentUserName();
  const targetLang = state.mobileConfig.targetLang;
  if (state.rankings.user !== user || state.rankings.targetLang !== targetLang) {
    state.rankings = createEmptyRankingsState();
    bridgeQueue.discardPending((payload) => payload.type === "load_rankings");
  }
  if (state.rankings.status === "loading") return;
  if (!force && isAccountCacheFresh(state.rankings, { user, targetLang, ttlMs: RANKING_CACHE_TTL_MS })) {
    renderCloudRankings();
    return;
  }
  Object.assign(state.rankings, {
    status: "loading", requestId: createId(), user: currentUserName(),
    targetLang: state.mobileConfig.targetLang, message: t("rankingLoading"),
  });
  renderCloudRankings();
  bridgeQueue.enqueue({
    type: "load_rankings", requestId: state.rankings.requestId, user: state.rankings.user,
    force: Boolean(force), appVersion: APP_VERSION, mobileSource: state.mobileConfig.source,
    targetLang: state.mobileConfig.targetLang, ts: new Date().toISOString(),
  });
}

function sanitizeRankingsPayload(payload) {
  const source = isPlainObject(payload) ? payload : {};
  return {
    overall: sanitizeRankingRows(source.overall),
    today: sanitizeRankingRows(source.today),
    month: sanitizeRankingRows(source.month),
    hof: sanitizeRankingRows(source.hof),
  };
}

function sanitizeRankingRows(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isPlainObject)
    .map((row) => ({
      rank: clampInteger(row.rank, 1, 999999, 1),
      user: String(row.user || "").trim(),
      points: finiteNumber(row.points, 0),
      isCurrentUser: Boolean(row.isCurrentUser),
    }))
    .filter((row) => row.user)
    .slice(0, 30);
}

function normalizeSettings() {
  state.settings.seed = clampInteger(state.settings.seed, 1, 8192, 1);
  if (!["vocab", "sentence"].includes(state.settings.mode)) {
    state.settings.mode = "vocab";
  }
  if (!["eo_to_ja", "ja_to_eo"].includes(state.settings.direction)) {
    state.settings.direction = "eo_to_ja";
  }
  if (!["prompt", "all", "off"].includes(state.settings.audioMode)) {
    state.settings.audioMode = "prompt";
  }
  delete state.settings.length;
  if (!hasAudioForMode(state.settings.mode)) {
    state.settings.audioMode = "off";
  }
  ensureVocabSelection();
  ensureSentenceSelection();
  saveSettings();
}

function persistSettingsFromForm() {
  changeCurrentUser(els.userName.value);
  state.settings.direction = els.directionSelect.value;
  state.settings.seed = clampInteger(els.seedInput.value, 1, 8192, 1);
  state.settings.pos = els.posSelect.value || state.settings.pos;
  state.settings.groupId = els.groupSelect.value || state.settings.groupId;
  state.settings.topic = els.topicSelect.value || state.settings.topic;
  state.settings.subtopic = els.subtopicSelect.value || state.settings.subtopic;
  state.settings.levels = getCheckedLevels();
  delete state.settings.length;
  state.settings.audioMode = els.audioMode.value;
  if (!hasAudioForMode(state.settings.mode)) {
    state.settings.audioMode = "off";
  }
  state.settings.spartanMode = els.spartanMode.checked;
  saveSettings();
}

function switchMode(mode) {
  if (state.settings.mode === mode) {
    return;
  }
  state.settings.mode = mode;
  normalizeSettings();
  renderSetup();
  inspectStoredLegacyQuiz();
  requestFrameHeightSync();
}

function renderSetup() {
  const mode = state.settings.mode;
  updateDirectionLabels();
  renderAppLinks();
  els.modeVocab.classList.toggle("is-selected", mode === "vocab");
  els.modeSentence.classList.toggle("is-selected", mode === "sentence");
  els.modeVocab.setAttribute("aria-selected", String(mode === "vocab"));
  els.modeSentence.setAttribute("aria-selected", String(mode === "sentence"));
  els.vocabSettings.hidden = mode !== "vocab";
  els.sentenceSettings.hidden = mode !== "sentence";

  els.userName.value = state.settings.userName || "";
  els.directionSelect.value = state.settings.direction;
  els.seedInput.value = state.settings.seed;
  els.audioMode.value = state.settings.audioMode;
  els.audioMode.disabled = !hasAudioForMode(mode);
  els.spartanMode.checked = Boolean(state.settings.spartanMode);

  renderVocabControls();
  renderSentenceControls();
  refreshResumeButton();
  requestFrameHeightSync();
}

function renderVocabControls() {
  const meta = currentLangMeta();
  const posValues = unique(state.vocabGroups.map((group) => group.pos))
    .sort((a, b) => posSortIndex(a) - posSortIndex(b) || labelForPos(a).localeCompare(labelForPos(b), meta.intlLocale));
  replaceOptions(
    els.posSelect,
    posValues.map((pos) => ({ value: pos, label: labelForPos(pos) })),
  );
  els.posSelect.value = state.settings.pos;

  const groups = state.vocabGroups.filter((group) => group.pos === state.settings.pos);
  replaceOptions(
    els.groupSelect,
    groups.map((group) => ({
      value: group.id,
      label: `${formatStageLabel(group.stages)} ${group.indexLabel} (${group.entries.length}${meta.wordUnit})`,
    })),
  );
  els.groupSelect.value = state.settings.groupId;
}

function renderSentenceControls() {
  const topics = unique(state.data.sentences.map((entry) => entry.topic)).sort((a, b) => a.localeCompare(b));
  replaceOptions(els.topicSelect, topics.map((topic) => ({ value: topic, label: topic })));
  els.topicSelect.value = state.settings.topic;

  const subtopics = unique(
    state.data.sentences
      .filter((entry) => entry.topic === state.settings.topic)
      .map((entry) => entry.subtopic),
  ).sort((a, b) => a.localeCompare(b));
  replaceOptions(els.subtopicSelect, subtopics.map((subtopic) => ({ value: subtopic, label: subtopic })));
  els.subtopicSelect.value = state.settings.subtopic;

  const availableLevels = getAvailableSentenceLevels();
  els.levelChips.replaceChildren(
    ...availableLevels.map((level) => {
      const label = document.createElement("label");
      label.className = "chip";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(level);
      input.checked = state.settings.levels.includes(level);
      input.addEventListener("change", persistSettingsFromForm);
      const span = document.createElement("span");
      span.textContent = `Lv ${level}`;
      label.append(input, span);
      return label;
    }),
  );
}

function replaceOptions(select, options) {
  select.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      return node;
    }),
  );
}

function ensureVocabSelection(resetGroup = false) {
  const posValues = unique(state.vocabGroups.map((group) => group.pos));
  if (!posValues.includes(state.settings.pos)) {
    state.settings.pos = posValues.includes("noun") ? "noun" : posValues[0] || "";
    resetGroup = true;
  }
  const groups = state.vocabGroups.filter((group) => group.pos === state.settings.pos);
  if (resetGroup || !groups.some((group) => group.id === state.settings.groupId)) {
    state.settings.groupId = groups[0]?.id || "";
  }
}

function ensureSentenceSelection(resetSubtopic = false) {
  const topics = unique(state.data.sentences.map((entry) => entry.topic)).sort((a, b) => a.localeCompare(b));
  if (!topics.includes(state.settings.topic)) {
    state.settings.topic = topics[0] || "";
    resetSubtopic = true;
  }
  const subtopics = unique(
    state.data.sentences
      .filter((entry) => entry.topic === state.settings.topic)
      .map((entry) => entry.subtopic),
  ).sort((a, b) => a.localeCompare(b));
  if (resetSubtopic || !subtopics.includes(state.settings.subtopic)) {
    state.settings.subtopic = subtopics[0] || "";
  }
  ensureSentenceLevels(resetSubtopic);
}

function ensureSentenceLevels(resetLevels = false) {
  const availableLevels = getAvailableSentenceLevels();
  const valid = state.settings.levels.filter((level) => availableLevels.includes(level));
  state.settings.levels = resetLevels || valid.length === 0 ? availableLevels : valid;
}

function getAvailableSentenceLevels() {
  return unique(
    state.data.sentences
      .filter((entry) => entry.topic === state.settings.topic && entry.subtopic === state.settings.subtopic)
      .map((entry) => Number(entry.level))
      .filter(Number.isFinite),
  ).sort((a, b) => a - b);
}

function getCheckedLevels() {
  return [...els.levelChips.querySelectorAll("input:checked")]
    .map((input) => Number(input.value))
    .filter(Number.isFinite);
}

function startQuiz({ replaceActive = false } = {}) {
  if (!ensureSessionCanBeReplaced()) return false;
  let shouldDiscardActive = false;
  if (isActiveSession(state.session) && !replaceActive) {
    const replace = window.confirm(t("replaceActiveConfirm"));
    if (!replace) {
      showToast(t("activeKept"));
      resumeStoredSession();
      return false;
    }
    shouldDiscardActive = true;
  } else if (isActiveSession(state.session) && replaceActive) {
    shouldDiscardActive = true;
  }
  if (shouldDiscardActive && !clearStoredSession()) return false;
  persistSettingsFromForm();
  const settings = { ...state.settings, levels: [...state.settings.levels] };
  const seed = settings.seed + Date.now();
  const rng = mulberry32(seed);
  const questions = settings.mode === "vocab"
    ? buildVocabQuestions(settings, rng)
    : buildSentenceQuestions(settings, rng);
  if (questions.length < 1) {
    showToast(t("noQuestions"));
    return;
  }
  state.session = {
    id: createId(),
    appVersion: APP_VERSION,
    source: state.mobileConfig.source,
    targetLang: state.mobileConfig.targetLang,
    status: "active",
    settings,
    questions,
    qIndex: 0,
    correct: 0,
    streak: 0,
    answers: [],
    showingFeedback: false,
    feedback: null,
    mainPoints: 0,
    spartanRawPoints: 0,
    spartanScaledPoints: 0,
    spartanPending: [],
    inSpartan: false,
    spartanCurrent: null,
    spartanAttempts: 0,
    spartanCorrect: 0,
    savedToHistory: false,
    scoreSaveId: "",
    scoreSyncRequestId: "",
    scoreSyncStatus: "idle",
    scoreSyncRecoverable: "",
    scoreSyncMessage: "",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveSession();
  refreshResumeButton();
  setView("quiz");
  renderQuiz();
  return true;
}

function retrySession() {
  if (!state.session) {
    setView("setup");
    return;
  }
  const previousUser = currentUserName();
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...state.session.settings,
    levels: [...(state.session.settings.levels || [])],
  };
  if (previousUser !== currentUserName()) invalidateAccountData();
  renderSetup();
  startQuiz();
}

function buildVocabQuestions(settings, rng) {
  const group = state.vocabGroups.find((candidate) => candidate.id === settings.groupId);
  if (!group || group.entries.length < 4) {
    return [];
  }
  const selectedEntries = shuffle([...group.entries], rng);
  return selectedEntries.map((entry) => buildQuestionFromEntry({
    mode: "vocab",
    correct: entry,
    pool: group.entries,
    stages: group.stages,
    rng,
    direction: settings.direction,
  })).filter(Boolean);
}

function buildSentenceQuestions(settings, rng) {
  const pool = state.data.sentences.filter((entry) => (
    entry.topic === settings.topic
    && entry.subtopic === settings.subtopic
    && settings.levels.includes(Number(entry.level))
  ));
  if (pool.length < 4) {
    return [];
  }
  const selectedEntries = shuffle([...pool], rng);
  return selectedEntries.map((entry) => buildQuestionFromEntry({
    mode: "sentence",
    correct: entry,
    pool,
    stages: [],
    rng,
    direction: settings.direction,
  })).filter(Boolean);
}

function buildQuestionFromEntry(options) {
  return buildLocalizedQuestion({ ...options, targetLang: state.mobileConfig.targetLang });
}

function renderQuiz() {
  if (!state.session || !state.session.questions.length) {
    setView("setup");
    return;
  }
  normalizeSessionPhase();
  if (state.session.status === "complete") {
    renderResult();
    setView("result");
    return;
  }

  const session = state.session;
  const question = getCurrentQuestion();
  if (!question) {
    finishSession();
    return;
  }

  const currentNumber = Math.min(session.qIndex + 1, session.questions.length);
  const phaseText = session.inSpartan
    ? `${t("reviewPhase")} ${session.spartanPending.length}`
    : `Q${currentNumber}/${session.questions.length}`;
  const prompt = displayPrompt(question, session.settings.direction);
  els.phaseLabel.textContent = phaseText;
  els.promptText.textContent = prompt;

  els.promptAudioButton.hidden = !canPlayPromptAudio(session, question);

  const answeredMain = Math.min(session.qIndex, session.questions.length);
  const progress = session.inSpartan
    ? 1
    : answeredMain / Math.max(session.questions.length, 1);
  els.progressBar.style.width = `${Math.round(progress * 100)}%`;
  els.correctStat.textContent = `${t("correct")} ${session.correct}/${session.questions.length}`;
  els.streakStat.textContent = `${t("streak")} ${session.streak}`;
  els.remainingStat.textContent = `${t("remaining")} ${remainingCount(session)}`;

  renderFeedback();
  renderChoices(question);
  maybeAutoPlayPromptAudio(session, question);
  queueSessionSave();
}

function renderFeedback() {
  const session = state.session;
  if (!session?.showingFeedback || !session.feedback) {
    els.feedbackPanel.hidden = true;
    els.feedbackPanel.classList.remove("is-correct");
    return;
  }
  els.feedbackPanel.hidden = false;
  els.feedbackPanel.classList.toggle("is-correct", Boolean(session.feedback.correct));
  els.feedbackText.textContent = session.feedback.message;
}

function renderChoices(question) {
  const session = state.session;
  const labels = question.options.map((option) => displayOption(option, session.settings.direction));
  const longLabels = question.mode === "sentence" || labels.some((label) => label.length > 24);
  els.choiceGrid.classList.toggle("is-long", longLabels);
  els.choiceGrid.classList.toggle("is-vocab", question.mode === "vocab");
  els.choiceGrid.replaceChildren(
    ...question.options.map((option, index) => {
      const card = document.createElement("div");
      card.className = "choice-card";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice-button";
      button.disabled = Boolean(session.showingFeedback);
      button.dataset.index = String(index);
      const label = document.createElement("span");
      label.className = "choice-label";
      label.textContent = labels[index];
      button.append(label);

      if (session.showingFeedback) {
        button.classList.toggle("is-correct", index === question.answerIndex);
        button.classList.toggle("is-wrong", index === session.feedback?.selectedIndex);
      } else {
        button.addEventListener("click", () => answerCurrentQuestion(index));
      }
      card.append(button);

      if (canPlayChoiceAudio(session, question, option)) {
        const audioButton = document.createElement("button");
        audioButton.type = "button";
        audioButton.className = "choice-audio-button";
        audioButton.textContent = "♪";
        audioButton.setAttribute("aria-label", t("choiceAudioAria"));
        audioButton.addEventListener("click", () => playAudio(question.mode, option));
        card.append(audioButton);
      }
      return card;
    }),
  );
}

function answerCurrentQuestion(selectedIndex) {
  const session = state.session;
  const question = getCurrentQuestion();
  if (!session || !question || session.showingFeedback) {
    return;
  }
  const isCorrect = selectedIndex === question.answerIndex;
  const phase = session.inSpartan ? "spartan" : "main";
  const currentIndex = getCurrentQuestionIndex();
  if (session.inSpartan) {
    session.spartanAttempts += 1;
  }
  session.answers.push({
    qIndex: currentIndex,
    selectedIndex,
    answerIndex: question.answerIndex,
    phase,
    at: new Date().toISOString(),
  });

  if (isCorrect) {
    applyCorrectAnswer(question);
    normalizeSessionPhase();
    saveSession();
    allowAutoPromptAudioFromUserAction();
    renderQuiz();
    return;
  }

  session.streak = 0;
  if (session.settings.spartanMode && !session.inSpartan && !session.spartanPending.includes(currentIndex)) {
    session.spartanPending.push(currentIndex);
  }
  const correctText = displayOption(question.options[question.answerIndex], session.settings.direction);
  session.showingFeedback = true;
  session.feedback = {
    correct: false,
    selectedIndex,
    message: `${t("incorrectPrefix")}: ${correctText}`,
  };
  saveSession();
  renderQuiz();
}

function applyCorrectAnswer(question) {
  const session = state.session;
  session.streak += 1;
  const earned = scoreForCorrect(question, session.streak);
  if (session.inSpartan) {
    session.spartanRawPoints += earned;
    session.spartanScaledPoints += scaleSpartanPoints(earned);
    session.spartanCorrect += 1;
    session.spartanPending = session.spartanPending.filter((index) => index !== session.spartanCurrent);
    session.spartanCurrent = null;
    if (!session.spartanPending.length) {
      session.inSpartan = false;
    }
  } else {
    session.mainPoints += earned;
    session.correct += 1;
    session.qIndex += 1;
  }
  session.showingFeedback = false;
  session.feedback = null;
}

function advanceAfterFeedback() {
  const session = state.session;
  if (!session?.showingFeedback) {
    return;
  }
  if (session.inSpartan) {
    session.spartanCurrent = null;
  } else {
    session.qIndex += 1;
  }
  session.showingFeedback = false;
  session.feedback = null;
  normalizeSessionPhase();
  saveSession();
  allowAutoPromptAudioFromUserAction();
  renderQuiz();
}

function normalizeSessionPhase() {
  const session = state.session;
  if (!session || session.status !== "active") {
    return;
  }
  if (session.inSpartan && !session.spartanPending.length) {
    session.inSpartan = false;
    session.spartanCurrent = null;
  }
  if (session.qIndex >= session.questions.length) {
    if (session.settings.spartanMode && session.spartanPending.length) {
      session.inSpartan = true;
      if (session.spartanCurrent === null || session.spartanCurrent === undefined || !session.spartanPending.includes(session.spartanCurrent)) {
        session.spartanCurrent = randomItem(session.spartanPending);
      }
      return;
    }
    finishSession();
  } else if (!session.inSpartan) {
    session.spartanCurrent = null;
  }
}

function finishSession() {
  const session = state.session;
  if (!session) {
    return;
  }
  session.status = "complete";
  session.completedAt = session.completedAt || new Date().toISOString();
  const summary = computeResultSummary(session);
  session.finalPoints = summary.points;
  if (!session.savedToHistory) {
    state.history.unshift({
      id: session.id,
      userName: session.settings.userName,
      mode: session.settings.mode,
      direction: session.settings.direction,
      correct: summary.correct,
      total: summary.total,
      accuracy: summary.accuracy,
      points: summary.points,
      completedAt: session.completedAt,
      scoreSaveId: session.scoreSaveId || `mobile-${session.id}`,
      scoreSyncStatus: isLegacyScoreSaveBlocked(session) ? "unknown"
        : session.scoreSyncStatus === "saved" ? "saved"
          : IS_STREAMLIT_COMPONENT && session.settings.userName ? "pending" : "local",
    });
    state.history = state.history.slice(0, HISTORY_MAX_ITEMS);
    session.savedToHistory = true;
    saveHistory();
  }
  saveSession();
  refreshResumeButton();
  enqueueCompletedScore(session);
}

function renderResult() {
  const session = state.session;
  if (!isCompleteSession(session)) {
    setView("setup");
    return;
  }
  const summary = computeResultSummary(session);
  els.resultTitle.textContent = summary.accuracy >= 1
    ? { ja: "全問正解", zh: "全部答对", ko: "전부 정답" }[state.mobileConfig.targetLang]
    : { ja: "クイズ完了", zh: "测验完成", ko: "퀴즈 완료" }[state.mobileConfig.targetLang];
  els.accuracyMetric.textContent = `${Math.round(summary.accuracy * 100)}%`;
  els.pointsMetric.textContent = summary.points.toFixed(1);
  els.countMetric.textContent = `${summary.correct}/${summary.total}`;
  renderScoreSyncControls(summary);
  renderReview();
}

function renderScoreSyncControls(summary) {
  const session = state.session;
  const userName = String(session.settings.userName || "").trim();
  els.syncScoreStatus.classList.remove("is-success", "is-error");
  if (isLegacyScoreSaveBlocked(session)) {
    els.syncScoreButton.disabled = true;
    els.syncScoreButton.textContent = t("legacyViewOnly");
    els.syncScoreStatus.textContent = t("legacyUnknownSaveHint");
    return;
  }

  if (!IS_STREAMLIT_COMPONENT) {
    els.syncScoreButton.disabled = true;
    els.syncScoreButton.textContent = t("saveRanking");
    els.syncScoreStatus.textContent = t("scoreUnavailable");
    return;
  }
  if (!userName) {
    els.syncScoreButton.disabled = true;
    els.syncScoreButton.textContent = t("saveRanking");
    els.syncScoreStatus.textContent = t("scoreNeedsUser");
    return;
  }
  if (session.scoreSyncStatus === "pending") {
    els.syncScoreButton.disabled = true;
    els.syncScoreButton.textContent = t("scoreSaving");
    els.syncScoreStatus.textContent = session.scoreSyncMessage || t("scoreSavingMessage");
    return;
  }
  if (session.scoreSyncStatus === "saved") {
    els.syncScoreButton.disabled = true;
    els.syncScoreButton.textContent = t("scoreSavedButton");
    els.syncScoreStatus.classList.add("is-success");
    els.syncScoreStatus.textContent = session.scoreSyncMessage || formatText("scoreSavedAdd", { points: summary.points.toFixed(1) });
    return;
  }
  els.syncScoreButton.disabled = false;
  els.syncScoreButton.textContent = t("saveRanking");
  if (session.scoreSyncStatus === "error") {
    els.syncScoreStatus.classList.add("is-error");
    if (session.scoreSyncRecoverable === "totals_update") {
      els.syncScoreButton.textContent = t("scoreRetryTotals");
    }
    els.syncScoreStatus.textContent = session.scoreSyncMessage || t("scoreRetryMessage");
  } else {
    els.syncScoreStatus.textContent = formatText("scoreWillAdd", { points: summary.points.toFixed(1) });
  }
}

function syncScoreToSheets() {
  const session = state.session;
  if (!isCompleteSession(session) || session.scoreSyncStatus === "saved" || isLegacyScoreSaveBlocked(session)) return;
  enqueueCompletedScore(session);
  const entry = state.outbox.find((item) => item.payload.sessionId === session.id);
  if (entry && !bridgeQueue.has(entry.payload.requestId)) {
    entry.status = "pending";
    entry.attempts = 0;
    entry.nextAttemptAt = 0;
    if (persistOutboxEntry(entry)) pumpScoreOutbox();
  }
}

function scoreOutboxStorage() {
  return new DurableScoreOutbox({
    storage: window.localStorage, prefix: OUTBOX_ENTRY_PREFIX, legacyKey: OUTBOX_KEY,
  });
}

function readConfirmedScoreEvidence() {
  const read = (key) => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (error) {
      console.warn("Could not read a saved score confirmation", error);
      return null;
    }
  };
  return { session: read(SESSION_KEY), history: read(HISTORY_KEY) };
}

function recoverConfirmedScore(entry, storage, evidence) {
  if (!hasConfirmedScoreEvidence(entry.payload, evidence)) return false;
  const stored = storage.read(entry.payload.saveId);
  if (stored?.payload && !matchesScoreRecord(entry.payload, {
    id: stored.payload.sessionId, userName: stored.payload.user, scoreSaveId: stored.payload.saveId,
    points: stored.payload.points, total: stored.payload.total,
  })) return false;
  try {
    storage.acknowledge(entry.payload.saveId);
  } catch (error) {
    // Keep the saved records and original queue intact if receipt repair is still unavailable.
    console.warn("Could not repair the saved score receipt", error);
  }
  entry.status = "saved";
  entry.message = t("scoreSavedMessage");
  entry.payload.retryMode = "";
  updateScoreRecord(entry);
  state.outbox = state.outbox.filter((item) => item.payload.saveId !== entry.payload.saveId);
  bridgeQueue.discardPending((payload) => payload.type === "save_score" && payload.saveId === entry.payload.saveId);
  return true;
}

function loadPendingScoresFromStorage() {
  const previous = state.outbox;
  let readFailed = false;
  try {
    const storage = scoreOutboxStorage();
    try {
      storage.migrateLegacy();
    } catch (error) {
      readFailed = true;
      console.warn("Could not migrate the previous pending score queue; original retained", error);
    }
    const { entries, errors } = storage.list();
    readFailed ||= errors.length > 0;
    errors.forEach(({ key, error }) => console.warn(`Could not read pending score ${key}`, error));
    const evidence = readConfirmedScoreEvidence();
    const byId = new Map();
    const confirmedIds = new Set();
    for (const entry of entries) {
      if (recoverConfirmedScore(entry, storage, evidence)) confirmedIds.add(entry.payload.saveId);
      else byId.set(entry.payload.saveId, entry);
    }
    for (const entry of previous) {
      try {
        if (confirmedIds.has(entry.payload.saveId) || recoverConfirmedScore(entry, storage, evidence)) {
          byId.delete(entry.payload.saveId);
          continue;
        }
        const stored = storage.read(entry.payload.saveId);
        if (stored?.type === "saved_score_receipt") {
          entry.status = "saved";
          entry.message = t("scoreSavedMessage");
          updateScoreRecord(entry);
          byId.delete(entry.payload.saveId);
          bridgeQueue.discardPending((payload) => payload.type === "save_score" && payload.saveId === entry.payload.saveId);
        } else if (!stored || bridgeQueue.has(entry.payload.requestId)) {
          byId.set(entry.payload.saveId, entry);
        }
      } catch (error) {
        readFailed = true;
        byId.set(entry.payload.saveId, entry);
        console.warn("Could not refresh a pending learning record", error);
      }
    }
    state.outbox = [...byId.values()];
  } catch (error) {
    readFailed = true;
    console.warn("Could not read pending learning records", error);
  }
  state.outboxReadFailed = readFailed;
  if (readFailed) showToast(t("outboxReadFailed"));
}

function persistOutboxEntry(entry) {
  try {
    const storage = scoreOutboxStorage();
    if (recoverConfirmedScore(entry, storage, readConfirmedScoreEvidence())) return true;
    const stored = storage.put(entry);
    if (stored.saved) {
      entry.status = "saved";
      entry.message = t("scoreSavedMessage");
      updateScoreRecord(entry);
      state.outbox = state.outbox.filter((item) => item.payload.saveId !== entry.payload.saveId);
      bridgeQueue.discardPending((payload) => payload.type === "save_score" && payload.saveId === entry.payload.saveId);
    }
    return true;
  } catch (error) {
    console.warn("Could not durably store a pending learning record", error);
    showToast(t("outboxWriteFailed"));
    return false;
  }
}

function enqueueCompletedScore(session) {
  if (!IS_STREAMLIT_COMPONENT || !isCompleteSession(session) || isLegacyScoreSaveBlocked(session)
      || !String(session.settings.userName || "").trim() || session.scoreSyncStatus === "saved") return true;
  if (!session.scoreSaveId) session.scoreSaveId = `mobile-${session.id}`;
  const payload = buildScoreSyncPayload(session, computeResultSummary(session), session.scoreSyncRecoverable || "");
  state.outbox = addToOutbox(state.outbox, payload);
  const entry = state.outbox.find((item) => item.payload.saveId === payload.saveId);
  if (!persistOutboxEntry(entry)) {
    entry.status = "error";
    entry.message = t("outboxWriteFailed");
    updateScoreRecord(entry);
    return false;
  }
  updateScoreRecord(entry);
  pumpScoreOutbox();
  return true;
}

function restorePendingScores() {
  // Reconcile durable confirmations before adopting the active result or retrying any score.
  loadPendingScoresFromStorage();
  if (isCompleteSession(state.session)) {
    const payload = buildScoreSyncPayload(state.session, computeResultSummary(state.session));
    if (hasConfirmedScoreEvidence(payload, readConfirmedScoreEvidence())) {
      updateScoreRecord({ payload, status: "saved", message: t("scoreSavedMessage") });
    }
  }
  enqueueCompletedScore(state.session);
  retryPendingScores();
}

function updateScoreRecord(entry) {
  const { payload, status, message } = entry;
  const sessionRecord = scoreRecordFromSession(state.session);
  if (!sessionRecord.scoreSaveId && sessionRecord.id) sessionRecord.scoreSaveId = `mobile-${sessionRecord.id}`;
  if (state.session?.status === "complete" && matchesScoreRecord(payload, sessionRecord)) {
    Object.assign(state.session, {
      scoreSaveId: payload.saveId, scoreSyncRequestId: payload.requestId,
      scoreSyncStatus: status, scoreSyncMessage: message,
      scoreSyncRecoverable: payload.retryMode || "",
    });
    saveSession();
  }
  const record = state.history.find((item) => matchesScoreRecord(payload, {
    ...item, scoreSaveId: item.scoreSaveId || `mobile-${item.id}`,
  }));
  if (record) {
    record.scoreSaveId = payload.saveId;
    record.scoreSyncStatus = status;
    saveHistory({ allowRecovery: status !== "saved" });
  }
}

function refreshScoreViews() {
  if (state.currentView === "result") renderResult();
  if (state.currentView === "history") renderHistory();
}

function pumpScoreOutbox() {
  window.clearTimeout(state.outboxRetryTimeout);
  if (!IS_STREAMLIT_COMPONENT) return;
  // A sent score remains pending in durable storage until its matching acknowledgement arrives.
  const due = state.outbox.filter((entry) => entry.status === "pending"
    && !bridgeQueue.has(entry.payload.requestId));
  due.forEach((entry) => {
    if (entry.nextAttemptAt > Date.now()) return;
    entry.payload.requestId = createId();
    entry.payload.ts = new Date().toISOString();
    entry.attempts += 1;
    entry.message = t("scoreSavingMessage");
    if (!persistOutboxEntry(entry)) {
      entry.status = "error";
      entry.message = t("outboxWriteFailed");
      updateScoreRecord(entry);
      return;
    }
    if (entry.status === "saved") return;
    updateScoreRecord(entry);
    bridgeQueue.enqueue(entry.payload);
  });
  const future = state.outbox.filter((entry) => entry.status === "pending"
    && !bridgeQueue.has(entry.payload.requestId)).map((entry) => entry.nextAttemptAt);
  if (future.length) {
    state.outboxRetryTimeout = window.setTimeout(pumpScoreOutbox, Math.max(100, Math.min(...future) - Date.now()));
  }
  refreshScoreViews();
}

function retryPendingScores(user) {
  loadPendingScoresFromStorage();
  state.outbox.forEach((entry) => {
    if ((user === undefined || entry.payload.user === user) && !bridgeQueue.has(entry.payload.requestId)) {
      entry.status = "pending";
      entry.attempts = 0;
      entry.nextAttemptAt = 0;
      if (!persistOutboxEntry(entry)) {
        entry.status = "error";
        entry.message = t("outboxWriteFailed");
        updateScoreRecord(entry);
      }
    }
  });
  pumpScoreOutbox();
}

function handleBridgeTimeout(payload) {
  if (payload.type === "save_score") {
    const entry = state.outbox.find((item) => item.payload.requestId === payload.requestId);
    if (entry) {
      const retry = entry.attempts < SCORE_SYNC_AUTO_RETRY_MAX;
      entry.status = retry ? "pending" : "error";
      entry.message = t(retry ? "scoreAutoRetry" : "scoreRetryLimit");
      entry.nextAttemptAt = Date.now() + SCORE_SYNC_RETRY_DELAY_MS * (2 ** Math.max(0, entry.attempts - 1));
      persistOutboxEntry(entry);
      updateScoreRecord(entry);
      pumpScoreOutbox();
    }
  } else if (payload.type === "load_rankings" && payload.requestId === state.rankings.requestId) {
    state.rankings.status = "error";
    state.rankings.message = t("rankingTimeout");
    renderCloudRankings();
  } else if (payload.type === "load_progress" && payload.requestId === state.progress.requestId) {
    state.progress.status = "error";
    state.progress.message = t("progressFailed");
    state.progress.settings.ok = false;
    renderProgress();
  } else if (payload.type === "save_user_settings" && payload.requestId === state.progress.settingsRequestId) {
    state.progress.settingsPending = false;
    state.progress.settingsRequestId = "";
    state.progress.settings.ok = false;
    state.progress.settings.message = t("settingsUnconfirmed");
    renderProgress();
    requestProgress({ force: true });
  }
}

function buildScoreSyncPayload(session, summary, retryMode = "") {
  const settings = session.settings || {};
  const spartanAccuracy = session.spartanAttempts ? session.spartanCorrect / session.spartanAttempts : 0;
  return {
    type: "save_score",
    requestId: session.scoreSyncRequestId,
    saveId: session.scoreSaveId,
    sessionId: session.id,
    appVersion: APP_VERSION,
    mobileSource: session.source || state.mobileConfig.source,
    targetLang: session.targetLang || state.mobileConfig.targetLang,
    user: String(settings.userName || "").trim(),
    mode: settings.mode === "sentence" ? "sentence" : "vocab",
    direction: settings.direction,
    correct: summary.correct,
    total: summary.total,
    accuracy: summary.accuracy,
    points: summary.points,
    accuracyBonus: summary.accuracyBonus,
    rawPointsTotal: session.mainPoints + session.spartanRawPoints,
    rawPointsMain: session.mainPoints,
    rawPointsSpartan: session.spartanRawPoints,
    spartanScaledPoints: session.spartanScaledPoints,
    spartanAttempts: session.spartanAttempts,
    spartanCorrect: session.spartanCorrect,
    spartanAccuracy,
    spartanMode: Boolean(settings.spartanMode),
    groupId: settings.groupId || "",
    seed: settings.seed,
    pos: settings.pos || "",
    topic: settings.topic || "",
    subtopic: settings.subtopic || "",
    levels: Array.isArray(settings.levels) ? settings.levels : [],
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    ts: new Date().toISOString(),
    retryMode,
  };
}

function renderReview() {
  const session = state.session;
  const wrongAnswers = session.answers.filter((answer) => answer.selectedIndex !== answer.answerIndex);
  if (!wrongAnswers.length) {
    const empty = document.createElement("div");
    empty.className = "review-item";
    empty.innerHTML = `<strong>${escapeHtml(t("noWrongTitle"))}</strong><p>${escapeHtml(t("noWrongBody"))}</p>`;
    els.reviewList.replaceChildren(empty);
    return;
  }
  els.reviewList.replaceChildren(
    ...wrongAnswers.map((answer) => {
      const question = session.questions[answer.qIndex];
      const selected = question?.options[answer.selectedIndex];
      const correct = question?.options[answer.answerIndex];
      const item = document.createElement("article");
      item.className = "review-item";
      const prompt = question ? displayPrompt(question, session.settings.direction) : "";
      const selectedText = selected ? displayOption(selected, session.settings.direction) : "";
      const correctText = correct ? displayOption(correct, session.settings.direction) : "";
      const heading = document.createElement("div");
      heading.className = "review-item-heading";
      const title = document.createElement("strong");
      title.textContent = prompt;
      heading.append(title);
      if (question && correct && canPlayReviewAudio(question, correct)) {
        const audioButton = document.createElement("button");
        audioButton.type = "button";
        audioButton.className = "review-audio-button";
        audioButton.textContent = "♪";
        audioButton.setAttribute("aria-label", t("reviewAudioAria"));
        audioButton.addEventListener("click", () => playAudio(question.mode, correct));
        heading.append(audioButton);
      }
      const correctLine = document.createElement("p");
      correctLine.textContent = `${t("correct")}: ${correctText}`;
      const selectedLine = document.createElement("p");
      selectedLine.textContent = `${t("answer")}: ${selectedText || "-"}`;
      item.append(heading, correctLine, selectedLine);
      return item;
    }),
  );
}

function renderCloudRankings() {
  if (state.progress.settingsPending || state.progress.settingsUncertain) {
    els.rankingRefreshButton.disabled = true;
    els.rankingStatus.textContent = t("rankingVisibilityUpdating");
    els.rankingList.replaceChildren();
    requestFrameHeightSync();
    return;
  }
  const tab = state.rankings.activeTab || "overall";
  els.rankingTabs.forEach((button) => {
    const selected = button.dataset.rankingTab === tab;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });

  if (state.rankings.status === "loading") {
    els.rankingRefreshButton.disabled = true;
    els.rankingRefreshButton.textContent = t("rankingLoadingShort");
    els.rankingStatus.textContent = state.rankings.message || t("rankingLoading");
    els.rankingList.replaceChildren(createRankingMessage(t("rankingLoadingShort")));
    requestFrameHeightSync();
    return;
  }

  els.rankingRefreshButton.disabled = false;
  els.rankingRefreshButton.textContent = t("refresh");
  if (state.rankings.status === "idle") {
    els.rankingStatus.textContent = t("rankingIdle");
    els.rankingList.replaceChildren(createRankingMessage(t("rankingPrompt")));
    requestFrameHeightSync();
    return;
  }
  if (state.rankings.status === "unavailable" || state.rankings.status === "error") {
    els.rankingStatus.textContent = state.rankings.message || t("rankingFailedMessage");
    els.rankingList.replaceChildren(createRankingMessage(t("connectionRetry")));
    requestFrameHeightSync();
    return;
  }

  const updatedAt = state.rankings.updatedAt ? formatDate(state.rankings.updatedAt) : "";
  els.rankingStatus.textContent = updatedAt
    ? `${state.rankings.message || t("rankingUpdatedMessage")} / ${updatedAt}`
    : state.rankings.message || t("rankingUpdatedMessage");
  const rows = state.rankings.rankings[tab] || [];
  if (!rows.length) {
    els.rankingList.replaceChildren(createRankingMessage(formatText("rankingEmpty", { tab: rankingTabLabel(tab) })));
    requestFrameHeightSync();
    return;
  }
  els.rankingList.replaceChildren(...rows.map((row) => createRankingItem(row)));
  requestFrameHeightSync();
}

function createRankingMessage(message) {
  const item = document.createElement("div");
  item.className = "ranking-item ranking-message";
  const text = document.createElement("p");
  text.textContent = message;
  item.append(text);
  return item;
}

function createRankingItem(row) {
  const item = document.createElement("article");
  item.className = "ranking-item";
  item.classList.toggle("is-current", row.user === currentUserName());
  const rank = document.createElement("div");
  rank.className = "ranking-rank";
  rank.textContent = String(row.rank);
  const user = document.createElement("div");
  user.className = "ranking-user";
  const name = document.createElement("strong");
  name.textContent = row.user;
  const note = document.createElement("p");
  note.textContent = row.user === currentUserName() ? t("currentUser") : "";
  user.append(name, note);
  const points = document.createElement("div");
  points.className = "ranking-points";
  points.textContent = `${Number(row.points || 0).toFixed(1)}${currentLangMeta().pointUnit}`;
  item.append(rank, user, points);
  return item;
}

function rankingTabLabel(tab) {
  return {
    overall: t("rankingOverall"),
    today: t("rankingToday"),
    month: t("rankingMonth"),
    hof: t("rankingHof"),
  }[tab] || t("rankingOverall");
}

function currentUserName() {
  return String(state.settings.userName || "").trim();
}

function createEmptyProgressState() {
  return {
    status: "idle", requestId: "", user: "", targetLang: "", message: "", loadedAt: 0,
    updatedAt: "", totals: { overall: 0, vocab: 0, sentence: 0 },
    categories: { vocab: [], sentence: [] },
    settings: { ok: false, rankingPublic: true, message: "" },
    settingsPending: false, settingsUncertain: false, settingsRequestId: "",
  };
}

function invalidateAccountData() {
  state.progress = createEmptyProgressState();
  state.rankings = createEmptyRankingsState();
  bridgeQueue.discardPending((payload) => ["load_progress", "load_rankings"].includes(payload.type));
}

function changeCurrentUser(value) {
  const user = String(value || "").trim();
  if (user === currentUserName()) return;
  state.settings.userName = user;
  invalidateAccountData();
  els.userName.value = user;
  saveSettings();
  if (state.currentView === "history") renderHistory();
}

function requestProgress({ force = false } = {}) {
  const user = currentUserName();
  if (!user || !IS_STREAMLIT_COMPONENT) {
    state.progress.status = user ? "unavailable" : "idle";
    state.progress.settings.ok = false;
    renderProgress();
    return;
  }
  const targetLang = state.mobileConfig.targetLang;
  if (state.progress.user !== user || state.progress.targetLang !== targetLang) {
    state.progress = createEmptyProgressState();
    bridgeQueue.discardPending((payload) => payload.type === "load_progress");
  }
  if (state.progress.status === "loading" || state.progress.settingsPending) return;
  if (!force && isAccountCacheFresh(state.progress, { user, targetLang, ttlMs: RANKING_CACHE_TTL_MS })) {
    renderProgress();
    return;
  }
  Object.assign(state.progress, {
    status: "loading", requestId: createId(), user, targetLang: state.mobileConfig.targetLang,
    message: t("progressLoading"),
  });
  state.progress.settings.ok = false;
  renderProgress();
  bridgeQueue.enqueue({
    type: "load_progress", requestId: state.progress.requestId, user,
    targetLang: state.mobileConfig.targetLang,
  });
}

function handleProgressResult(result) {
  if (!isPlainObject(result) || result.type !== "progress_result") return;
  bridgeQueue.accept(result);
  if (!matchesAccountResult(result, state.progress, currentUserName(), state.mobileConfig.targetLang)) return;
  state.progress.requestId = "";
  state.progress.status = result.ok ? "ready" : "error";
  state.progress.message = String(result.message || t(result.ok ? "progressReady" : "progressFailed"));
  state.progress.updatedAt = String(result.updatedAt || "");
  state.progress.loadedAt = result.ok ? Date.now() : 0;
  if (result.ok) {
    state.progress.totals = Object.fromEntries(["overall", "vocab", "sentence"].map((key) =>
      [key, finiteNumber(result.totals?.[key], 0)]));
    const categories = (items, nested = false) => (Array.isArray(items) ? items : [])
      .filter(isPlainObject).map((item) => ({
        key: String(item.key || ""), points: finiteNumber(item.points, 0),
        attempts: clampInteger(item.attempts, 0, 99999999, 0),
        subtopics: nested ? categories(item.subtopics) : [],
      }));
    state.progress.categories = {
      vocab: categories(result.categories?.vocab), sentence: categories(result.categories?.sentence, true),
    };
  }
  const previousRankingPublic = state.progress.settings.rankingPublic;
  state.progress.settings = {
    ok: result.settings?.ok === true && typeof result.settings.rankingPublic === "boolean",
    rankingPublic: result.settings?.rankingPublic === true,
    message: String(result.settings?.message || ""),
  };
  const refreshVisibility = !state.progress.settings.ok || state.progress.settingsUncertain
    || previousRankingPublic !== state.progress.settings.rankingPublic || !state.progress.settings.rankingPublic;
  state.progress.settingsUncertain = !state.progress.settings.ok;
  if (refreshVisibility) {
    // A progress refresh can discover a preference changed in another tab.
    // Remove obsolete public names before any replacement ranking is requested.
    bridgeQueue.discardPending((payload) => payload.type === "load_rankings");
    state.rankings = createEmptyRankingsState();
    renderCloudRankings();
    if (state.progress.settings.ok && state.currentView === "history") {
      requestRankings({ force: true });
    }
  }
  renderProgress();
}

function saveRankingVisibility() {
  const progress = state.progress;
  if (!progress.settings.ok || progress.settingsPending || !currentUserName()
      || progress.user !== currentUserName() || progress.targetLang !== state.mobileConfig.targetLang) {
    renderProgress();
    return;
  }
  const rankingPublic = els.rankingPublic.checked;
  progress.settingsPending = true;
  progress.settingsUncertain = true;
  bridgeQueue.discardPending((payload) => payload.type === "load_rankings");
  state.rankings = createEmptyRankingsState();
  renderCloudRankings();
  progress.settingsRequestId = createId();
  progress.settings.message = t("settingsSaving");
  renderProgress();
  bridgeQueue.enqueue({
    type: "save_user_settings", requestId: progress.settingsRequestId,
    user: currentUserName(), targetLang: state.mobileConfig.targetLang, rankingPublic,
  });
}

function handleUserSettingsResult(result) {
  if (!isPlainObject(result) || result.type !== "user_settings_result") return;
  bridgeQueue.accept(result);
  const progress = state.progress;
  if (!matchesAccountResult(result, { ...progress, requestId: progress.settingsRequestId },
    currentUserName(), state.mobileConfig.targetLang)) return;
  progress.settingsPending = false;
  progress.settingsRequestId = "";
  const confirmed = result.ok === true && typeof result.rankingPublic === "boolean";
  progress.settings.ok = confirmed;
  if (confirmed) {
    progress.settings.rankingPublic = result.rankingPublic;
    progress.settingsUncertain = false;
  }
  progress.settings.message = String(result.message || t(confirmed ? "settingsSaved" : "settingsFailed"));
  if (confirmed) {
    state.rankings.loadedAt = 0;
    state.progress.loadedAt = 0;
    // Remove any now-obsolete list immediately, including a ranking request queued before this change.
    bridgeQueue.discardPending((payload) => payload.type === "load_rankings");
    state.rankings = createEmptyRankingsState();
    requestRankings({ force: true });
  }
  renderProgress();
  if (!confirmed) requestProgress({ force: true });
}

function renderProgress() {
  const progress = state.progress;
  const hasUser = Boolean(currentUserName());
  const accountMatches = progress.user === currentUserName() && progress.targetLang === state.mobileConfig.targetLang;
  els.progressRefreshButton.disabled = !hasUser || !IS_STREAMLIT_COMPONENT
    || progress.status === "loading" || progress.settingsPending;
  els.rankingPublic.disabled = !hasUser || !IS_STREAMLIT_COMPONENT
    || !accountMatches || !progress.settings.ok || progress.settingsPending;
  // Keep displaying the last server-confirmed choice while the mutation is pending.
  els.rankingPublic.checked = accountMatches && progress.settings.ok ? progress.settings.rankingPublic : false;
  els.rankingPublic.indeterminate = !accountMatches || !progress.settings.ok;
  els.rankingSettingsStatus.textContent = (accountMatches ? progress.settings.message : "")
    || (!hasUser ? t("progressNeedsUser") : !IS_STREAMLIT_COMPONENT ? t("progressUnavailable")
      : !progress.settings.ok ? t("settingsNotLoaded") : "");
  els.rankingSettingsStatus.classList.toggle("is-error", Boolean(hasUser && progress.status === "error"));
  const status = !hasUser ? t("progressNeedsUser")
    : !IS_STREAMLIT_COMPONENT ? t("progressUnavailable")
      : progress.status === "idle" ? t("progressPrompt") : progress.message;
  els.progressStatus.textContent = status;
  if (progress.status !== "ready" || !accountMatches) {
    els.progressContent.replaceChildren();
    requestFrameHeightSync();
    return;
  }
  const summary = document.createElement("div");
  summary.className = "progress-totals";
  [["overall", t("allFields")], ["vocab", modeLabel("vocab")], ["sentence", modeLabel("sentence")]].forEach(([key, label]) => {
    const item = document.createElement("div");
    const title = document.createElement("span");
    title.textContent = label;
    const points = document.createElement("strong");
    points.textContent = `${progress.totals[key].toFixed(1)}${currentLangMeta().pointUnit}`;
    item.append(title, points);
    summary.append(item);
  });
  const sections = [summary];
  for (const mode of ["vocab", "sentence"]) {
    const section = document.createElement("section");
    section.className = "progress-breakdown";
    const heading = document.createElement("h4");
    heading.textContent = t(mode === "vocab" ? "vocabBreakdown" : "sentenceBreakdown");
    section.append(heading);
    const rows = progress.categories[mode];
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "muted-text";
      empty.textContent = t("progressEmpty");
      section.append(empty);
    }
    rows.forEach((row) => {
      const label = row.key ? mode === "vocab" ? labelForPos(row.key) : row.key : t("uncategorized");
      if (mode === "sentence" && row.subtopics.length) {
        const details = document.createElement("details");
        const title = document.createElement("summary");
        title.append(createProgressRow(row, label));
        details.append(title);
        row.subtopics.forEach((subtopic) => details.append(createProgressRow(subtopic, subtopic.key || t("uncategorized"))));
        section.append(details);
      } else {
        section.append(createProgressRow(row, label));
      }
    });
    sections.push(section);
  }
  els.progressContent.replaceChildren(...sections);
  requestFrameHeightSync();
}

function createProgressRow(row, label) {
  const line = document.createElement("div");
  line.className = "progress-category-row";
  const title = document.createElement("span");
  title.textContent = label;
  const points = document.createElement("strong");
  points.textContent = `${row.points.toFixed(1)}${currentLangMeta().pointUnit}`;
  line.append(title, points);
  return line;
}

function renderHistory() {
  renderProgress();
  renderCloudRankings();
  if (document.activeElement !== els.historyUserName) els.historyUserName.value = currentUserName();
  const records = filterUserHistory(state.history, currentUserName());
  els.clearHistoryButton.disabled = !records.length;
  const unsent = state.outbox.filter((entry) => entry.payload.user === currentUserName());
  els.retryPendingButton.hidden = !unsent.length;
  els.retryPendingButton.disabled = !unsent.some((entry) => !bridgeQueue.has(entry.payload.requestId));
  els.outboxStatus.textContent = state.outboxReadFailed ? t("outboxReadFailed")
    : unsent.length ? formatText("pendingRecords", { count: unsent.length }) : "";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.innerHTML = `<strong>${escapeHtml(t("historyEmptyTitle"))}</strong><p>${escapeHtml(t("historyEmptyBody"))}</p>`;
    els.historyList.replaceChildren(empty);
    return;
  }
  els.historyList.replaceChildren(
    ...records.map((record) => {
      const item = document.createElement("article");
      item.className = "history-item";
      const mode = modeLabel(record.mode);
      const date = formatDate(record.completedAt);
      item.innerHTML = `
        <strong>${escapeHtml(mode)} ${escapeHtml(record.points.toFixed(1))}${escapeHtml(currentLangMeta().pointUnit)}</strong>
        <p>${escapeHtml(date)} / ${escapeHtml(record.correct)}/${escapeHtml(record.total)} ${escapeHtml(t("correct"))} / ${escapeHtml(Math.round(record.accuracy * 100))}%</p>
        <p class="history-sync-status">${escapeHtml(t({ saved: "recordSaved", pending: "recordPending", error: "recordUnsent", local: "recordLocal" }[record.scoreSyncStatus] || "recordUnknown"))}</p>
      `;
      return item;
    }),
  );
}

function renderDiagnostics() {
  state.diagnosticsRenderToken += 1;
  const renderToken = state.diagnosticsRenderToken;
  const sessionStatus = state.session
    ? `${sessionStatusLabel(state.session.status)} / ${modeLabel(state.session.settings?.mode)}`
    : t("noStoredQuiz");
  const manifestVocabCount = Object.keys(state.data.audioManifest.vocab || {}).length;
  const manifestSentenceCount = Object.keys(state.data.audioManifest.sentence || {}).length;
  const storageBytes = estimateLocalStorageBytes();
  const rows = [
    [t("appVersion"), APP_VERSION],
    [t("runtime"), IS_STREAMLIT_COMPONENT ? t("streamlitEmbedded") : t("staticPwa")],
    [t("quizData"), formatText("entriesCount", { vocab: state.data.vocab.length, sentences: state.data.sentences.length })],
    [t("audioSettings"), state.audioConfig.enabled ? audioDiagnosticText() : t("audioOff")],
    [t("audioManifest"), formatText("entriesCount", { vocab: manifestVocabCount, sentences: manifestSentenceCount })],
    [t("quizSave"), sessionStatus],
    [t("localHistory"), `${state.history.length}/${HISTORY_MAX_ITEMS}`],
    [t("storageUse"), storageBytes ? formatText("storageApprox", { value: formatBytes(storageBytes) }) : t("storageUnused")],
    [t("ranking"), rankingDiagnosticText()],
    [t("scoreSave"), scoreSyncDiagnosticText()],
    ["Service Worker", serviceWorkerDiagnosticText()],
  ];
  const items = rows.map(([label, value]) => createDiagnosticItem(label, value));
  items.splice(
    5,
    0,
    createAudioDiagnosticItem(t("vocabAudioTest"), "vocab"),
    createAudioDiagnosticItem(t("sentenceAudioTest"), "sentence"),
  );
  els.diagnosticsList.replaceChildren(...items);
  requestFrameHeightSync();
  updateStorageEstimate(renderToken);
}

function createDiagnosticItem(labelText, valueText) {
  const item = document.createElement("article");
  item.className = "diagnostic-item";
  const label = document.createElement("strong");
  label.textContent = labelText;
  const value = document.createElement("span");
  value.textContent = valueText;
  item.append(label, value);
  return item;
}

function sessionStatusLabel(status) {
  return {
    active: t("sessionActive"),
    complete: t("complete"),
  }[status] || t("none");
}

function audioDiagnosticText() {
  const source = [];
  if (state.audioConfig.vocabBaseUrl) {
    source.push(t("audioVocabUrl"));
  }
  if (state.audioConfig.sentenceBaseUrl) {
    source.push(t("audioSentenceUrl"));
  }
  if (state.audioConfig.useDriveManifest) {
    source.push(t("audioDriveFallback"));
  }
  return source.length ? source.join(" / ") : t("audioNoUrl");
}

function createAudioDiagnosticItem(labelText, mode) {
  const sample = getAudioDiagnosticSample(mode);
  const status = state.audioDiagnostics[mode] || { status: "idle", message: t("unknown"), audioKey: "" };
  const item = document.createElement("article");
  item.className = "diagnostic-item diagnostic-audio-item";

  const label = document.createElement("strong");
  label.textContent = labelText;
  const summary = document.createElement("span");
  const sampleKey = sample?.audioKey || status.audioKey || "";
  summary.textContent = sampleKey ? `${t("sample")}: ${sampleKey}.wav` : t("noAudioTest");

  const controls = document.createElement("div");
  controls.className = "diagnostic-audio-actions";
  const button = document.createElement("button");
  button.id = mode === "sentence" ? "audioDiagSentenceButton" : "audioDiagVocabButton";
  button.className = "text-button";
  button.type = "button";
  button.textContent = status.status === "running" ? t("audioPlaying") : t("audioTest");
  button.disabled = !sample || status.status === "running";
  button.addEventListener("click", () => runAudioDiagnostic(mode));

  const statusText = document.createElement("p");
  statusText.id = mode === "sentence" ? "audioDiagSentenceStatus" : "audioDiagVocabStatus";
  statusText.className = `diagnostic-audio-status is-${status.status || "idle"}`;
  statusText.textContent = status.message || t("unknown");
  controls.append(button, statusText);
  item.append(label, summary, controls);
  return item;
}

function getAudioDiagnosticSample(mode) {
  const entries = mode === "sentence" ? state.data.sentences : state.data.vocab;
  return entries.find((entry) => entry?.audioKey && getAudioUrls(mode, entry).length) || null;
}

function setAudioDiagnosticState(mode, status, message, audioKey = "") {
  state.audioDiagnostics[mode] = {
    status,
    message,
    audioKey,
    at: new Date().toISOString(),
  };
}

async function runAudioDiagnostic(mode) {
  const sample = getAudioDiagnosticSample(mode);
  if (!sample) {
    setAudioDiagnosticState(mode, "error", t("audioTestMissing"));
    renderDiagnostics();
    return;
  }
  const urls = getAudioUrls(mode, sample);
  const primaryUrl = urls[0] || "";
  setAudioDiagnosticState(mode, "running", formatText("audioTesting", { key: sample.audioKey }), sample.audioKey);
  renderDiagnostics();
  const ok = await playAudio(mode, sample, { silentFailure: true });
  if (ok) {
    setAudioDiagnosticState(mode, "success", formatText("audioTestSuccess", { key: sample.audioKey }), sample.audioKey);
    showToast(formatText("audioTestToast", { mode: modeLabel(mode) }));
  } else {
    const hint = primaryUrl ? `URL: ${primaryUrl}` : t("audioNoUrl");
    setAudioDiagnosticState(mode, "error", formatText("audioTestFailed", { hint }), sample.audioKey);
  }
  if (state.currentView === "diagnostics") {
    renderDiagnostics();
  }
}

function rankingDiagnosticText() {
  const status = {
    idle: t("rankingStatusIdle"),
    loading: t("rankingStatusLoading"),
    ready: t("rankingStatusReady"),
    error: t("error"),
    unavailable: t("rankingStatusUnavailable"),
  }[state.rankings.status] || state.rankings.status;
  const updated = state.rankings.updatedAt ? ` / ${formatDate(state.rankings.updatedAt)}` : "";
  return `${status}${updated}${state.rankings.message ? ` / ${state.rankings.message}` : ""}`;
}

function scoreSyncDiagnosticText() {
  const session = state.session;
  if (!isCompleteSession(session)) {
    return t("scoreStatusNoComplete");
  }
  const status = {
    idle: t("scoreStatusIdle"),
    pending: t("scoreStatusPending"),
    saved: t("scoreStatusSaved"),
    error: t("error"),
  }[session.scoreSyncStatus] || session.scoreSyncStatus;
  const recoverable = session.scoreSyncRecoverable === "totals_update" ? t("scoreRecoverableTotals") : "";
  return `${status}${recoverable}${session.scoreSyncMessage ? ` / ${session.scoreSyncMessage}` : ""}`;
}

function serviceWorkerDiagnosticText() {
  if (IS_STREAMLIT_COMPONENT) {
    return t("serviceWorkerDisabled");
  }
  if (!("serviceWorker" in navigator)) {
    return t("unsupported");
  }
  return navigator.serviceWorker.controller ? t("serviceWorkerActive") : t("serviceWorkerPending");
}

function estimateLocalStorageBytes() {
  try {
    return [SESSION_KEY, SETTINGS_KEY, HISTORY_KEY]
      .map((key) => (window.localStorage.getItem(key) || "").length * 2)
      .reduce((acc, value) => acc + value, 0);
  } catch (error) {
    return 0;
  }
}

async function updateStorageEstimate(renderToken) {
  if (!navigator.storage?.estimate || state.currentView !== "diagnostics") {
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    if (state.currentView !== "diagnostics" || state.diagnosticsRenderToken !== renderToken) {
      return;
    }
    const used = estimate.usage ? formatBytes(estimate.usage) : t("unknown");
    const quota = estimate.quota ? formatBytes(estimate.quota) : t("unknown");
    const item = createDiagnosticItem(t("browserStorage"), `${used} / ${quota}`);
    els.diagnosticsList.append(item);
    requestFrameHeightSync();
  } catch (error) {
    console.warn("Storage estimate failed", error);
  }
}

function getCurrentQuestion() {
  const session = state.session;
  if (!session) {
    return null;
  }
  return session.questions[getCurrentQuestionIndex()] || null;
}

function getCurrentQuestionIndex() {
  const session = state.session;
  if (!session) {
    return -1;
  }
  if (session.inSpartan) {
    if (session.spartanCurrent === null || session.spartanCurrent === undefined || !session.spartanPending.includes(session.spartanCurrent)) {
      session.spartanCurrent = randomItem(session.spartanPending);
    }
    return session.spartanCurrent;
  }
  return session.qIndex;
}

function remainingCount(session) {
  if (session.inSpartan) {
    return session.spartanPending.length;
  }
  return Math.max(session.questions.length - session.qIndex, 0);
}

function displayPrompt(question, direction) {
  return direction === "ja_to_eo" ? question.promptJa : question.promptEo;
}

function displayOption(option, direction) {
  return direction === "ja_to_eo" ? option.eo : option.ja;
}


function isPromptEsperanto(direction) {
  return direction === "eo_to_ja";
}

function areChoicesEsperanto(direction) {
  return direction === "ja_to_eo";
}

function canPlayPromptAudio(session, question) {
  const answerOption = question.options[question.answerIndex];
  return Boolean(
    session.settings.audioMode !== "off"
    && isPromptEsperanto(session.settings.direction)
    && hasPlayableAudioForMode(question.mode, answerOption),
  );
}

function canPlayChoiceAudio(session, question, option) {
  return Boolean(
    session.settings.audioMode === "all"
    && areChoicesEsperanto(session.settings.direction)
    && hasPlayableAudioForMode(question.mode, option),
  );
}

function canPlayReviewAudio(question, option) {
  return Boolean(question && option && hasPlayableAudioForMode(question.mode, option));
}

function allowAutoPromptAudioFromUserAction() {
  state.autoPromptAudioAllowedUntil = Date.now() + 2500;
}

function maybeAutoPlayPromptAudio(session, question) {
  if (!canAutoPlayPromptAudio(session, question)) {
    return;
  }
  const key = getPromptAudioAutoKey(session, question);
  if (!key || key === state.lastAutoPromptAudioKey) {
    return;
  }
  state.lastAutoPromptAudioKey = key;
  const answerOption = question.options[question.answerIndex];
  playAudio(question.mode, answerOption, { silentFailure: true });
}

function canAutoPlayPromptAudio(session, question) {
  return Boolean(
    Date.now() <= state.autoPromptAudioAllowedUntil
    && !session.showingFeedback
    && canPlayPromptAudio(session, question),
  );
}

function getPromptAudioAutoKey(session, question) {
  const answerOption = question.options[question.answerIndex];
  if (!answerOption?.audioKey) {
    return "";
  }
  const phase = session.inSpartan ? "spartan" : "main";
  return [
    session.id,
    phase,
    getCurrentQuestionIndex(),
    session.answers.length,
    answerOption.audioKey,
  ].join(":");
}

async function playAudio(mode, option, { silentFailure = false } = {}) {
  const urls = getAudioUrls(mode, option);
  if (!urls.length) {
    if (!silentFailure) {
      showToast(t("audioMissing"));
    }
    return false;
  }
  state.audioPlaybackToken += 1;
  const token = state.audioPlaybackToken;
  let lastError = null;
  for (const url of urls) {
    try {
      await playAudioUrl(url, token);
      return true;
    } catch (error) {
      if (token !== state.audioPlaybackToken) {
        return false;
      }
      lastError = error;
    }
  }
  console.warn("Audio playback failed", lastError);
  if (!silentFailure) {
    showToast(t("audioFailed"));
  }
  return false;
}

function getAudioPlayer() {
  if (!state.audioPlayer) {
    state.audioPlayer = new Audio();
    state.audioPlayer.preload = "auto";
    state.audioPlayer.playsInline = true;
  }
  return state.audioPlayer;
}

function playAudioUrl(url, token) {
  const audio = getAudioPlayer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      finish(false, new Error("Audio playback timed out"));
    }, AUDIO_PLAYBACK_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      audio.removeEventListener("error", onError);
    };
    const finish = (ok, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (ok) {
        resolve(value);
      } else {
        reject(value);
      }
    };
    const onError = () => {
      finish(false, audio.error || new Error("Audio load failed"));
    };
    audio.addEventListener("error", onError, { once: true });
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (token !== state.audioPlaybackToken) {
        finish(false, new Error("Audio playback superseded"));
        return;
      }
      audio.src = url;
      audio.load();
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise.then(() => finish(true)).catch((error) => finish(false, error));
      } else {
        finish(true);
      }
    } catch (error) {
      finish(false, error);
    }
  });
}

function hasPlayableAudio(option) {
  const mode = getCurrentQuestion()?.mode || state.settings.mode;
  return hasPlayableAudioForMode(mode, option);
}

function hasPlayableAudioForMode(mode, option) {
  return Boolean(option?.hasAudio && getAudioUrl(mode, option));
}

function hasAudioForMode(mode) {
  return Boolean(state.audioConfig.enabled && (
    getAudioBaseUrl(mode)
    || (state.audioConfig.useDriveManifest && hasAudioManifestForMode(mode))
  ));
}

function getAudioUrl(mode, option) {
  return getAudioUrls(mode, option)[0] || "";
}

function getAudioUrls(mode, option) {
  if (!state.audioConfig.enabled || !option?.audioKey) {
    return [];
  }
  const urls = [];
  const base = getAudioBaseUrl(mode);
  if (base) {
    urls.push(encodeURI(`${base}${option.audioKey}.wav`));
  }
  const fileId = getAudioManifestFileId(mode, option.audioKey);
  if (state.audioConfig.useDriveManifest && fileId) {
    urls.push(buildDriveAudioUrl(fileId));
  }
  return [...new Set(urls)];
}

function getAudioBaseUrl(mode) {
  if (mode === "sentence") {
    return state.audioConfig.sentenceBaseUrl;
  }
  return state.audioConfig.vocabBaseUrl;
}

function hasAudioManifestForMode(mode) {
  const entries = mode === "sentence" ? state.data.audioManifest.sentence : state.data.audioManifest.vocab;
  return Boolean(entries && Object.keys(entries).length);
}

function getAudioManifestFileId(mode, audioKey) {
  const entries = mode === "sentence" ? state.data.audioManifest.sentence : state.data.audioManifest.vocab;
  return entries?.[String(audioKey || "").trim()] || "";
}

function buildDriveAudioUrl(fileId) {
  const encodedId = encodeURIComponent(fileId);
  const base = state.audioConfig.driveDownloadBaseUrl || DRIVE_AUDIO_DOWNLOAD_BASE;
  return base.includes("{id}") ? base.replace("{id}", encodedId) : `${base}${encodedId}`;
}

function ensureTrailingSlash(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.endsWith("/") ? text : `${text}/`;
}

function setView(view) {
  const viewChanged = state.currentView !== view;
  state.currentView = view;
  els.app?.classList.remove("view-loading", "view-setup", "view-quiz", "view-result", "view-history", "view-diagnostics", "view-error");
  els.app?.classList.add(`view-${view}`);
  const viewMap = {
    loading: els.loadingView,
    setup: els.setupView,
    quiz: els.quizView,
    result: els.resultView,
    history: els.historyView,
    diagnostics: els.diagnosticsView,
    error: els.errorView,
  };
  Object.entries(viewMap).forEach(([name, element]) => {
    element.classList.toggle("is-active", name === view);
  });
  els.homeNav.classList.toggle("is-selected", view === "setup");
  els.quizNav.classList.toggle("is-selected", view === "quiz" || view === "result");
  els.historyNav.classList.toggle("is-selected", view === "history");
  els.diagnosticsNav.classList.toggle("is-selected", view === "diagnostics");
  // Initial data loading chooses the first view when it finishes. Keep users
  // from navigating to a page that initialization would immediately replace.
  [els.homeNav, els.quizNav, els.historyNav, els.diagnosticsNav].forEach((button) => {
    button.disabled = view === "loading";
  });
  if (view === "setup") {
    renderSetup();
  }
  if (view === "result") {
    renderResult();
  }
  if (view === "diagnostics") {
    renderDiagnostics();
  }
  if (viewChanged && els.app) {
    els.app.scrollTop = 0;
  }
  if (view === "quiz") {
    window.requestAnimationFrame(scrollHostToTop);
    window.setTimeout(scrollHostToTop, 120);
    window.setTimeout(scrollHostToTop, 350);
  }
  requestFrameHeightSync();
}

function refreshResumeButton() {
  const canResume = isActiveSession(state.session) || isCompleteSession(state.session);
  els.resumeButton.hidden = !canResume;
  els.resumeNotice.hidden = !canResume;
  if (canResume) {
    els.resumeMeta.textContent = describeStoredSession(state.session);
  } else {
    els.resumeMeta.textContent = "";
  }
  requestFrameHeightSync();
}

function describeStoredSession(session) {
  const mode = session.settings?.mode === "sentence" ? currentLangMeta().modeSentence : currentLangMeta().modeVocab;
  if (isCompleteSession(session)) {
    const summary = computeResultSummary(session);
    return `${mode} / ${t("complete")} / ${summary.correct}/${summary.total} ${t("correct")}`;
  }
  const current = Math.min(Number(session.qIndex || 0) + 1, session.questions.length);
  const review = Array.isArray(session.spartanPending) && session.spartanPending.length
    ? ` / ${t("review")} ${session.spartanPending.length}`
    : "";
  return `${mode} / Q${current}/${session.questions.length}${review}`;
}

function updateSaveStatus(text) {
  els.saveStatus.textContent = text;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function showFatalError(error) {
  console.error(error);
  els.errorMessage.textContent = error?.message || String(error);
  setView("error");
  updateSaveStatus(t("error"));
}

function isActiveSession(session) {
  return Boolean(session && session.status === "active" && Array.isArray(session.questions) && session.questions.length);
}

function isCompleteSession(session) {
  return Boolean(session && session.status === "complete" && Array.isArray(session.questions) && session.questions.length);
}

function formatStageLabel(stages) {
  return stages.map((stage) => {
    const [name, number] = stage.split("_");
    const labels = STAGE_LABELS[state.mobileConfig.targetLang] || STAGE_LABELS.ja;
    return `${labels[name] || name}${number || ""}`;
  }).join("+");
}

function labelForPos(pos) {
  const labels = POS_LABELS[state.mobileConfig.targetLang] || POS_LABELS.ja;
  return labels[pos] || POS_LABELS.ja[pos] || pos;
}

function posSortIndex(pos) {
  const index = POS_ORDER.indexOf(pos);
  return index === -1 ? 999 : index;
}

function shuffle(items, rng) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function next() {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function randomItem(items) {
  if (!items.length) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function unique(items) {
  return [...new Set(items.filter((item) => item !== undefined && item !== null && item !== ""))];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(currentLangMeta().intlLocale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
