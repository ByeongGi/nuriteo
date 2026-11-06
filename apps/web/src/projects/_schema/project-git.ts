import { z } from "zod";

const tokenMessage = "개인 액세스 토큰을 입력하세요.";

export const gitConnectSchema = z.object({
  providerId: z.string().min(1, "제공자를 선택하세요."),
  token: z.string().min(1, tokenMessage).max(61_440, "개인 액세스 토큰은 61440자 이하여야 합니다.")
});

export const gitRotateTokenSchema = z.object({
  token: z.string().min(1, tokenMessage).max(61_440, "개인 액세스 토큰은 61440자 이하여야 합니다.")
});

export const gitImportSchema = z.object({
  repositoryUrl: z.string().min(1, "HTTPS 저장소 URL을 입력하세요."),
  branch: z.string().min(1, "브랜치를 입력하세요.").max(255, "브랜치는 255자 이하여야 합니다.")
});

export const gitCommitSchema = z.object({
  commitMessage: z.string().min(1, "커밋 메시지를 입력하세요.").max(10_240, "커밋 메시지는 10240자 이하여야 합니다.")
});
