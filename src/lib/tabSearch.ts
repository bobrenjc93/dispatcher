import type { Project, TreeNode } from "../types/project";
import type { TerminalSession } from "../types/terminal";
import { collectVisibleTerminalRefs } from "./treeUtils";

export interface TabSearchEntry {
  terminalId: string;
  projectId: string;
  title: string;
  projectName: string;
}

/**
 * Every tab, in sidebar order -- including the ones in collapsed projects,
 * which are the ones hardest to reach any other way.
 */
export function tabSearchEntries(args: {
  projects: Record<string, Project>;
  projectOrder: string[];
  nodes: Record<string, TreeNode>;
  sessions: Record<string, TerminalSession>;
}): TabSearchEntry[] {
  const { projects, projectOrder, nodes, sessions } = args;
  const ids = projectOrder.length > 0 ? projectOrder : Object.keys(projects);
  const entries: TabSearchEntry[] = [];
  for (const projectId of ids) {
    const project = projects[projectId];
    if (!project) {
      continue;
    }
    for (const ref of collectVisibleTerminalRefs(nodes, project.rootGroupId, sessions)) {
      entries.push({
        terminalId: ref.terminalId,
        projectId,
        title: sessions[ref.terminalId]?.title ?? "",
        projectName: project.name,
      });
    }
  }
  return entries;
}

/**
 * The tabs a query picks out, best first.
 *
 * Every word of the query has to appear somewhere in the tab's title or its
 * project's name, so "api logs" finds the "logs" tab in the "api" project.
 * Titles beat project names, and a title that starts with what was typed
 * beats one that merely contains it; ties keep sidebar order, so the list
 * does not reshuffle as a query narrows.
 */
export function searchTabs(entries: TabSearchEntry[], query: string): TabSearchEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return entries;
  }
  const phrase = words.join(" ");

  const ranked: Array<{ entry: TabSearchEntry; rank: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${entry.projectName.toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) {
      return;
    }
    let rank: number;
    if (title.startsWith(phrase)) {
      rank = 0;
    } else if (title.split(/[\s\-_/.:]+/).some((part) => part.startsWith(words[0]))) {
      rank = 1;
    } else if (title.includes(words[0])) {
      rank = 2;
    } else {
      rank = 3;
    }
    ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map(({ entry }) => entry);
}
