import Link from "next/link"

export default function Home() {
  return (
    <main>
      <h1>My Blog</h1>
      <Link href="/posts">View Posts</Link>
    </main>
  )
}
