import { z } from "zod";

export const teamCreateSchema = z.object({
  slug: z.string().min(1, "팀 주소를 입력하세요.").max(63, "팀 주소는 63자 이하여야 합니다."),
  displayName: z.string().min(1, "팀 이름을 입력하세요.").max(200, "팀 이름은 200자 이하여야 합니다.")
});
