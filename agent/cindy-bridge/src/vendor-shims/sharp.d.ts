/**
 * Bridge-owned ambient types for the optional `sharp` peer dep (spec B2).
 *
 * Vendor `agents/shared/image-resizer.ts` 用 `require('sharp')` 可选加载：
 * host 没装 sharp 时整体降级为 noop（注释原话“纯 type-check 跑测试”环境亦如此）。
 * bridge 包不装 sharp（native module，v0 只需缩图降级路径），
 * 这里只供给 tsc 最小链式形状；运行时 `loadSharp()` 照旧走 try/require 拿到 null。
 */
declare module "sharp" {
  interface SharpInstance {
    rotate(): SharpInstance;
    resize(options?: { width?: number; height?: number; fit?: string; withoutEnlargement?: boolean }): SharpInstance;
    webp(options?: { quality?: number }): SharpInstance;
    toBuffer(): Promise<Buffer>;
  }

  function sharp(input: string | Buffer, options?: Record<string, unknown>): SharpInstance;
  export default sharp;
}
