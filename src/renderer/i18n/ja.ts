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
  'onboarding.concierge.confirm': 'Kovito のコンシェルジュ「コビー」をエージェントとして追加してよろしいですか？',
  'onboarding.concierge.description': 'KB の使い方をご案内します。簡単な開発もお手伝いします。',
  'onboarding.concierge.add': '追加する',
  'onboarding.concierge.skip': 'あとで追加する',
  'onboarding.concierge.adding': '追加中...',
  'onboarding.complete.title': '準備ができました！',
  'onboarding.complete.description': 'KovitoBoard の準備が整いました。',
  'onboarding.complete.talkToKobi': 'コビーと話してみる',
  'onboarding.complete.goToDashboard': 'ダッシュボードへ',
  'onboarding.welcome.start': '始める',
  'onboarding.user.avatarHint': 'アバター画像（任意・2MB以下）',
  'onboarding.user.avatarSizeError': 'ファイルサイズが 2MB を超えています',
  'onboarding.user.displayNameRequired': '表示名を入力してください',
  'onboarding.user.displayNameMaxLength': '表示名は 30 文字以内で入力してください',
  'onboarding.project.nameRequired': 'プロジェクト名を入力してください',
  'onboarding.project.nameMaxLength': 'プロジェクト名は 50 文字以内で入力してください',
  'onboarding.project.descriptionMaxLength': '説明は 500 文字以内で入力してください',
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
