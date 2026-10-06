import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Sql } from "postgres";
import { z } from "zod";
import { isBentoDay } from "./bento";
import { addIngredients, adjustIngredient, listInventory } from "./inventory";
import { cancelMeal, getPlan, markDone, markPrepped, savePlan } from "./meal";
import { PROFILE } from "./profile";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD");
const storage = z.enum(["冷藏", "冷冻", "常温"]);
const ingredientUse = z.object({ name: z.string(), quantity: z.number().positive(), unit: z.string() });

// 业务失败（{ ok: false }）和异常都以 isError 返回，让 Claude 看到原因
const reply = (data: unknown) => {
  const failed = typeof data === "object" && data !== null && "ok" in data && data.ok === false;
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(failed && { isError: true }) };
};
const guard = <A>(fn: (a: A) => unknown | Promise<unknown>) => async (a: A) => {
  try {
    return reply(await fn(a));
  } catch (e) {
    return reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

export function createServer(sql: Sql, today: () => string) {
  const s = new McpServer({ name: "meal-planner", version: "0.1.0" });

  s.registerTool(
    "add_ingredients",
    {
      description: "买完食材后入库，每次购买一条。消费期限由你估算（冷冻与冷藏不同），用户可修改。调味料不入库。",
      inputSchema: {
        items: z.array(z.object({
          name: z.string(), quantity: z.number().positive(), unit: z.string(), storage, expiry: date,
        })),
      },
    },
    guard(async ({ items }) => {
      await addIngredients(sql, items, today());
      return { ok: true, added: items.length };
    }),
  );

  s.registerTool(
    "list_inventory",
    { description: "当前库存。已过期的带 expired_days（不可用于计划），expiring 是 2 天内（含今天）到期的，请提醒用户。" },
    guard(() => listInventory(sql, today())),
  );

  s.registerTool(
    "list_expiring",
    { description: "临近期限（2 天内含今天）和已过期的食材。" },
    guard(async () => {
      const inv = await listInventory(sql, today());
      return { expiring: inv.expiring, expired: inv.items.filter((i) => i.expired_days !== null) };
    }),
  );

  s.registerTool(
    "adjust_ingredient",
    {
      description: "修改食材的数量、期限、存放方式；数量改 0 表示用完。remove 只能用于已过期食材，且必须先得到用户确认。",
      inputSchema: {
        id: z.number().int(),
        quantity: z.number().min(0).optional(),
        expiry: date.optional(),
        storage: storage.optional(),
        remove: z.boolean().optional(),
      },
    },
    guard(({ id, ...patch }) => adjustIngredient(sql, id, patch, today())),
  );

  s.registerTool(
    "save_plan",
    {
      description:
        "保存计划：每天午餐和晚餐。is_bento 请先用 is_bento_day 判断（晚餐一律 false）。每道料理列出食材用量，备菜或完成时按它扣库存。同一天同一餐重排会替换已计划的；已备菜、已完成的不能覆盖。",
      inputSchema: {
        meals: z.array(z.object({
          date,
          kind: z.enum(["午餐", "晚餐"]),
          is_bento: z.boolean(),
          dishes: z.array(z.object({ name: z.string(), recipe: z.string().optional(), ingredients: z.array(ingredientUse) })),
        })),
      },
    },
    guard(({ meals }) => savePlan(sql, meals)),
  );

  s.registerTool(
    "get_plan",
    { description: "未完成的餐（已计划、已备菜）及其料理用量，附带临近期限的食材。" },
    guard(() => getPlan(sql, today())),
  );

  const mealId = { meal_id: z.number().int() };

  s.registerTool(
    "mark_prepped",
    { description: "便当前一晚备菜完成，扣库存。任一食材被拒绝则整餐不扣、状态不变。", inputSchema: mealId },
    guard(({ meal_id }) => markPrepped(sql, meal_id, today())),
  );

  s.registerTool(
    "mark_done",
    { description: "这一餐吃完。便当须已备菜；晚餐和在家做的午餐在此扣库存。", inputSchema: mealId },
    guard(({ meal_id }) => markDone(sql, meal_id, today())),
  );

  s.registerTool(
    "cancel_meal",
    { description: "取消一餐，不回滚已扣的库存。", inputSchema: mealId },
    guard(({ meal_id }) => cancelMeal(sql, meal_id)),
  );

  s.registerTool(
    "is_bento_day",
    { description: "某天午餐是不是便当：周一到周五且非日本祝日。", inputSchema: { date } },
    guard(({ date }) => isBentoDay(date)),
  );

  s.registerTool("get_profile", { description: "个人档案：排计划前先读取。" }, guard(() => PROFILE));

  return s;
}
