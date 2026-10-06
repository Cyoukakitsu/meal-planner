import type { Sql, TransactionSql } from "postgres";
import { deduct, type DeductResult } from "./deduct";

export type NewIngredient = {
  name: string;
  quantity: number;
  unit: string;
  storage: "冷藏" | "冷冻" | "常温";
  expiry: string;
};

const HISTORY_DAYS = 15;
const EXPIRING_DAYS = 2;

/** 入库，并顺带清理 15 天前的已完成餐和已用完食材（不用定时任务）。 */
export async function addIngredients(sql: Sql, items: NewIngredient[], today: string) {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM meal WHERE done_at < ${today}::date - ${HISTORY_DAYS}::int`;
    await tx`DELETE FROM ingredient WHERE used_up_at < ${today}::date - ${HISTORY_DAYS}::int`;
    for (const i of items) {
      await tx`INSERT INTO ingredient (name, quantity, unit, storage, expiry, bought_at)
               VALUES (${i.name}, ${i.quantity}, ${i.unit}, ${i.storage}, ${i.expiry}, ${today})`;
    }
  });
}

/** 库存（不含已用完）；已过期的带 expired_days，临近期限的另列在 expiring。 */
export async function listInventory(sql: Sql, today: string) {
  const items = await sql<
    { id: number; name: string; quantity: number; unit: string; storage: string; expiry: string; expired_days: number | null }[]
  >`SELECT id, name, quantity::float, unit, storage, expiry::text,
           CASE WHEN expiry < ${today}::date THEN (${today}::date - expiry) END AS expired_days
    FROM ingredient WHERE quantity > 0 ORDER BY expiry, id`;
  const expiring = items.filter(
    (i) => i.expired_days === null && i.expiry <= addDays(today, EXPIRING_DAYS),
  );
  return { items: [...items], expiring };
}

/** 按食材名和单位扣减库存，先扣最早到期；被拒绝时库存不变。可传入事务句柄，跟随外层事务回滚。 */
export async function consumeIn(tx: TransactionSql, name: string, unit: string, need: number, today: string): Promise<DeductResult> {
  const batches = await tx<{ id: number; quantity: number; expiry: string }[]>`
    SELECT id, quantity::float, expiry::text FROM ingredient
    WHERE name = ${name} AND unit = ${unit} AND quantity > 0 FOR UPDATE`;
  const r = deduct([...batches], need, today);
  if (!r.ok) return r;
  for (const u of r.updates) {
    await tx`UPDATE ingredient SET quantity = ${u.quantity},
             used_up_at = ${u.quantity === 0 ? today : null} WHERE id = ${u.id}`;
  }
  return r;
}

export const consume = (sql: Sql, name: string, unit: string, need: number, today: string) =>
  sql.begin((tx) => consumeIn(tx, name, unit, need, today));

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
