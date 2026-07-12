import { hc } from "hono/client";
import type { AppType } from "@teach-everything/api";

export const api = hc<AppType>("/");
