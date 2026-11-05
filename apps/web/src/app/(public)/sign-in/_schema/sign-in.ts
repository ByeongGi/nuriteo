import { z } from "zod";

const signInInputError = "이메일과 비밀번호를 입력한 뒤 다시 시도하세요.";

export const signInSchema = z.object({
  email: z.string(signInInputError).min(1, signInInputError).max(320, signInInputError),
  password: z.string(signInInputError).min(1, signInInputError)
});
