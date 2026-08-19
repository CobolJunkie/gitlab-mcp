// Intentionally circular dependency fixture.
// This module imports from circular-b, which imports back from circular-a.
import { b } from "./circular-b.mjs";

export const a = `a depends on ${b}`;
