import { z } from "zod";

export const projectVersionNameSchema = z.string().max(200, "버전 이름은 200자 이하여야 합니다.");
