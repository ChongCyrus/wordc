/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { BRAND } from './src/app/brand'
import { injectBrandHtml } from './src/app/brand-html'

// 说明：本机是 Android proot（arm64）环境，构建产物体积与构建耗时都要可控：
// - 不用任何需要 Rust/原生二进制的构建期依赖（Tailwind 固定在 v3 的 PostCSS 实现）。
// - PWA 用 generateSW 模式（Workbox 自动生成 sw.js），不手写 service worker。
export default defineConfig({
  // 使用相对 base，方便 pnpm preview / 静态文件直开 / 子路径部署
  base: './',
  plugins: [
    react(),
    {
      // task-57：index.html 的品牌占位符在构建时注入（公开版只覆盖 brand.ts）
      name: 'inject-brand-html',
      transformIndexHtml(html: string) {
        return injectBrandHtml(html, BRAND)
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-512.png',
      ],
      manifest: {
        name: BRAND.name,
        short_name: BRAND.shortName,
        description: BRAND.description,
        lang: 'zh-CN',
        theme_color: '#36B59D',
        background_color: '#F6F8F7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        mode: 'development',
        // 内置词库 chunk 随例句/词组回填会超过 Workbox 默认 2MiB 上限
        // （2026-11 受限商业词表 deck 已达 2.24MB）。提高上限，保证离线首启可完整安装；
        // 仍不够时考虑把 deck 改为 runtimeCaching 或进一步拆分。
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
    // 手机端内存保护：禁用多线程池，单 fork 串行跑，避免并发 worker 触发系统 OOM(/SIGKILL)
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
})
