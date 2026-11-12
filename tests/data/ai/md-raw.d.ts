/** 允许测试直接以字符串方式导入 markdown（Vite `?raw` 查询） */
declare module '*.md?raw' {
  const content: string
  export default content
}
