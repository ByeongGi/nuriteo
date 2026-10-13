import { valueB } from "./cycle-b.mjs";

export const valueA = "A";
export const fromB = () => valueB;
