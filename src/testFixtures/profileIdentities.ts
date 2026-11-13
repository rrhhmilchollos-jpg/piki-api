// Synthetic 1x1 color pixels, not portraits, IDs or production records.
export const PNG_PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOocJMDAAIWAN1gf9uuAAAAAElFTkSuQmCC";
export const WEBP_PHOTO = "data:image/webp;base64,UklGRjQAAABXRUJQVlA4ICgAAADQAQCdASoBAAEAAUAmJZgCdLoB+AADsAD+8dyP996A3k//bsFnLGAA";
export const JPEG_PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDj6KKK8Y9k/9k=";
export const ids = { customer: "64c000000000000000000001", employee: "64c000000000000000000002", tenant: "64c000000000000000000003", otherTenant: "64c000000000000000000004", rider: "64c000000000000000000005", order: "64c000000000000000000006", restaurant: "64c000000000000000000007" };
export function fixtureQuery(value: any, onSelect: (fields: string) => void = () => {}, onLimit: (size: number) => void = () => {}) {
  return { select(fields: string) { onSelect(fields); return this; }, limit(size: number) { onLimit(size); return this; }, lean() { return this; }, sort() { return this; }, exec: async () => value };
}
export function fixtureResponse(): any {
  return { code: 200, body: null, headers: {}, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; }, setHeader(key: string, value: string) { this.headers[key] = value; } };
}
