import { describe, it, expect } from "vitest";
import { useProjectStore } from "../useProjectStore";

function addTestProject(id: string) {
  useProjectStore.getState().addProject({
    id,
    name: `Project ${id}`,
    cwd: "/tmp",
    rootGroupId: `root-${id}`,
    expanded: true,
  });
}

describe("useProjectStore", () => {
  describe("addProject", () => {
    it("sets activeProjectId for first project only", () => {
      addTestProject("p1");
      expect(useProjectStore.getState().activeProjectId).toBe("p1");
      addTestProject("p2");
      expect(useProjectStore.getState().activeProjectId).toBe("p1");
    });

    it("appends to projectOrder", () => {
      addTestProject("p1");
      addTestProject("p2");
      addTestProject("p3");
      expect(useProjectStore.getState().projectOrder).toEqual(["p1", "p2", "p3"]);
    });
  });

  describe("removeProject", () => {
    it("falls back activeProjectId to next project", () => {
      addTestProject("p1");
      addTestProject("p2");
      useProjectStore.getState().setActiveProject("p1");
      useProjectStore.getState().removeProject("p1");
      expect(useProjectStore.getState().activeProjectId).toBe("p2");
    });

    it("sets activeProjectId to null when last", () => {
      addTestProject("p1");
      useProjectStore.getState().removeProject("p1");
      expect(useProjectStore.getState().activeProjectId).toBeNull();
    });
  });

  describe("reorderProject", () => {
    it("before target", () => {
      addTestProject("p1");
      addTestProject("p2");
      addTestProject("p3");
      useProjectStore.getState().reorderProject("p3", "p1", "before");
      expect(useProjectStore.getState().projectOrder).toEqual(["p3", "p1", "p2"]);
    });

    it("after target", () => {
      addTestProject("p1");
      addTestProject("p2");
      addTestProject("p3");
      useProjectStore.getState().reorderProject("p1", "p2", "after");
      expect(useProjectStore.getState().projectOrder).toEqual(["p2", "p1", "p3"]);
    });

    it("self → no-op", () => {
      addTestProject("p1");
      addTestProject("p2");
      useProjectStore.getState().reorderProject("p1", "p1", "before");
      expect(useProjectStore.getState().projectOrder).toEqual(["p1", "p2"]);
    });
  });

  describe("reorderChild", () => {
    it("before target", () => {
      const store = useProjectStore.getState();
      store.addNode({ id: "parent", type: "group", name: "G", children: ["c1", "c2", "c3"], parentId: null });
      store.reorderChild("parent", "c3", "c1", "before");
      expect(useProjectStore.getState().nodes["parent"].children).toEqual(["c3", "c1", "c2"]);
    });

    it("after last child", () => {
      const store = useProjectStore.getState();
      store.addNode({ id: "parent", type: "group", name: "G", children: ["c1", "c2", "c3"], parentId: null });
      store.reorderChild("parent", "c1", "c3", "after");
      expect(useProjectStore.getState().nodes["parent"].children).toEqual(["c2", "c3", "c1"]);
    });
  });

  describe("promoteChild", () => {
    it("moves a terminal node to first position under its parent", () => {
      const store = useProjectStore.getState();
      store.addNode({ id: "parent", type: "group", name: "G", children: ["n1", "n2", "n3"], parentId: null });
      store.addNode({ id: "n1", type: "terminal", name: "T1", terminalId: "t1", parentId: "parent" });
      store.addNode({ id: "n2", type: "terminal", name: "T2", terminalId: "t2", parentId: "parent" });
      store.addNode({ id: "n3", type: "terminal", name: "T3", terminalId: "t3", parentId: "parent" });

      store.promoteChild("t3");

      expect(useProjectStore.getState().nodes["parent"].children).toEqual(["n3", "n1", "n2"]);
    });

    it("is a no-op when terminal is already first", () => {
      const store = useProjectStore.getState();
      store.addNode({ id: "parent", type: "group", name: "G", children: ["n1", "n2"], parentId: null });
      store.addNode({ id: "n1", type: "terminal", name: "T1", terminalId: "t1", parentId: "parent" });
      store.addNode({ id: "n2", type: "terminal", name: "T2", terminalId: "t2", parentId: "parent" });

      store.promoteChild("t1");

      expect(useProjectStore.getState().nodes["parent"].children).toEqual(["n1", "n2"]);
    });
  });

  describe("moveNode", () => {
    it("updates both parents + node parentId", () => {
      const store = useProjectStore.getState();
      store.addNode({ id: "oldParent", type: "group", name: "Old", children: ["child1"], parentId: null });
      store.addNode({ id: "newParent", type: "group", name: "New", children: [], parentId: null });
      store.addNode({ id: "child1", type: "terminal", name: "T", parentId: "oldParent", terminalId: "t1" });

      store.moveNode("child1", "newParent");
      const nodes = useProjectStore.getState().nodes;
      expect(nodes["oldParent"].children).toEqual([]);
      expect(nodes["newParent"].children).toEqual(["child1"]);
      expect(nodes["child1"].parentId).toBe("newParent");
    });
  });

  describe("addChildToNode", () => {
    it("is idempotent", () => {
      const store = useProjectStore.getState();
      store.addNode({ id: "parent", type: "group", name: "G", children: [], parentId: null });
      store.addChildToNode("parent", "child1");
      store.addChildToNode("parent", "child1");
      expect(useProjectStore.getState().nodes["parent"].children).toEqual(["child1"]);
    });
  });

  describe("persist merge", () => {
    it("backfills projectOrder from project keys", () => {
      // Simulate old persisted data without projectOrder
      useProjectStore.setState(
        {
          projects: {
            a: { id: "a", name: "A", cwd: "/", rootGroupId: "r", expanded: true },
            b: { id: "b", name: "B", cwd: "/", rootGroupId: "r2", expanded: true },
          },
          nodes: {},
          activeProjectId: "a",
          projectOrder: [],
        },
        true as any
      );
      // Call the merge function manually
      const { merge } = (useProjectStore as any).persist.getOptions();
      const result = merge(
        { projects: { a: { id: "a", name: "A", cwd: "/", rootGroupId: "r", expanded: true } }, projectOrder: [] },
        useProjectStore.getState()
      );
      expect(result.projectOrder.length).toBeGreaterThan(0);
    });
  });
});
