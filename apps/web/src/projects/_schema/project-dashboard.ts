import { z } from "zod";

const projectSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const createProjectFormSchema = z.object({
  name: z.string().min(1, "프로젝트 이름을 입력하세요.").max(200, "프로젝트 이름은 200자 이하여야 합니다."),
  slug: z.string()
    .min(1, "슬러그를 입력하세요.")
    .max(63, "슬러그는 63자 이하여야 합니다.")
    .regex(projectSlugPattern, "슬러그는 소문자, 숫자, 하이픈만 사용할 수 있습니다.")
});

export const renameProjectFormSchema = z.object({
  name: z.string().min(1, "프로젝트 이름을 입력하세요.").max(200, "프로젝트 이름은 200자 이하여야 합니다.")
});

export const projectRoleGrantSchema = z.object({
  userId: z.string().min(1, "조직 멤버를 선택하세요."),
  role: z.enum(["read", "write", "admin"], "프로젝트 역할을 선택하세요.")
});
