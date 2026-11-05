import { z } from "zod";

const emailMessage = "이메일을 입력하세요.";
const expirationMessage = "유효 기간을 선택하세요.";

export const activationInvitationSchema = z.object({
  email: z.string().max(320, emailMessage).pipe(z.email(emailMessage)),
  expiresInSeconds: z.union([
    z.literal(86400),
    z.literal(604800),
    z.literal(1209600),
    z.literal(2592000)
  ], { error: expirationMessage })
});
