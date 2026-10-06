import type { Sql, TransactionSql } from "postgres";
import { consumeIn, listInventory } from "./inventory";

export type PlanIngredient = { name: string; quantity: number; unit: string };
export type PlanDish = { name: string; recipe?: string; ingredients: PlanIngredient[] };
export type PlanMeal = { date: string; kind: "午餐" | "晚餐"; is_bento: boolean; dishes: PlanDish[] };

type Result = { ok: true } | { ok: false; error: string };
type DeductOutcome = { ok: true; warnings: string[] } | { ok: false; error: string };

// 事务内抛出以回滚整个事务，由 transact 转成 { ok: false }
class Rollback extends Error {}

async function transact<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return (await sql.begin(fn)) as T;
  } catch (e) {
    if (e instanceof Rollback) return { ok: false, error: e.message };
    throw e;
  }
}

/** 保存计划。同一天同一餐重排会替换已计划/已取消的；已备菜、已完成的不能覆盖，且整批不保存。 */
export function savePlan(sql: Sql, meals: PlanMeal[]) {
  return transact(sql, async (tx): Promise<Result> => {
    for (const m of meals) {
      if (m.kind === "晚餐" && m.is_bento) throw new Rollback(`${m.date} 晚餐不能是便当`);
      const [old] = await tx`SELECT status FROM meal WHERE date = ${m.date} AND kind = ${m.kind} FOR UPDATE`;
      if (old && (old.status === "已备菜" || old.status === "已完成")) {
        throw new Rollback(`${m.date} ${m.kind}已经${old.status}，不能覆盖`);
      }
      await tx`DELETE FROM meal WHERE date = ${m.date} AND kind = ${m.kind}`;
      const [{ id: mealId }] = await tx`
        INSERT INTO meal (date, kind, is_bento) VALUES (${m.date}, ${m.kind}, ${m.is_bento}) RETURNING id`;
      for (const d of m.dishes) {
        const [{ id: dishId }] = await tx`
          INSERT INTO dish (meal_id, name, recipe) VALUES (${mealId}, ${d.name}, ${d.recipe ?? null}) RETURNING id`;
        for (const i of d.ingredients) {
          await tx`INSERT INTO dish_ingredient (dish_id, name, quantity, unit)
                   VALUES (${dishId}, ${i.name}, ${i.quantity}, ${i.unit})`;
        }
      }
    }
    return { ok: true };
  });
}

/** 未完成、未取消的餐（含料理和用量），附带临近期限的食材。 */
export async function getPlan(sql: Sql, today: string) {
  const meals = await sql<{ id: number; date: string; kind: string; is_bento: boolean; status: string }[]>`
    SELECT id, date::text, kind, is_bento, status FROM meal
    WHERE status IN ('已计划', '已备菜')
    ORDER BY date, CASE kind WHEN '午餐' THEN 0 ELSE 1 END`;
  const dishes = await sql<{ id: number; meal_id: number; name: string; recipe: string | null }[]>`
    SELECT id, meal_id, name, recipe FROM dish ORDER BY id`;
  const ings = await sql<{ dish_id: number; name: string; quantity: number; unit: string }[]>`
    SELECT dish_id, name, quantity::float, unit FROM dish_ingredient`;
  return {
    meals: meals.map((m) => ({
      ...m,
      dishes: dishes
        .filter((d) => d.meal_id === m.id)
        .map((d) => ({
          name: d.name,
          recipe: d.recipe,
          ingredients: ings.filter((i) => i.dish_id === d.id).map(({ name, quantity, unit }) => ({ name, quantity, unit })),
        })),
    })),
    expiring: (await listInventory(sql, today)).expiring,
  };
}

/** 锁住这一餐并检查状态；不满足条件就回滚。 */
async function lockMeal(tx: TransactionSql, id: number, allowed: string[], what: string) {
  const [m] = await tx<{ id: number; is_bento: boolean; status: string }[]>`
    SELECT id, is_bento, status FROM meal WHERE id = ${id} FOR UPDATE`;
  if (!m) throw new Rollback(`餐 ${id} 不存在`);
  if (!allowed.includes(m.status)) throw new Rollback(`餐 ${id} 当前是${m.status}，不能${what}`);
  return m;
}

/** 按这一餐的用量扣库存；同一食材跨料理先合计。任一食材被拒绝就回滚整餐。 */
async function deductMeal(tx: TransactionSql, mealId: number, today: string): Promise<string[]> {
  const needs = await tx<{ name: string; unit: string; quantity: number }[]>`
    SELECT di.name, di.unit, SUM(di.quantity)::float AS quantity
    FROM dish_ingredient di JOIN dish d ON d.id = di.dish_id
    WHERE d.meal_id = ${mealId} GROUP BY di.name, di.unit`;
  const warnings: string[] = [];
  for (const n of needs) {
    const r = await consumeIn(tx, n.name, n.unit, n.quantity, today);
    if (!r.ok) throw new Rollback(`${n.name}：${r.error}`);
    if (r.warning) warnings.push(`${n.name}：${r.warning}`);
  }
  return warnings;
}

/** 便当备菜：扣库存，已计划 → 已备菜。 */
export function markPrepped(sql: Sql, id: number, today: string) {
  return transact(sql, async (tx): Promise<DeductOutcome> => {
    const m = await lockMeal(tx, id, ["已计划"], "备菜");
    if (!m.is_bento) throw new Rollback(`餐 ${id} 不是便当，没有备菜这一步`);
    const warnings = await deductMeal(tx, id, today);
    await tx`UPDATE meal SET status = '已备菜' WHERE id = ${id}`;
    return { ok: true, warnings };
  });
}

/** 完成：便当须已备菜（备菜时已扣过）；其余餐在这里扣库存。 */
export function markDone(sql: Sql, id: number, today: string) {
  return transact(sql, async (tx): Promise<DeductOutcome> => {
    const [peek] = await tx`SELECT is_bento FROM meal WHERE id = ${id}`;
    const m = await lockMeal(tx, id, [peek?.is_bento ? "已备菜" : "已计划"], "完成");
    const warnings = m.is_bento ? [] : await deductMeal(tx, id, today);
    await tx`UPDATE meal SET status = '已完成', done_at = ${today} WHERE id = ${id}`;
    return { ok: true, warnings };
  });
}

/** 取消：不回滚库存。 */
export function cancelMeal(sql: Sql, id: number) {
  return transact(sql, async (tx): Promise<Result> => {
    await lockMeal(tx, id, ["已计划", "已备菜"], "取消");
    await tx`UPDATE meal SET status = '已取消' WHERE id = ${id}`;
    return { ok: true };
  });
}
