import type { MessageKey } from './ja'

/** 英語メッセージカタログ */
const en: Record<MessageKey, string> = {
  // Onboarding
  'onboarding.welcome.title': 'Welcome to KovitoBoard',
  'onboarding.welcome.subtitle': 'Let\'s set up your AI agent team',
  'onboarding.welcome.language': 'Choose your language',
  'onboarding.user.title': 'Tell us about yourself',
  'onboarding.user.displayName': 'Display name',
  'onboarding.user.displayNamePlaceholder': 'Enter your name',
  'onboarding.user.avatar': 'Avatar',
  'onboarding.project.title': 'Project information',
  'onboarding.project.name': 'Project name',
  'onboarding.project.namePlaceholder': 'Enter project name',
  'onboarding.project.description': 'Description',
  'onboarding.project.descriptionPlaceholder': 'Enter project overview',
  'onboarding.concierge.title': 'Add Kobi as your concierge?',
  'onboarding.concierge.description': 'Kobi is the KovitoBoard concierge. Helps you navigate and handles simple development tasks.',
  'onboarding.concierge.add': 'Add',
  'onboarding.concierge.skip': 'Skip',
  'onboarding.complete.title': 'Setup complete!',
  'onboarding.complete.description': 'KovitoBoard is ready to go.',
  'onboarding.complete.startSession': 'Start a session',
  'onboarding.next': 'Next',
  'onboarding.back': 'Back',
  'onboarding.step': 'Step {current} / {total}',

  // Common
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.loading': 'Loading...',
  'common.error': 'An error occurred',
  'common.retry': 'Retry',
}

export default en
