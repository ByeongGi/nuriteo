export class LivenessTracker {
  constructor() {
    this.refs = new Set();
    this.nextId = 1;
  }

  ref(label = "handle") {
    const id = this.nextId++;
    this.refs.add(id);
    return {
      id,
      label,
      ref: () => {
        this.refs.add(id);
        return this;
      },
      unref: () => {
        this.refs.delete(id);
        return this;
      },
      close: () => {
        this.refs.delete(id);
      }
    };
  }

  hasRefs() {
    return this.refs.size > 0;
  }
}
