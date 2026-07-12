import { z } from "zod";

export const healthResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
