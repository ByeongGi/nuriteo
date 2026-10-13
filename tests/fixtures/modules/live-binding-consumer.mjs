import * as counter from "./live-binding.mjs";

counter.increment();

export const observed = counter.count;
