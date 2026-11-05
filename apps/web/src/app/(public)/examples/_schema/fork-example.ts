import { z } from "zod";

const forkInputError = "프로젝트 슬러그와 이름을 확인하고 다시 시도하세요.";

export const forkExampleSchema = z.object({
  slug: z.string(forkInputError).min(1, forkInputError).max(63, forkInputError).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, forkInputError),
  name: z.string(forkInputError).min(1, forkInputError).max(200, forkInputError)
});
