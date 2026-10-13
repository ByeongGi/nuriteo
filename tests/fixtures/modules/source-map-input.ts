export type SourceRecord = {
  name: string;
  count: number;
};

export function describeSource(record: SourceRecord): string {
  return `${record.name}:${record.count}`;
}
