export type Batch = { id: number; quantity: number; expiry: string }; // expiry: YYYY-MM-DD

export type DeductResult =
  | { ok: true; updates: { id: number; quantity: number }[]; warning: string | null }
  | { ok: false; error: string };

const OVERDRAW_LIMIT = 1.2;

/** 同一食材、同一单位的批次，先扣最早到期；已过期和已用完的批次不参与。 */
export function deduct(batches: Batch[], need: number, today: string): DeductResult {
  const usable = batches
    .filter((b) => b.quantity > 0 && b.expiry >= today)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  const total = usable.reduce((s, b) => s + b.quantity, 0);

  if (need > total * OVERDRAW_LIMIT) {
    return { ok: false, error: `库存不足：需要 ${need}，可用 ${total}（超出超过 20%）` };
  }

  let left = need;
  const updates = usable.flatMap((b) => {
    if (left <= 0) return [];
    const take = Math.min(b.quantity, left);
    left -= take;
    return [{ id: b.id, quantity: b.quantity - take }];
  });
  return { ok: true, updates, warning: left > 0 ? `库存不足，已扣到 0，缺 ${left}` : null };
}
