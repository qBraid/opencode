import { test, expect } from "bun:test"
import { createIapFetch, createIapTokenProvider, fetchIapIdentityToken } from "../../src/provider/sdk/qbraid"

// A JWT-shaped token with the given exp (seconds since epoch). The signature is
// irrelevant here — only the exp claim is read.
function fakeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")
  return `${header}.${payload}.`
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

test("createIapFetch adds Proxy-Authorization without touching Authorization", async () => {
  const token = fakeJwt(nowSeconds() + 3600)
  let seen: Headers | undefined
  const baseFetch = async (_input: any, init?: RequestInit) => {
    seen = new Headers(init?.headers)
    return new Response("ok")
  }

  const iapFetch = createIapFetch(() => Promise.resolve(token), baseFetch as any)
  await iapFetch("https://account-v2-staging.qbraid.com/api/ai/v1/models", {
    headers: { Authorization: "Bearer qbr-at_xxx" },
  })

  expect(seen?.get("proxy-authorization")).toBe(`Bearer ${token}`)
  expect(seen?.get("authorization")).toBe("Bearer qbr-at_xxx")
})

test("token provider caches a valid token and single-flights concurrent calls", async () => {
  let calls = 0
  const token = fakeJwt(nowSeconds() + 3600)
  const provider = createIapTokenProvider("aud", async () => {
    calls++
    return token
  })

  const [a, b] = await Promise.all([provider(), provider()])
  expect(a).toBe(token)
  expect(b).toBe(token)

  // Cached and still valid — no additional metadata call.
  await provider()
  expect(calls).toBe(1)
})

test("token provider refetches once the cached token is within the refresh skew", async () => {
  let calls = 0
  const provider = createIapTokenProvider("aud", async () => {
    calls++
    // Already expired -> refreshAt is in the past -> always refetch.
    return fakeJwt(nowSeconds() - 3600)
  })

  await provider()
  await provider()
  expect(calls).toBe(2)
})

test("fetchIapIdentityToken fails fast with a descriptive error", async () => {
  const failing = async () => new Response("nope", { status: 500 })
  await expect(fetchIapIdentityToken("aud", failing as any)).rejects.toThrow(/qBraid IAP/)
})

test("fetchIapIdentityToken returns the trimmed token on success", async () => {
  const token = fakeJwt(nowSeconds() + 3600)
  const ok = async (_input: any, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google")
    return new Response(`${token}\n`)
  }
  expect(await fetchIapIdentityToken("aud", ok as any)).toBe(token)
})

test("fetchIapIdentityToken targets the DNS-free metadata IP, not the hostname", async () => {
  let requestedUrl: string | undefined
  const ok = async (input: any) => {
    requestedUrl = String(input)
    return new Response(fakeJwt(nowSeconds() + 3600))
  }
  await fetchIapIdentityToken("aud", ok as any)
  // Using the literal IP avoids Bun's DNS resolver stalling on
  // metadata.google.internal under the pod's ndots:5 search-domain expansion.
  expect(requestedUrl).toContain("169.254.169.254")
  expect(requestedUrl).not.toContain("metadata.google.internal")
})
