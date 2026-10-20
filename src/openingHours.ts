import { z } from "zod";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "La hora debe estar en formato HH:MM");

export const openingHourSlotSchema = z.object({
  open: timeSchema,
  close: timeSchema,
  closed: z.boolean().optional().default(false),
});

const splitOpeningDaySchema = z.object({
  morning: openingHourSlotSchema,
  evening: openingHourSlotSchema,
  closed: z.boolean(),
});

const legacySplitOpeningDaySchema = z.object({
  morning: openingHourSlotSchema,
  afternoon: openingHourSlotSchema,
  closed: z.boolean(),
}).transform(({ morning, afternoon, closed }) => ({ morning, evening: afternoon, closed }));

const legacyOpeningDaySchema = z.object({
  open: timeSchema,
  close: timeSchema,
  closed: z.boolean(),
}).transform(({ open, close, closed }) => ({
  morning: { open, close, closed: false },
  evening: { open, close, closed: false },
  closed,
}));

export const openingDaySchema = z.union([
  splitOpeningDaySchema,
  legacySplitOpeningDaySchema,
  legacyOpeningDaySchema,
]);

export const openingHoursSchema = z.record(z.string().min(2).max(15), openingDaySchema);
export type OpeningHours = z.infer<typeof openingHoursSchema>;
