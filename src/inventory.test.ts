import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { addIngredients, consume, listInventory } from "./inventory";

const sql = postgres(process.env.TEST_DATABASE_URL ?? "postgres://postgres:dev@localhost:5433/postgres");
const today = "2026-10-06";

beforeEach(() => sql`TRUNCATE ingredient, meal, dish, dish_ingredient RESTART IDENTITY CASCADE`);
afterAll(() => sql.end());

const milk = { name: "牛奶", quantity: 2, unit: "盒", storage: "冷藏" as const, expiry: "2026-10-10" };

describe("addIngredients", () => {
  test("入库后能在库存里看到", async () => {
    await addIngredients(sql, [milk], today);
    const inv = await listInventory(sql, today);
    expect(inv.items).toHaveLength(1);
    expect(inv.items[0]).toMatchObject({ name: "牛奶", quantity: 2, unit: "盒", storage: "冷藏" });
  });

  test("顺带删除 15 天前用完的食材，保留更近的", async () => {
    await sql`INSERT INTO ingredient (name, quantity, unit, storage, expiry, used_up_at) VALUES
      ('旧', 0, '个', '冷藏', '2026-09-01', '2026-09-20'),
      ('新', 0, '个', '冷藏', '2026-09-30', '2026-09-30')`;
    await addIngredients(sql, [milk], today);
    const rows = await sql`SELECT name FROM ingredient ORDER BY id`;
    expect(rows.map((r) => r.name)).toEqual(["新", "牛奶"]);
  });

  test("顺带删除 15 天前已完成的餐，保留更近的", async () => {
    await sql`INSERT INTO meal (date, kind, is_bento, status, done_at) VALUES
      ('2026-09-20', '晚餐', false, '已完成', '2026-09-20'),
      ('2026-09-30', '晚餐', false, '已完成', '2026-09-30')`;
    await addIngredients(sql, [milk], today);
    const rows = await sql`SELECT date::text FROM meal`;
    expect(rows.map((r) => r.date)).toEqual(["2026-09-30"]);
  });
});

describe("listInventory", () => {
  test("已过期的标注过期天数，临近期限的单独列出", async () => {
    await addIngredients(sql, [
      { ...milk, name: "过期菜", expiry: "2026-10-04" },
      { ...milk, name: "明天到期", expiry: "2026-10-07" },
      { ...milk, name: "很久", expiry: "2026-10-20" },
    ], today);
    const inv = await listInventory(sql, today);
    expect(inv.items.find((i) => i.name === "过期菜")?.expired_days).toBe(2);
    expect(inv.expiring.map((i) => i.name)).toEqual(["明天到期"]);
  });

  test("不返回已用完的食材", async () => {
    await sql`INSERT INTO ingredient (name, quantity, unit, storage, expiry) VALUES ('空', 0, '个', '冷藏', '2026-10-20')`;
    expect((await listInventory(sql, today)).items).toEqual([]);
  });
});

describe("consume", () => {
  test("按最早到期扣减，扣到 0 的记录用完日期", async () => {
    await addIngredients(sql, [
      { ...milk, quantity: 1, expiry: "2026-10-08" },
      { ...milk, quantity: 3, expiry: "2026-10-12" },
    ], today);
    const r = await consume(sql, "牛奶", "盒", 2, today);
    expect(r.ok).toBe(true);
    const rows = await sql`SELECT quantity::float, used_up_at::text FROM ingredient ORDER BY expiry`;
    expect(rows).toEqual([
      { quantity: 0, used_up_at: today },
      { quantity: 2, used_up_at: null },
    ]);
  });

  test("拒绝时不改动库存", async () => {
    await addIngredients(sql, [milk], today);
    const r = await consume(sql, "牛奶", "盒", 10, today);
    expect(r.ok).toBe(false);
    const [row] = await sql`SELECT quantity::float FROM ingredient`;
    expect(row.quantity).toBe(2);
  });

  test("单位不同视为不同食材", async () => {
    await addIngredients(sql, [milk], today);
    expect((await consume(sql, "牛奶", "ml", 100, today)).ok).toBe(false);
  });
});
