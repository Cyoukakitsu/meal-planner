import { describe, expect, test } from "vitest";
import { isBentoDay } from "./bento";

describe("isBentoDay", () => {
  test("普通工作日是便当日", () => {
    expect(isBentoDay("2026-10-06")).toMatchObject({ is_bento_day: true }); // 周二
  });

  test("周末不是", () => {
    expect(isBentoDay("2026-10-10")).toMatchObject({ is_bento_day: false, reason: "周末" }); // 周六
  });

  test("工作日遇日本祝日不是", () => {
    expect(isBentoDay("2026-10-12")).toMatchObject({ is_bento_day: false, reason: "祝日：スポーツの日" }); // 周一
  });

  test("振替休日也算祝日", () => {
    expect(isBentoDay("2026-05-06").is_bento_day).toBe(false); // 周三，5/3 是周日
  });

  test("祝日表之外的年份直接报错，不静默当作工作日", () => {
    expect(() => isBentoDay("2028-01-04")).toThrow(/2028/);
  });
});
