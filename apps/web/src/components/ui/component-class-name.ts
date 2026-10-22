type StatefulClassName<State> = string | ((state: State) => string | undefined) | undefined;

function resolveComponentClassName<State>(
  className: StatefulClassName<State>,
  resolve: (override?: string) => string
): string | ((state: State) => string) {
  return typeof className === "function"
    ? (state) => resolve(className(state))
    : resolve(className);
}

export { resolveComponentClassName };
