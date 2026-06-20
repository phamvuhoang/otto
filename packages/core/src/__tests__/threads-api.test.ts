import { describe, expect, it, vi } from "vitest";
import {
  createThreadsClient,
  resolveThreadsAuth,
} from "../threads-api.js";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

describe("resolveThreadsAuth", () => {
  const deps = (env: Record<string, string>, file: string | null = null) => ({
    env: env as NodeJS.ProcessEnv,
    readFile: () => file,
    home: "/home/x",
  });
  it("reads env token + user id", () => {
    expect(
      resolveThreadsAuth(
        deps({ OTTO_THREADS_TOKEN: "t", OTTO_THREADS_USER_ID: "u" })
      )
    ).toMatchObject({ token: "t", userId: "u" });
  });
  it("falls back to the config file", () => {
    expect(
      resolveThreadsAuth(deps({}, JSON.stringify({ token: "ft", userId: "fu" })))
    ).toMatchObject({ token: "ft", userId: "fu" });
  });
  it("returns null when nothing is set", () => {
    expect(resolveThreadsAuth(deps({}))).toBeNull();
  });
  it("returns null when only one of token/userId is present", () => {
    expect(resolveThreadsAuth(deps({ OTTO_THREADS_TOKEN: "t" }))).toBeNull();
  });
});

describe("createThreadsClient.publish", () => {
  it("does the two-step create then publish and returns the post id", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("threads_publish")) return okJson({ id: "post-9" });
      return okJson({ id: "creation-1" });
    }) as unknown as typeof fetch;
    const client = createThreadsClient({
      token: "tok",
      userId: "u1",
      fetch: fetchImpl,
    });
    const res = await client.publish("hello world");
    expect(res).toEqual({ id: "post-9" });
    expect(calls[0]).toContain("/u1/threads");
    expect(calls[0]).toContain("text=hello");
    expect(calls[1]).toContain("/u1/threads_publish");
    expect(calls[1]).toContain("creation_id=creation-1");
  });
  it("classifies a non-ok response as an api error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: false, status: 400, json: async () => ({ error: "bad" }) }) as Response
    ) as unknown as typeof fetch;
    const client = createThreadsClient({
      token: "tok",
      userId: "u1",
      fetch: fetchImpl,
    });
    await expect(client.publish("x".repeat(30))).rejects.toMatchObject({
      kind: "api",
    });
  });
  it("classifies a fetch throw as a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const client = createThreadsClient({
      token: "tok",
      userId: "u1",
      fetch: fetchImpl,
    });
    await expect(client.publish("x".repeat(30))).rejects.toMatchObject({
      kind: "network",
    });
  });
});
