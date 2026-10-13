<script>
  import { label } from "./message.js";

  globalThis.__fixtureState ||= { count: 1 };
</script>

<div id="app">{label}:{globalThis.__fixtureState.count}</div>
