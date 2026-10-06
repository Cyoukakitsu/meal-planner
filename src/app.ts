import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { Sql } from "postgres";
import { createServer } from "./mcp";

export type Env = { MCP_TOKEN: string };

export function createApp(makeSql: (env: Env) => Sql, today: () => string) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => bearerAuth<{ Bindings: Env }>({ token: c.env.MCP_TOKEN })(c, next));

  // 无状态：每个请求一个 server 和 transport，库存状态都在数据库里
  app.all("/mcp", async (c) => {
    const sql = makeSql(c.env);
    const server = createServer(sql, today);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
