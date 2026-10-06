import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app";

const sql = postgres(process.env.TEST_DATABASE_URL ?? "postgres://postgres:dev@localhost:5433/postgres");
const app = createApp(() => sql, () => "2026-10-06");
const env = { MCP_TOKEN: "secret" };

beforeEach(() => sql`TRUNCATE ingredient, meal, dish, dish_ingredient RESTART IDENTITY CASCADE`);
afterAll(() => sql.end());

let rpcId = 0;
const post = (body: unknown, token: string | null = "secret") =>
  app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
const rpc = async (method: string, params?: unknown) =>
  (await (await post({ jsonrpc: "2.0", id: ++rpcId, method, params })).json()) as any;
const call = async (name: string, args: unknown = {}) => {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { isError: !!result.isError, data: JSON.parse(result.content[0].text) };
};

describe("认证", () => {
  test("没有密钥：401", async () => {
    expect((await post({}, null)).status).toBe(401);
  });
  test("密钥错误：401", async () => {
    expect((await post({}, "wrong")).status).toBe(401);
  });
});

describe("工具", () => {
  test("注册了设计里的 11 个工具", async () => {
    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [
        "add_ingredients", "list_inventory", "list_expiring", "adjust_ingredient", "save_plan", "get_plan",
        "mark_prepped", "mark_done", "cancel_meal", "is_bento_day", "get_profile",
      ].sort(),
    );
  });

  test("入库后能列出库存", async () => {
    const add = await call("add_ingredients", {
      items: [{ name: "鸡蛋", quantity: 5, unit: "个", storage: "冷藏", expiry: "2026-10-12" }],
    });
    expect(add.isError).toBe(false);
    const inv = await call("list_inventory");
    expect(inv.data.items[0]).toMatchObject({ name: "鸡蛋", quantity: 5 });
  });

  test("list_expiring 返回临近期限和已过期两类", async () => {
    await call("add_ingredients", {
      items: [
        { name: "过期菜", quantity: 1, unit: "把", storage: "冷藏", expiry: "2026-10-04" },
        { name: "明天到期", quantity: 1, unit: "把", storage: "冷藏", expiry: "2026-10-07" },
      ],
    });
    const r = await call("list_expiring");
    expect(r.data.expiring.map((i: any) => i.name)).toEqual(["明天到期"]);
    expect(r.data.expired.map((i: any) => i.name)).toEqual(["过期菜"]);
  });

  test("计划到完成走通，库存被扣", async () => {
    await call("add_ingredients", {
      items: [{ name: "鸡蛋", quantity: 5, unit: "个", storage: "冷藏", expiry: "2026-10-12" }],
    });
    await call("save_plan", {
      meals: [
        {
          date: "2026-10-06",
          kind: "晚餐",
          is_bento: false,
          dishes: [{ name: "蛋炒饭", ingredients: [{ name: "鸡蛋", quantity: 2, unit: "个" }] }],
        },
      ],
    });
    const { data: plan } = await call("get_plan");
    expect((await call("mark_done", { meal_id: plan.meals[0].id })).isError).toBe(false);
    expect((await call("list_inventory")).data.items[0].quantity).toBe(3);
  });

  test("业务失败返回 isError", async () => {
    expect((await call("mark_prepped", { meal_id: 999 })).isError).toBe(true);
  });

  test("is_bento_day 与 get_profile", async () => {
    expect((await call("is_bento_day", { date: "2026-10-12" })).data).toMatchObject({ is_bento_day: false });
    expect((await call("get_profile")).data.servings).toBe(1);
  });

  test("祝日表之外的年份返回 isError", async () => {
    expect((await call("is_bento_day", { date: "2030-01-01" })).isError).toBe(true);
  });
});
