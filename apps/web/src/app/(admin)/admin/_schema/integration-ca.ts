import { z } from "zod";

const message = "CA 번들 또는 실제 연동 사전 점검이 거부되었습니다.";

export const integrationCaPemSchema = z.object({
  pem: z.string().min(1, message).max(1_048_576, message)
});
