/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 主题由 CSS 变量驱动；dark 变体支持媒体查询默认 + data-theme 手动覆盖两种方式
  darkMode: ['variant', '&:is([data-theme="dark"] *)'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        'surface-2': 'var(--color-surface-2)',
        text: 'var(--color-text)',
        muted: 'var(--color-text-muted)',
        primary: 'var(--color-primary)',
        'primary-weak': 'var(--color-primary-weak)',
        onprimary: 'var(--color-on-primary)',
        border: 'var(--color-border)',
        danger: 'var(--color-danger)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
      },
      spacing: {
        safe: 'env(safe-area-inset-bottom)',
      },
      maxWidth: {
        app: '560px',
      },
    },
  },
  plugins: [],
}
