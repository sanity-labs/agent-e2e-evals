import { createClient } from "next-sanity"

import { dataset, projectId, apiVersion } from "../env"

export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
})
