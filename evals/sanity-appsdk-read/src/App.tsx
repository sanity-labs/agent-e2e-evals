import {SanityApp, type SanityConfig} from '@sanity/sdk-react'
import PostList from './PostList'

const config: SanityConfig[] = [{projectId: 'your-project-id', dataset: 'production'}]

export function App() {
  return (
    <SanityApp config={config} fallback={<p>Loading…</p>}>
      <PostList />
    </SanityApp>
  )
}
