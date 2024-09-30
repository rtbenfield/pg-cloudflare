import { Hono } from "hono";
import { Client, DatabaseError } from "pg";

const hono = new Hono();
export default hono;

hono.post("/", async (c) => {
  const body = await c.req.json();
  const client = new Client(body);
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    if (error instanceof DatabaseError) {
      return Response.json(
        { name: error.constructor.name, message: error.message },
        { status: 400 },
      );
    } else if (error instanceof Error) {
      return Response.json(
        { name: error.constructor.name, message: error.message },
        { status: 500 },
      );
    } else {
      throw error;
    }
  } finally {
    await client.end();
  }
  return Response.json({});
});

hono.post("/terminate-backend", async (c) => {
  const body = await c.req.json();
  const client = new Client(body);
  try {
    await client.connect();
    // kill the currently running connection 💥
    await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
  } catch (error) {
    if (error instanceof DatabaseError) {
      return Response.json(
        { name: error.constructor.name, message: error.message },
        { status: 400 },
      );
    } else if (error instanceof Error) {
      return Response.json(
        { name: error.constructor.name, message: error.message },
        { status: 500 },
      );
    } else {
      throw error;
    }
  } finally {
    await client.end();
  }
  return Response.json({});
});
