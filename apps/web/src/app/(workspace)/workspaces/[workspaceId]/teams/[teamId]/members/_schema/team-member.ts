import { z } from "zod";

const teamRole = z.enum(["member", "maintainer"], "팀 역할을 선택하세요.");

export const teamMemberAddSchema = z.object({
  userId: z.string().min(1, "워크스페이스 멤버를 선택하세요."),
  role: z.preprocess(
    (value) => value == null || value === "" ? "member" : value,
    teamRole
  )
});

export const teamMemberRoleSchema = z.object({
  role: z.preprocess(
    (value) => value == null || value === "" ? "member" : value,
    teamRole
  )
});
