import type { HostProcessTable } from "./spawn.ts";

export function teardownProcessTable(table: HostProcessTable): void {
  table.teardown();
}
