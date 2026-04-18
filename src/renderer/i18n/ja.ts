/** 日本語メッセージカタログ */
const ja = {
  // オンボーディング
  'onboarding.welcome.title': 'KovitoBoard へようこそ',
  'onboarding.welcome.subtitle': 'あなたの AI エージェントチームを始めましょう',
  'onboarding.welcome.language': '言語を選択してください',
  'onboarding.user.title': 'あなたについて教えてください',
  'onboarding.user.displayName': '表示名',
  'onboarding.user.displayNamePlaceholder': '名前を入力',
  'onboarding.user.avatar': 'アバター',
  'onboarding.project.title': 'プロジェクト情報',
  'onboarding.project.name': 'プロジェクト名',
  'onboarding.project.namePlaceholder': 'プロジェクト名を入力',
  'onboarding.project.description': '説明',
  'onboarding.project.descriptionPlaceholder': 'プロジェクトの概要を入力',
  'onboarding.concierge.title': 'コビーを迎え入れますか？',
  'onboarding.concierge.description': 'コビーは KovitoBoard のコンシェルジュです。使い方の案内や簡単な開発をサポートします。',
  'onboarding.concierge.add': '追加する',
  'onboarding.concierge.skip': 'スキップ',
  'onboarding.complete.title': 'セットアップ完了！',
  'onboarding.complete.description': 'KovitoBoard の準備が整いました。',
  'onboarding.complete.startSession': 'セッションを開始する',
  'onboarding.next': '次へ',
  'onboarding.back': '戻る',
  'onboarding.step': 'ステップ {current} / {total}',

  // 共通
  'common.save': '保存',
  'common.cancel': 'キャンセル',
  'common.delete': '削除',
  'common.edit': '編集',
  'common.loading': '読み込み中...',
  'common.error': 'エラーが発生しました',
  'common.retry': '再試行',
} as const

export type MessageKey = keyof typeof ja
export default ja
