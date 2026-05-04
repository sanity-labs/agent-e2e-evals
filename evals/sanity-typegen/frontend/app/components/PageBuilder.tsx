'use client'

import {SanityDocument} from 'next-sanity'
import {useOptimistic} from 'next-sanity/hooks'

import BlockRenderer from '@/app/components/BlockRenderer'
import {dataAttr} from '@/sanity/lib/utils'

type PageBuilderPageProps = {
  page: any
}

type PageData = {
  _id: string
  _type: string
  pageBuilder?: any[]
}

/**
 * The PageBuilder component is used to render the blocks from the `pageBuilder` field in the Page type in your Sanity Studio.
 */

function RenderSections({
  pageBuilderSections,
  page,
}: {
  pageBuilderSections: any[]
  page: any
}) {
  if (!page) {
    return null
  }
  return (
    <div
      data-sanity={dataAttr({
        id: page._id,
        type: page._type,
        path: `pageBuilder`,
      }).toString()}
    >
      {pageBuilderSections.map((block: any, index: number) => (
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

function RenderEmptyState({page}: {page: any}) {
  if (!page) {
    return null
  }

  return (
    <div
      className="container mt-10"
      data-sanity={dataAttr({
        id: page._id,
        type: 'page',
        path: `pageBuilder`,
      }).toString()}
    >
      <div className="prose">
        <h2 className="">This page has no content!</h2>
        <p className="">Open the page in Sanity Studio to add content.</p>
      </div>
    </div>
  )
}

export default function PageBuilder({page}: PageBuilderPageProps) {
  const pageBuilderSections = useOptimistic<
    any[] | undefined,
    SanityDocument<PageData>
  >(page?.pageBuilder || [], (currentSections, action) => {
    // The action contains updated document data from Sanity
    // when someone makes an edit in the Studio

    // If the edit was to a different document, ignore it
    if (action.id !== page?._id) {
      return currentSections
    }

    // If there are sections in the updated document, use them
    if (action.document.pageBuilder) {
      // Reconcile References. https://www.sanity.io/docs/enabling-drag-and-drop#ffe728eea8c1
      return action.document.pageBuilder.map(
        (section) => currentSections?.find((s) => s._key === section?._key) || section,
      )
    }

    // Otherwise keep the current sections
    return currentSections
  })

  return pageBuilderSections && pageBuilderSections.length > 0 ? (
    <RenderSections pageBuilderSections={pageBuilderSections} page={page} />
  ) : (
    <RenderEmptyState page={page} />
  )
}
