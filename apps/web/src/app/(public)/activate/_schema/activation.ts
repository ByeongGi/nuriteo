import { z } from "zod";

export const activationSchema = z.object({
  token: z.string().trim().min(1, "활성화 링크가 없거나 올바르지 않습니다."),
  email: z.string().trim().max(320).pipe(z.email("이메일을 입력하세요.")),
  displayName: z.string().trim().min(1, "표시 이름을 입력하세요.").max(200),
  password: z.string().min(1, "비밀번호를 입력하세요.")
});

export type ActivationValues = z.infer<typeof activationSchema>;
