import type { ClientConfig } from "pg";
import { beforeAll, expect, test } from "vitest";
import { unstable_dev, UnstableDevWorker } from "wrangler";

let worker: UnstableDevWorker;

const CONFIGS = Object.freeze({
  local: {
    host: "localhost",
    user: "user",
    password: "password",
    database: "mydb",
  } satisfies ClientConfig,
  tls: process.env["DATABASE_TLS"]!,
  untrusted: process.env["DATABASE_UNTRUSTED"]!,
});

beforeAll(async () => {
  worker = await unstable_dev(`./test/worker.ts`, {
    experimental: { disableExperimentalWarning: true },
    logLevel: "info",
  });
  return () => worker.stop();
});

test("happy path", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify(CONFIGS.local),
  });
  expect(response.status).toBe(200);
});

test("tls happy path", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify(CONFIGS.tls),
  });
  expect(response.status).toBe(200);
});

test("bad username", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify({
      ...CONFIGS.local,
      user: "invalid",
    } satisfies ClientConfig),
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchInlineSnapshot(
    `
    {
      "message": "password authentication failed for user "invalid"",
      "name": "DatabaseError2",
    }
  `,
  );
});

test("bad password", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify({
      ...CONFIGS.local,
      password: "invalid",
    } satisfies ClientConfig),
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchInlineSnapshot(
    `
    {
      "message": "password authentication failed for user "user"",
      "name": "DatabaseError2",
    }
  `,
  );
});

test("unreachable host", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify({
      ...CONFIGS.local,
      host: "foobar.tylerbenfield.dev",
    } satisfies ClientConfig),
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchInlineSnapshot(
    `
    {
      "message": "proxy request failed, cannot connect to the specified address",
      "name": "Error",
    }
  `,
  );
});

test("terminated from server", async () => {
  const response = await worker.fetch("/terminate-backend", {
    method: "POST",
    body: JSON.stringify(CONFIGS.local),
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchInlineSnapshot(
    `
    {
      "message": "terminating connection due to administrator command",
      "name": "DatabaseError2",
    }
  `,
  );
});

test("host without TLS", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify({
      ...CONFIGS.local,
      ssl: true,
    } satisfies ClientConfig),
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchInlineSnapshot(
    `
    {
      "message": "The server does not support SSL connections",
      "name": "Error",
    }
  `,
  );
});

test("host with invalid TLS cert", async () => {
  const response = await worker.fetch("/", {
    method: "POST",
    body: JSON.stringify(CONFIGS.untrusted),
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchInlineSnapshot(
    `
    {
      "message": "Connection terminated unexpectedly",
      "name": "Error",
    }
  `,
  );
});
