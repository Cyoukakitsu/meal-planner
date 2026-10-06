import { defineConfig } from "vitest/config";

// 测试共用一个数据库，文件间串行
export default defineConfig({ test: { fileParallelism: false } });
