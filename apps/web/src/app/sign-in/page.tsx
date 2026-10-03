import { getCurrentUser } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import { SignInForm } from "./sign-in-form.tsx";
import { createServerApiClient } from "../../lib/api/server-client.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "../../lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "Sign in"
};

export default async function SignInPage() {
  try {
    const client = await createServerApiClient();
    await getCurrentUser(client);
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      return <SignInForm />;
    }

    return (
      <EntryUnavailable
        description="NURITEO could not verify your session. Retry when the Core service is available."
        reference={safeRequestReference(error)}
        retryHref="/sign-in"
        title="Sign-in is temporarily unavailable"
      />
    );
  }

  redirect("/workspaces");
}
