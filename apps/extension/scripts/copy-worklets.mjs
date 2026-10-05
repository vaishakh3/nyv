import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../node_modules/@nyv/audio/dist/worklets");
const dst = join(here, "../public/worklets");
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f));
