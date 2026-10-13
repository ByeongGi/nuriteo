export type SetupDestination = "/setup" | "/sign-in";

export function setupDestination(bootstrapRequired: boolean): SetupDestination {
  return bootstrapRequired ? "/setup" : "/sign-in";
}
