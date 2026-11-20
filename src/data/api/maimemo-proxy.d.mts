/** 墨墨本地代理的最小类型声明（避免测试依赖 @types/node：项目 tsconfig 只含 vite/client）。 */

export interface ProxyServerLike {
  listen(port: number, host: string, callback: () => void): void
  close(callback: () => void): void
  address(): unknown
  once(event: 'error', listener: (error: Error) => void): void
}

export interface ProxyOptions {
  upstream?: string
  fetchImpl?: typeof fetch
}

export function createProxyServer(options?: ProxyOptions): ProxyServerLike

export function startProxy(
  options?: ProxyOptions & { port?: number; host?: string },
): Promise<{ server: ProxyServerLike; port: number; host: string; url: string }>
