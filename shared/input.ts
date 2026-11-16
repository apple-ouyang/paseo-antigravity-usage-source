import { z } from "zod";

/** The account is the local `agy` binary; that is all the fetch needs. */
export const inputSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export type AgyUsageInput = z.infer<typeof inputSchema>;
