import { fromB, valueA } from "./cycle-a.mjs";
import { fromA, valueB } from "./cycle-b.mjs";

export const result = `${valueA}${valueB}:${fromA()}${fromB()}`;
