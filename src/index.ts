import postgres from "postgres";
import { createApp, type Env } from "./app";

type Bindings = Env & { HYPERDRIVE: { connectionString: string } };

// 日本时间的今天（用户在日本，Workers 跑在 UTC）
const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

const app = createApp((env) => postgres((env as Bindings).HYPERDRIVE.connectionString, { max: 5, fetch_types: false }), jstToday);

export default app;
