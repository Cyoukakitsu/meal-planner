import { describe, expect, test } from "vitest";
import { deduct, type Batch } from "./deduct";

const today = "2026-10-06";
const b = (id: number, quantity: number, expiry: string): Batch => ({ id, quantity, expiry });

describe("deduct", () => {
  test("先扣最早到期的批次", () => {
    const r = deduct([b(1, 3, "2026-10-12"), b(2, 3, "2026-10-08")], 4, today);
    expect(r).toEqual({ ok: true, updates: [{ id: 2, quantity: 0 }, { id: 1, quantity: 2 }], warning: null });
  });

  test("需求恰好等于库存：扣到 0，无警告", () => {
    const r = deduct([b(1, 5, "2026-10-08")], 5, today);
    expect(r).toEqual({ ok: true, updates: [{ id: 1, quantity: 0 }], warning: null });
  });

  test("超出库存 20% 以内：全部扣到 0 并警告", () => {
    const r = deduct([b(1, 5, "2026-10-08")], 6, today);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.updates).toEqual([{ id: 1, quantity: 0 }]);
      expect(r.warning).toContain("1");
    }
  });

  test("超出库存超过 20%：拒绝", () => {
    const r = deduct([b(1, 5, "2026-10-08")], 6.1, today);
    expect(r.ok).toBe(false);
  });

  test("已过期批次不参与扣减，也不计入库存", () => {
    const r = deduct([b(1, 5, "2026-10-05"), b(2, 2, "2026-10-08")], 3, today);
    // 可用库存只有 2，超出 50%，拒绝；过期批次保持不动
    expect(r.ok).toBe(false);
  });

  test("今天到期的批次仍可用", () => {
    const r = deduct([b(1, 2, "2026-10-06")], 1, today);
    expect(r).toEqual({ ok: true, updates: [{ id: 1, quantity: 1 }], warning: null });
  });

  test("已用完的批次（数量 0）被跳过", () => {
    const r = deduct([b(1, 0, "2026-10-07"), b(2, 2, "2026-10-09")], 1, today);
    expect(r).toEqual({ ok: true, updates: [{ id: 2, quantity: 1 }], warning: null });
  });

  test("没有任何可用库存：拒绝", () => {
    expect(deduct([], 1, today).ok).toBe(false);
  });
});
