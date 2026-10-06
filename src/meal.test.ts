import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { addIngredients, listInventory } from "./inventory";
import { cancelMeal, getPlan, markDone, markPrepped, savePlan, type PlanMeal } from "./meal";

const sql = postgres(process.env.TEST_DATABASE_URL ?? "postgres://postgres:dev@localhost:5433/postgres");
const today = "2026-10-06";

beforeEach(async () => {
  await sql`TRUNCATE ingredient, meal, dish, dish_ingredient RESTART IDENTITY CASCADE`;
  await addIngredients(sql, [
    { name: "鸡蛋", quantity: 5, unit: "个", storage: "冷藏", expiry: "2026-10-12" },
    { name: "洋葱", quantity: 5, unit: "个", storage: "常温", expiry: "2026-10-20" },
  ], today);
});
afterAll(() => sql.end());

const ing = (name: string, quantity: number, unit = "个") => ({ name, quantity, unit });
const meal = (over: Partial<PlanMeal> = {}): PlanMeal => ({
  date: "2026-10-07",
  kind: "晚餐",
  is_bento: false,
  dishes: [{ name: "蛋炒饭", ingredients: [ing("鸡蛋", 2)] }],
  ...over,
});
const stock = async (name: string) => {
  const inv = await listInventory(sql, today);
  return inv.items.filter((i) => i.name === name).reduce((s, i) => s + i.quantity, 0);
};
const firstId = async () => (await getPlan(sql, today)).meals[0].id;
const statusOf = async (id: number) => (await sql`SELECT status FROM meal WHERE id = ${id}`)[0].status;

describe("savePlan / getPlan", () => {
  test("保存后能取回餐、料理和用量", async () => {
    expect(await savePlan(sql, [meal()])).toEqual({ ok: true });
    const { meals } = await getPlan(sql, today);
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({ date: "2026-10-07", kind: "晚餐", is_bento: false, status: "已计划" });
    expect(meals[0].dishes[0]).toMatchObject({ name: "蛋炒饭", ingredients: [ing("鸡蛋", 2)] });
  });

  test("同一天同一餐重排会替换已计划的", async () => {
    await savePlan(sql, [meal()]);
    await savePlan(sql, [meal({ dishes: [{ name: "煎蛋", ingredients: [ing("鸡蛋", 1)] }] })]);
    const { meals } = await getPlan(sql, today);
    expect(meals).toHaveLength(1);
    expect(meals[0].dishes.map((d) => d.name)).toEqual(["煎蛋"]);
  });

  test("已备菜的餐不能被覆盖，且整批都不保存", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true })]);
    await markPrepped(sql, await firstId(), today);
    const r = await savePlan(sql, [meal({ date: "2026-10-08" }), meal({ kind: "午餐", is_bento: true })]);
    expect(r.ok).toBe(false);
    expect((await getPlan(sql, today)).meals).toHaveLength(1);
  });

  test("晚餐不能是便当", async () => {
    expect((await savePlan(sql, [meal({ is_bento: true })])).ok).toBe(false);
  });

  test("getPlan 不含已完成和已取消的餐", async () => {
    await savePlan(sql, [meal(), meal({ date: "2026-10-08" })]);
    const [a, b] = (await getPlan(sql, today)).meals;
    await markDone(sql, a.id, today);
    await cancelMeal(sql, b.id);
    expect((await getPlan(sql, today)).meals).toEqual([]);
  });
});

