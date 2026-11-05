import { z } from "zod";

export const memberRoleSchema = z.object({
  role: z.enum(["member", "owner"], "역할을 선택하세요.")
});
