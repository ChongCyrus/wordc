import { BRAND } from './brand'

/**
 * App 版本（UI 展示用；与 APK build 版本保持一致由 arch 保证）。
 * 改版本只改这里；package.json 的 version 由 arch 发布时同步。
 */
export const APP_VERSION = '0.3.23'

/** 应用显示名（关于页/通知等；task-57 起统一从 BRAND 读） */
export const APP_NAME = BRAND.name
