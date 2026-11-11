import { HashRouter } from 'react-router-dom'
import { AppProviders } from './app/providers'
import { AppRoutes } from './app/router'

/**
 * App 只做三件事：挂 Provider、挂路由、留给 dev-ui 替换的空壳。
 * 业务页面全部在 src/ui/，由 dev-ui 按设计文档实现；本文件保持稳定。
 *
 * 路由使用 HashRouter：见 docs/ARCH.md「路由模式选型」。
 */
export default function App() {
  return (
    <AppProviders>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AppProviders>
  )
}
