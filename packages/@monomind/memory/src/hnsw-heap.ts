/**
 * V1 HNSW Vector Index — priority-queue heaps
 *
 * Split out of hnsw-index.ts (file-size sweep). Pure move: no behaviour change.
 *
 * @module v1/memory/hnsw-heap
 */

/**
 * Binary Min Heap for O(log n) priority queue operations
 * Used for candidate selection in HNSW search
 */
export class BinaryMinHeap<T> {
  private heap: Array<{ item: T; priority: number }> = [];

  get size(): number {
    return this.heap.length;
  }

  insert(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  extractMin(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0].item;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return min;
  }

  peek(): T | undefined {
    return this.heap[0]?.item;
  }

  peekPriority(): number | undefined {
    return this.heap[0]?.priority;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  toArray(): T[] {
    return this.heap
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => entry.item);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].priority <= this.heap[index].priority) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.heap[left].priority < this.heap[smallest].priority) {
        smallest = left;
      }
      if (right < length && this.heap[right].priority < this.heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.heap[smallest], this.heap[index]] = [this.heap[index], this.heap[smallest]];
      index = smallest;
    }
  }
}

/**
 * Binary Max Heap for bounded top-k tracking
 * Keeps track of k smallest elements by evicting largest when full
 */
export class BinaryMaxHeap<T> {
  private heap: Array<{ item: T; priority: number }> = [];
  private maxSize: number;

  constructor(maxSize: number = Infinity) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.heap.length;
  }

  insert(item: T, priority: number): boolean {
    // If at capacity and new item is worse than worst, reject
    if (this.heap.length >= this.maxSize && priority >= this.heap[0]?.priority) {
      return false;
    }

    if (this.heap.length >= this.maxSize) {
      // Replace max element
      this.heap[0] = { item, priority };
      this.bubbleDown(0);
    } else {
      this.heap.push({ item, priority });
      this.bubbleUp(this.heap.length - 1);
    }
    return true;
  }

  peekMax(): T | undefined {
    return this.heap[0]?.item;
  }

  peekMaxPriority(): number {
    return this.heap[0]?.priority ?? Infinity;
  }

  extractMax(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const max = this.heap[0].item;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return max;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  toSortedArray(): Array<{ item: T; priority: number }> {
    return this.heap.slice().sort((a, b) => a.priority - b.priority);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].priority >= this.heap[index].priority) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let largest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.heap[left].priority > this.heap[largest].priority) {
        largest = left;
      }
      if (right < length && this.heap[right].priority > this.heap[largest].priority) {
        largest = right;
      }
      if (largest === index) break;
      [this.heap[largest], this.heap[index]] = [this.heap[index], this.heap[largest]];
      index = largest;
    }
  }
}
