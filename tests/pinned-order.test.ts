import { describe, expect, test } from "bun:test";
import {
  PINNED_DRAG_THRESHOLD_PX,
  pinnedDropTargetAt,
  readPinnedOrder,
  reorderPinned,
  sortByPinnedOrder,
} from "../src/pinnedOrder";

const items = (...ids: string[]) => ids.map(id => ({ id }));
const ids = (list: { id: string }[]) => list.map(item => item.id);

describe("sortByPinnedOrder", () => {
  test("follows the stored order", () => {
    expect(ids(sortByPinnedOrder(items("a", "b", "c"), ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });

  test("puts newly pinned projects first, not at the bottom", () => {
    // 방금 고정한 항목이 20개 아래로 묻히면 고정한 의미가 없다.
    expect(ids(sortByPinnedOrder(items("a", "new", "b"), ["a", "b"]))).toEqual(["new", "a", "b"]);
  });

  test("ignores ids that are no longer pinned", () => {
    expect(ids(sortByPinnedOrder(items("a", "b"), ["gone", "b", "a"]))).toEqual(["b", "a"]);
  });

  test("keeps the original relative order when nothing is stored", () => {
    expect(ids(sortByPinnedOrder(items("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
  });
});

describe("reorderPinned", () => {
  test("moves the dragged item into the target slot, downward", () => {
    expect(reorderPinned(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  test("moves the dragged item into the target slot, upward", () => {
    expect(reorderPinned(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  test("dropping onto itself changes nothing", () => {
    expect(reorderPinned(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });

  test("an unknown id leaves the order untouched", () => {
    expect(reorderPinned(["a", "b"], "ghost", "a")).toEqual(["a", "b"]);
  });
});

describe("pinnedDropTargetAt", () => {
  const rows = [
    { id: "a", top: 100, bottom: 138 },
    { id: "b", top: 138, bottom: 176 },
    { id: "c", top: 176, bottom: 214 },
  ];

  test("picks the row under the pointer", () => {
    expect(pinnedDropTargetAt(rows, 150)).toBe("b");
  });

  test("clamps above the first and below the last row", () => {
    // 목록 밖으로 끌어도 드롭이 무효가 되면 맨 위/맨 아래로 옮길 방법이 없다.
    expect(pinnedDropTargetAt(rows, 10)).toBe("a");
    expect(pinnedDropTargetAt(rows, 900)).toBe("c");
  });

  test("a row boundary belongs to the row that starts there", () => {
    expect(pinnedDropTargetAt(rows, 138)).toBe("b");
  });

  test("no rows means no target", () => {
    expect(pinnedDropTargetAt([], 120)).toBeNull();
  });

  test("the drag threshold stays large enough that a click is not a drag", () => {
    expect(PINNED_DRAG_THRESHOLD_PX).toBeGreaterThanOrEqual(3);
  });
});

describe("readPinnedOrder", () => {
  test("survives missing, malformed, and non-array storage", () => {
    expect(readPinnedOrder(null)).toEqual([]);
    expect(readPinnedOrder("{oops")).toEqual([]);
    expect(readPinnedOrder('{"a":1}')).toEqual([]);
  });

  test("drops non-strings and duplicates so ranks stay stable", () => {
    expect(readPinnedOrder('["a",1,"a","",null,"b"]')).toEqual(["a", "b"]);
  });
});