describe("markPrepped", () => {
  test("便当备菜：扣库存，状态变已备菜", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true })]);
    const id = await firstId();
    expect(await markPrepped(sql, id, today)).toEqual({ ok: true, warnings: [] });
    expect(await stock("鸡蛋")).toBe(3);
    expect(await statusOf(id)).toBe("已备菜");
  });

  test("任一食材被拒绝则整餐回滚：库存和状态都不变", async () => {
    await savePlan(sql, [
      meal({
        kind: "午餐",
        is_bento: true,
        dishes: [{ name: "蛋炒洋葱", ingredients: [ing("鸡蛋", 2), ing("洋葱", 99)] }],
      }),
    ]);
    const id = await firstId();
    expect((await markPrepped(sql, id, today)).ok).toBe(false);
    expect(await stock("鸡蛋")).toBe(5);
    expect(await stock("洋葱")).toBe(5);
    expect(await statusOf(id)).toBe("已计划");
  });

  test("同一食材跨料理合计后再校验", async () => {
    await savePlan(sql, [
      meal({
        kind: "午餐",
        is_bento: true,
        dishes: [
          { name: "蛋羹", ingredients: [ing("鸡蛋", 4)] },
          { name: "煎蛋", ingredients: [ing("鸡蛋", 3)] },
        ],
      }),
    ]);
    expect((await markPrepped(sql, await firstId(), today)).ok).toBe(false);
    expect(await stock("鸡蛋")).toBe(5);
  });

  test("超出 20% 以内：扣到 0 并返回警告", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true, dishes: [{ name: "蛋", ingredients: [ing("鸡蛋", 6)] }] })]);
    const r = await markPrepped(sql, await firstId(), today);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toHaveLength(1);
    expect(await stock("鸡蛋")).toBe(0);
  });

  test("非便当的餐不能备菜", async () => {
    await savePlan(sql, [meal()]);
    expect((await markPrepped(sql, await firstId(), today)).ok).toBe(false);
  });

  test("重复备菜被拒绝，不会二次扣库存", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true })]);
    const id = await firstId();
    await markPrepped(sql, id, today);
    expect((await markPrepped(sql, id, today)).ok).toBe(false);
    expect(await stock("鸡蛋")).toBe(3);
  });

  test("餐不存在", async () => {
    expect((await markPrepped(sql, 999, today)).ok).toBe(false);
  });
});

describe("markDone", () => {
  test("晚餐完成：扣库存，记录完成日期", async () => {
    await savePlan(sql, [meal()]);
    const id = await firstId();
    expect((await markDone(sql, id, today)).ok).toBe(true);
    expect(await stock("鸡蛋")).toBe(3);
    const [row] = await sql`SELECT status, done_at::text FROM meal WHERE id = ${id}`;
    expect(row).toEqual({ status: "已完成", done_at: today });
  });

  test("在家做的午餐（非便当）与晚餐一样在完成时扣", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: false })]);
    await markDone(sql, await firstId(), today);
    expect(await stock("鸡蛋")).toBe(3);
  });

  test("便当完成：已在备菜时扣过，不再扣", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true })]);
    const id = await firstId();
    await markPrepped(sql, id, today);
    expect((await markDone(sql, id, today)).ok).toBe(true);
    expect(await stock("鸡蛋")).toBe(3);
    expect(await statusOf(id)).toBe("已完成");
  });

  test("便当没备菜不能直接完成", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true })]);
    const id = await firstId();
    expect((await markDone(sql, id, today)).ok).toBe(false);
    expect(await stock("鸡蛋")).toBe(5);
  });

  test("库存不足被拒绝时，状态不变", async () => {
    await savePlan(sql, [meal({ dishes: [{ name: "蛋", ingredients: [ing("鸡蛋", 99)] }] })]);
    const id = await firstId();
    expect((await markDone(sql, id, today)).ok).toBe(false);
    expect(await statusOf(id)).toBe("已计划");
  });

  test("已完成的餐不能再完成", async () => {
    await savePlan(sql, [meal()]);
    const id = await firstId();
    await markDone(sql, id, today);
    expect((await markDone(sql, id, today)).ok).toBe(false);
    expect(await stock("鸡蛋")).toBe(3);
  });
});

describe("cancelMeal", () => {
  test("取消不回滚库存", async () => {
    await savePlan(sql, [meal({ kind: "午餐", is_bento: true })]);
    const id = await firstId();
    await markPrepped(sql, id, today);
    expect((await cancelMeal(sql, id)).ok).toBe(true);
    expect(await stock("鸡蛋")).toBe(3);
    expect(await statusOf(id)).toBe("已取消");
  });

  test("已完成的餐不能取消", async () => {
    await savePlan(sql, [meal()]);
    const id = await firstId();
    await markDone(sql, id, today);
    expect((await cancelMeal(sql, id)).ok).toBe(false);
  });
});
