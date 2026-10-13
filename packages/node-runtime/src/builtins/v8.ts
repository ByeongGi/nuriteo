export interface HeapStatistics {
  total_heap_size: number;
  total_heap_size_executable: number;
  total_physical_size: number;
  total_available_size: number;
  used_heap_size: number;
  heap_size_limit: number;
  malloced_memory: number;
  peak_malloced_memory: number;
  does_zap_garbage: 0 | 1;
  number_of_native_contexts: number;
  number_of_detached_contexts: number;
  total_global_handles_size: number;
  used_global_handles_size: number;
  external_memory: number;
}

export function getHeapStatistics(): HeapStatistics {
  return {
    total_heap_size: 0,
    total_heap_size_executable: 0,
    total_physical_size: 0,
    total_available_size: 256 * 1024 * 1024,
    used_heap_size: 0,
    heap_size_limit: 256 * 1024 * 1024,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0
  };
}

export function getHeapSpaceStatistics(): Array<Record<string, number | string>> {
  return [];
}

export const v8Builtin = Object.freeze({
  getHeapSpaceStatistics,
  getHeapStatistics
});
