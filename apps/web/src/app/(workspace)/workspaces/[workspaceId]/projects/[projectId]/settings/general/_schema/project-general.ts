import { z } from "zod";

export const projectGeneralSchema = z.object({
  name: z.string().min(1, "프로젝트 이름을 입력하세요.").max(200, "프로젝트 이름은 200자 이하여야 합니다.")
});
