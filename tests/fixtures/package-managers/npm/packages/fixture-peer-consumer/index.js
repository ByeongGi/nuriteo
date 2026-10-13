import { provider } from "fixture-peer-provider";

export function hello() {
  return `consumer:${provider()}`;
}
