import { z } from "zod";

const inviteRole = z.enum(["member", "owner"], "역할을 선택하세요.");

export const memberInviteSchema = z.object({
  email: z.string().min(1, "초대할 이메일을 입력하세요."),
  role: z.preprocess(
    (value) => value == null || value === "" ? "member" : value,
    inviteRole
  )
});
