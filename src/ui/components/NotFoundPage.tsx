import { Link } from 'react-router-dom'
import { EmptyState } from './EmptyState'

/** 404 页（路由兜底） */
export default function NotFoundPage() {
  return (
    <div className="mm-page">
      <EmptyState
        title="页面不存在"
        description="这个地址没有对应的页面，返回首页继续背单词吧。"
        action={
          <Link className="mm-btn mm-btn--primary" to="/">
            回首页
          </Link>
        }
      />
    </div>
  )
}
