import { z } from "zod";

export const teamSettingsSchema = z.object({
  displayName: z.string().min(1, "팀 이름을 입력하세요.").max(200, "팀 이름은 200자 이하여야 합니다.")
});
