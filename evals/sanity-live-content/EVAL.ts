import { readFileSync, existsSync } from "fs"
import { execSync } from "child_process"
import { test, expect } from "vitest"

function getLivePath(): string {
  if (existsSync("src/sanity/lib/live.ts")) return "src/sanity/lib/live.ts"
  if (existsSync("src/sanity/lib/live.tsx")) return "src/sanity/lib/live.tsx"
  return "src/sanity/lib/live.ts"
}

test("live content utility file exists", () => {
  expect(
    existsSync("src/sanity/lib/live.ts") ||
      existsSync("src/sanity/lib/live.tsx"),
  ).toBe(true)
})

test("live utility uses defineLive from next-sanity/live", () => {
  const content = readFileSync(getLivePath(), "utf-8")
  expect(content).toMatch(/defineLive/)
  expect(content).toMatch(/next-sanity\/live/)
})

test("live utility exports sanityFetch and SanityLive", () => {
  const content = readFileSync(getLivePath(), "utf-8")
  expect(content).toMatch(/sanityFetch/)
  expect(content).toMatch(/SanityLive/)
})

test("live utility configures a server token", () => {
  const content = readFileSync(getLivePath(), "utf-8")
  expect(content).toMatch(/serverToken/)
})

test("posts page uses sanityFetch instead of client.fetch", () => {
  const content = readFileSync("src/app/posts/page.tsx", "utf-8")
  expect(content).toMatch(/sanityFetch/)
  expect(content).not.toMatch(/client\.fetch/)
})

test("root layout includes SanityLive component", () => {
  const content = readFileSync("src/app/layout.tsx", "utf-8")
  expect(content).toMatch(/<SanityLive\s*\/?>/)
})

test("app builds successfully", () => {
  execSync("npm run build", { stdio: "pipe" })
})

