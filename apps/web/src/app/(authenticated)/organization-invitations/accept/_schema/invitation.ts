import { z } from "zod";

export const invitationTokenSchema = z.object({
  token: z.string().trim().min(1, "초대 링크가 없거나 올바르지 않습니다.")
});
