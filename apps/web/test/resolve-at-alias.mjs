export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
  }
  return nextResolve(specifier, context);
}
