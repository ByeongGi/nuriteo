const PUBLISHED_DATE_FORMAT = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric"
});

export function formatPublishedDate(value: string): string {
  return PUBLISHED_DATE_FORMAT.format(new Date(value));
}
