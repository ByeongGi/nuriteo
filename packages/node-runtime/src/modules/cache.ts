export class ModuleCache {
  constructor(options = {}) {
    this.cjs = new Map();
    this.esm = new Map();
    this.realpaths = new Map(Object.entries(options.realpaths || {}));
  }

  canonicalize(url) {
    return this.realpaths.get(url) || url;
  }
}
