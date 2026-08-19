// Intentionally circular dependency fixture (completes the cycle).
import { a } from "./circular-a.mjs";

export const b = `b depends on ${a}`;
