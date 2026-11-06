export type Cursor = { _id: string; publishedAt: string | null }
export type PageQuery = { query: string; params: Record<string, unknown> }

export function firstPage(): PageQuery {
  throw new Error('Not implemented')
}

export function nextPage(cursor: Cursor): PageQuery {
  throw new Error('Not implemented')
}
