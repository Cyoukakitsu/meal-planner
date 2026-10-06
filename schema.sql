-- 库存：每次购买一条；数量为 0 即已用完
CREATE TABLE ingredient (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  quantity   NUMERIC NOT NULL CHECK (quantity >= 0),
  unit       TEXT NOT NULL,                       -- 文本，不换算
  storage    TEXT NOT NULL CHECK (storage IN ('冷藏', '冷冻', '常温')),
  expiry     DATE NOT NULL,                       -- 消费期限
  bought_at  DATE NOT NULL DEFAULT CURRENT_DATE,
  used_up_at DATE                                 -- 数量变 0 的日期，供 15 天清理
);

-- 计划中的每一餐；每天午餐和晚餐
CREATE TABLE meal (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('午餐', '晚餐')),
  is_bento   BOOLEAN NOT NULL,
  status     TEXT NOT NULL DEFAULT '已计划' CHECK (status IN ('已计划', '已备菜', '已完成', '已取消')),
  done_at    DATE,                                -- 完成日期，供 15 天清理
  UNIQUE (date, kind)
);

-- 一餐里的料理及其食材用量；扣库存时按这里的用量
CREATE TABLE dish (
  id       SERIAL PRIMARY KEY,
  meal_id  INT NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  recipe   TEXT
);

CREATE TABLE dish_ingredient (
  dish_id  INT NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit     TEXT NOT NULL
);

CREATE INDEX ON ingredient (name, unit) WHERE quantity > 0;
