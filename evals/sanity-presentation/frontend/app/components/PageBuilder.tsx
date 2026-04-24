import BlockRenderer from '@/app/components/BlockRenderer'
import {GetPageQueryResult} from '@/sanity.types'
import {PageBuilderSection} from '@/sanity/lib/types'

type PageBuilderPageProps = {
  page: GetPageQueryResult
}

/**
 * The PageBuilder component is used to render the blocks from the `pageBuilder` field in the Page type in your Sanity Studio.
 */

function RenderSections({
  pageBuilderSections,
  page,
}: {
  pageBuilderSections: PageBuilderSection[]
  page: GetPageQueryResult
}) {
  if (!page) {
    return null
  }
  return (
    <div>
      {pageBuilderSections.map((block: PageBuilderSection, index: number) => (
        <BlockRenderer
          key={block._key}
          index={index}
          block={block}
          pageId={page._id}
          pageType={page._type}
        />
      ))}
    </div>
  )
}

function RenderEmptyState({page}: {page: GetPageQueryResult}) {
  if (!page) {
    return null
  }

  return (
    <div className="container mt-10">
      <div className="prose">
        <h2 className="">This page has no content!</h2>
        <p className="">Open the page in Sanity Studio to add content.</p>
      </div>
    </div>
  )
}

export default function PageBuilder({page}: PageBuilderPageProps) {
  const pageBuilderSections = page?.pageBuilder || []

  return pageBuilderSections && pageBuilderSections.length > 0 ? (
    <RenderSections pageBuilderSections={pageBuilderSections as PageBuilderSection[]} page={page} />
  ) : (
    <RenderEmptyState page={page} />
  )
}
