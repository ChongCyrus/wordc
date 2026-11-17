import { describe, expect, it } from 'vitest'

/**
 * 架构约束测试：core 层必须保持纯 TS。
 * core 一旦 import 了 react / dexie / 浏览器全局，离线跑算法测试就会挂。
 */
const coreModules = import.meta.glob<string>('../src/core/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const FORBIDDEN = ['react', 'react-dom', 'react-router-dom', 'dexie', 'zustand']
const FORBIDDEN_GLOBALS = ['window.', 'document.', 'localStorage', 'indexedDB']

/** 去掉注释再扫，注释里提到 localStorage 不算违规 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('架构约束', () => {
  it('至少扫描到 core 层源码', () => {
    expect(Object.keys(coreModules).length).toBeGreaterThan(0)
  })

  it('core 不依赖 UI / 路由 / 数据库库', () => {
    for (const [file, source] of Object.entries(coreModules)) {
      const importLines = source
        .split('\n')
        .filter((line) => line.trimStart().startsWith('import ') || line.includes("from '"))
      for (const pkg of FORBIDDEN) {
        expect(
          importLines.some((line) => line.includes(`'${pkg}'`) || line.includes(`'${pkg}/`)),
          `${file} 不应 import ${pkg}`,
        ).toBe(false)
      }
    }
  })

  it('core 不直接访问 DOM / 浏览器存储', () => {
    for (const [file, source] of Object.entries(coreModules)) {
      const code = stripComments(source)
      for (const token of FORBIDDEN_GLOBALS) {
        expect(code.includes(token), `${file} 不应使用 ${token}`).toBe(false)
      }
    }
  })
})
