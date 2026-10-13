const ModuleKind = Object.freeze({
  CommonJS: 1,
  ESNext: 99
});

const ScriptTarget = Object.freeze({
  ES2024: 11
});

const ImportsNotUsedAsValues = Object.freeze({
  Remove: 0
});

function transpileModule(source) {
  return {
    outputText: String(source),
    diagnostics: [],
    sourceMapText: ""
  };
}

const ts = Object.freeze({
  ImportsNotUsedAsValues,
  ModuleKind,
  ScriptTarget,
  transpileModule
});

export { ImportsNotUsedAsValues, ModuleKind, ScriptTarget, transpileModule };
export default ts;
