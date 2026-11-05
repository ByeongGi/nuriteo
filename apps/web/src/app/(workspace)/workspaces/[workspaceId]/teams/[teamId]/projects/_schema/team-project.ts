import { z } from "zod";

const projectRole = z.enum(["read", "write", "admin"], "프로젝트 역할을 선택하세요.");

export const teamProjectAddSchema = z.object({
  projectId: z.string().min(1, "프로젝트를 선택하세요."),
  role: z.preprocess(
    (value) => value == null || value === "" ? "read" : value,
    projectRole
  )
});

export const teamProjectRoleSchema = z.object({
  role: z.preprocess(
    (value) => value == null || value === "" ? "read" : value,
    projectRole
  )
});
