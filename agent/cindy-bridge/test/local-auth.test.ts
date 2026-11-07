import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalAuthAdapter,
  isMagpieModelId,
  magpieApiKey,
  magpieBaseUrl,
  magpieReachable,
} from "../src/local-auth.js";
import type { Logger } from "../../../third-party/cindy-agent/maker-core/interfaces/logger.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as unknown as Logger;

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

function serveModels(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "auto/x", display_name: "X" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    });
  });
}

describe("magpie routing helpers", () => {
  it("wire ids contain a slash; bare aliases do not", () => {
    expect(isMagpieModelId("auto/gpt-6.1-sol")).toBe(true);
    expect(isMagpieModelId("devin/claude-sonnet-5-5")).toBe(true);
    expect(isMagpieModelId("sonnet")).toBe(false);
    expect(isMagpieModelId(undefined)).toBe(false);
  });

  it("base URL defaults to loopback, key defaults non-secret", () => {
    expect(magpieBaseUrl({})).toBe("http://127.0.0.1:3425");
    expect(magpieBaseUrl({ MAGPIE_BASE_URL: "http://gw:8080/" })).toBe("http://gw:8080/");
    expect(magpieApiKey({})).toBe("magpie-local");
    expect(magpieApiKey({ MAGPIE_API_KEY: "k" })).toBe("k");
  });

  it("reachability is the catalog answering", async () => {
    const base = await serveModels();
    expect(await magpieReachable(base, 3000)).toBe(true);
    expect(await magpieReachable("http://127.0.0.1:1", 500)).toBe(false);
  });
});

describe("magpie auth", () => {
  it("a wire-id model authenticates api-key when the gateway answers", async () => {
    const base = await serveModels();
    vi.stubEnv("MAGPIE_BASE_URL", base);
    const auth = createLocalAuthAdapter(logger);
    const state = await auth.getState({ model: "auto/x" });
    expect(state).toEqual({ authenticated: true, authSource: "api-key" });
    // env override weighs the same as the process env.
    expect(await auth.getAuthEnv({ model: "auto/x" })).toEqual({
      ANTHROPIC_API_KEY: "magpie-local",
    });
    vi.stubEnv("MAGPIE_API_KEY", "sekret");
    expect(await auth.getAuthEnv({ model: "auto/x" })).toEqual({ ANTHROPIC_API_KEY: "sekret" });
  });

  it("an unreachable gateway fails closed with the fix", async () => {
    vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:1");
    const auth = createLocalAuthAdapter(logger);
    const state = await auth.getState({ model: "auto/x" });
    expect(state.authenticated).toBe(false);
    expect(state.errorReason ?? "").toContain("magpie gateway unreachable");
  });

  it("bare aliases keep the legacy login check", async () => {
    vi.stubEnv("MAGPIE_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const auth = createLocalAuthAdapter(logger);
    const state = await auth.getState({ model: "sonnet" });
    expect(state.authSource).not.toBe("api-key");
    expect(await auth.getAuthEnv({ model: "sonnet" })).toEqual({});
  });
});
