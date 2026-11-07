import { register } from "node:module";

/**
 * cindy-bridge 进程入口。
 *
 * 先注册 `*.md?raw` 装载器（vendor prompt 资源，node 原生不支持），
 * 再动态导入真正的 main——静态 import 会在 register 之前求值，
 * vendor 的 `.md?raw` 会先炸。
 */
register("./raw-loader.js", import.meta.url);

const { main } = await import("./bridge-main.js");
const code = await main();
process.exit(code);
