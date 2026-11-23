import { describe, expect, it } from "vitest";
import { searchTabs, tabSearchEntries, type TabSearchEntry } from "../tabSearch";
import type { Project, TreeNode } from "../../types/project";
import type { TerminalSession } from "../../types/terminal";

function entry(terminalId: string, title: string, projectName = "Main"): TabSearchEntry {
  return { terminalId, projectId: projectName, title, projectName };
}

function titles(entries: TabSearchEntry[]) {
  return entries.map((e) => e.title);
}

describe("searchTabs", () => {
  const entries = [
    entry("1", "server logs", "api"),
    entry("2", "claude", "api"),
    entry("3", "dev-server", "web"),
    entry("4", "Server", "web"),
    entry("5", "notes", "web"),
  ];

  it("lists every tab, in sidebar order, before anything is typed", () => {
    expect(searchTabs(entries, "  ")).toBe(entries);
  });

  it("matches case-insensitively and puts a title that starts with the query first", () => {
    expect(titles(searchTabs(entries, "SERV"))).toEqual(["server logs", "Server", "dev-server"]);
  });

  it("needs every word, from the title or the project", () => {
    expect(titles(searchTabs(entries, "api logs"))).toEqual(["server logs"]);
    expect(titles(searchTabs(entries, "web"))).toEqual(["dev-server", "Server", "notes"]);
  });

  it("ranks a project-only match below any title match", () => {
    const withApiTitle = [...entries, entry("6", "api docs", "web")];
    expect(titles(searchTabs(withApiTitle, "api"))).toEqual(["api docs", "server logs", "claude"]);
  });

  it("finds nothing when a word appears nowhere", () => {
    expect(searchTabs(entries, "serv zzz")).toEqual([]);
  });
});

describe("tabSearchEntries", () => {
  it("includes tabs in collapsed projects and skips hidden ones", () => {
    const projects: Record<string, Project> = {
      p1: { id: "p1", name: "One", cwd: "/", rootGroupId: "r1", expanded: true },
      p2: { id: "p2", name: "Two", cwd: "/", rootGroupId: "r2", expanded: false },
    };
    const nodes: Record<string, TreeNode> = {
      r1: { id: "r1", type: "group", name: "", children: ["n1", "n2"], parentId: null },
      n1: { id: "n1", type: "terminal", name: "", terminalId: "t1", parentId: "r1" },
      n2: { id: "n2", type: "terminal", name: "", terminalId: "t2", parentId: "r1", hidden: true },
      r2: { id: "r2", type: "group", name: "", children: ["n3"], parentId: null },
      n3: { id: "n3", type: "terminal", name: "", terminalId: "t3", parentId: "r2" },
    };
    const sessions = {
      t1: { title: "shell" } as TerminalSession,
      t2: { title: "hidden" } as TerminalSession,
      t3: { title: "logs" } as TerminalSession,
    };

    expect(tabSearchEntries({ projects, projectOrder: ["p1", "p2"], nodes, sessions })).toEqual([
      { terminalId: "t1", projectId: "p1", title: "shell", projectName: "One" },
      { terminalId: "t3", projectId: "p2", title: "logs", projectName: "Two" },
    ]);
  });
});
