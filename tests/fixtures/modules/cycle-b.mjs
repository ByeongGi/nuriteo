import { valueA } from "./cycle-a.mjs";

export const valueB = "B";
export const fromA = () => valueA;
