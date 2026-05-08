import { describe, it, expect } from "vitest";
import { useTerminalStore } from "../useTerminalStore";

describe("useTerminalStore", () => {
  describe("addSession", () => {
    it("creates with correct defaults", () => {
      useTerminalStore.getState().addSession("t1", "My Term");
      const session = useTerminalStore.getState().sessions["t1"];
      expect(session.notes).toBe("");
      expect(session.hasDetectedActivity).toBe(false);
      expect(session.lastUserInputAt).toBe(0);
      expect(session.lastOutputAt).toBe(0);
      expect(session.isNeedsAttention).toBe(false);
      expect(session.isPossiblyDone).toBe(false);
      expect(session.isLongInactive).toBe(false);
      expect(session.isRecentlyFocused).toBe(false);
      expect(session.title).toBe("My Term");
    });

    it("auto-generates title when none provided", () => {
      useTerminalStore.getState().addSession("t1");
      const session = useTerminalStore.getState().sessions["t1"];
      expect(session.title).toMatch(/^Terminal \d+$/);
    });

    it("sets activeTerminalId", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().addSession("t2", "Second");
      expect(useTerminalStore.getState().activeTerminalId).toBe("t2");
    });

    it("keeps possibly-done state when activating a terminal", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setPossiblyDone("t1", true);
      useTerminalStore.getState().setActiveTerminal("t1");
      expect(useTerminalStore.getState().sessions["t1"].isPossiblyDone).toBe(true);
      expect(useTerminalStore.getState().sessions["t1"].isRecentlyFocused).toBe(true);
    });
  });

  describe("removeSession", () => {
    it("falls back activeTerminalId", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().addSession("t2", "Second");
      // t2 is active
      useTerminalStore.getState().removeSession("t2");
      expect(useTerminalStore.getState().activeTerminalId).toBe("t1");
    });

    it("of non-active preserves activeTerminalId", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().addSession("t2", "Second");
      // t2 is active; remove t1
      useTerminalStore.getState().removeSession("t1");
      expect(useTerminalStore.getState().activeTerminalId).toBe("t2");
    });
  });

  describe("updateCwd", () => {
    it("updates cwd for an existing session", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().updateCwd("t1", "/tmp/project");
      expect(useTerminalStore.getState().sessions["t1"].cwd).toBe("/tmp/project");
    });
  });

  describe("setPossiblyDone", () => {
    it("updates screenshot-derived terminal state", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setPossiblyDone("t1", true);
      expect(useTerminalStore.getState().sessions["t1"].isPossiblyDone).toBe(true);
    });
  });

  describe("setNeedsAttention", () => {
    it("updates screenshot-derived attention state", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setNeedsAttention("t1", true);
      expect(useTerminalStore.getState().sessions["t1"].isNeedsAttention).toBe(true);
    });
  });

  describe("setDetectedActivity", () => {
    it("updates screenshot-derived detected activity state", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setDetectedActivity("t1", true);
      expect(useTerminalStore.getState().sessions["t1"].hasDetectedActivity).toBe(true);
    });
  });

  describe("markTerminalActivity", () => {
    it("marks terminal as active and clears inactive state", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setNeedsAttention("t1", true);
      useTerminalStore.getState().setPossiblyDone("t1", true);
      useTerminalStore.getState().setLongInactive("t1", true);
      useTerminalStore.getState().markTerminalActivity("t1");
      const session = useTerminalStore.getState().sessions["t1"];
      expect(session.hasDetectedActivity).toBe(true);
      expect(session.lastUserInputAt).toBeGreaterThan(0);
      expect(session.isNeedsAttention).toBe(false);
      expect(session.isPossiblyDone).toBe(false);
      expect(session.isLongInactive).toBe(false);
    });
  });

  describe("markTerminalOutput", () => {
    it("records output activity without clearing attention or done state", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setNeedsAttention("t1", true);
      useTerminalStore.getState().setPossiblyDone("t1", true);
      useTerminalStore.getState().setLongInactive("t1", true);
      useTerminalStore.getState().markTerminalOutput("t1");
      const session = useTerminalStore.getState().sessions["t1"];
      expect(session.hasDetectedActivity).toBe(true);
      expect(session.lastOutputAt).toBeGreaterThan(0);
      expect(session.isNeedsAttention).toBe(true);
      expect(session.isPossiblyDone).toBe(true);
      expect(session.isLongInactive).toBe(false);
    });
  });

  describe("setActiveTerminal", () => {
    it("acknowledges pulsing attention without marking the terminal done", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setNeedsAttention("t1", true);
      useTerminalStore.getState().setActiveTerminal("t1");
      const session = useTerminalStore.getState().sessions["t1"];
      expect(session.isNeedsAttention).toBe(false);
      expect(session.isPossiblyDone).toBe(false);
    });
  });

  describe("setLongInactive", () => {
    it("updates long inactivity state", () => {
      useTerminalStore.getState().addSession("t1", "First");
      useTerminalStore.getState().setLongInactive("t1", true);
      expect(useTerminalStore.getState().sessions["t1"].isLongInactive).toBe(true);
    });
  });

  describe("persist merge", () => {
    it("preserves notes and resets runtime screenshot state", () => {
      const { merge } = (useTerminalStore as any).persist.getOptions();
      const persisted = {
        sessions: {
          t1: { id: "t1", title: "T1", notes: "hello", hasDetectedActivity: true, lastUserInputAt: 123, lastOutputAt: 321, isNeedsAttention: true, isPossiblyDone: true, isLongInactive: true, isRecentlyFocused: true },
          t2: { id: "t2", title: "T2", notes: "", hasDetectedActivity: true, lastUserInputAt: 456, lastOutputAt: 654, isNeedsAttention: true, isPossiblyDone: true, isLongInactive: true, isRecentlyFocused: true },
        },
        activeTerminalId: "t1",
      };
      const result = merge(persisted, { sessions: {}, activeTerminalId: null });
      expect(result.sessions["t1"].notes).toBe("hello");
      expect(result.sessions["t2"].notes).toBe("");
      expect(result.sessions["t1"].hasDetectedActivity).toBe(false);
      expect(result.sessions["t2"].hasDetectedActivity).toBe(false);
      expect(result.sessions["t1"].lastUserInputAt).toBe(0);
      expect(result.sessions["t2"].lastUserInputAt).toBe(0);
      expect(result.sessions["t1"].lastOutputAt).toBe(0);
      expect(result.sessions["t2"].lastOutputAt).toBe(0);
      expect(result.sessions["t1"].isNeedsAttention).toBe(false);
      expect(result.sessions["t2"].isNeedsAttention).toBe(false);
      expect(result.sessions["t1"].isPossiblyDone).toBe(false);
      expect(result.sessions["t2"].isPossiblyDone).toBe(false);
      expect(result.sessions["t1"].isLongInactive).toBe(false);
      expect(result.sessions["t2"].isLongInactive).toBe(false);
      expect(result.sessions["t1"].isRecentlyFocused).toBe(false);
      expect(result.sessions["t2"].isRecentlyFocused).toBe(false);
    });

    it("marks restored tmux sessions for startup normalization while clearing live tmux state", () => {
      const { merge } = (useTerminalStore as any).persist.getOptions();
      const persisted = {
        sessions: {
          transport: {
            id: "transport",
            title: "Shell",
            notes: "",
            hasDetectedActivity: false,
            lastUserInputAt: 0,
            lastOutputAt: 0,
            isNeedsAttention: false,
            isPossiblyDone: false,
            isLongInactive: false,
            isRecentlyFocused: false,
            backendKind: "tmux-transport",
            tmuxControlSessionId: "transport",
          },
          window: {
            id: "window",
            title: "tmux",
            notes: "",
            hasDetectedActivity: false,
            lastUserInputAt: 0,
            lastOutputAt: 0,
            isNeedsAttention: false,
            isPossiblyDone: false,
            isLongInactive: false,
            isRecentlyFocused: false,
            backendKind: "tmux-window",
            tmuxControlSessionId: "transport",
            tmuxWindowId: "@1",
          },
          pane: {
            id: "pane",
            title: "tmux",
            notes: "",
            hasDetectedActivity: false,
            lastUserInputAt: 0,
            lastOutputAt: 0,
            isNeedsAttention: false,
            isPossiblyDone: false,
            isLongInactive: false,
            isRecentlyFocused: false,
            backendKind: "tmux-pane",
            tmuxControlSessionId: "transport",
            tmuxWindowId: "@1",
            tmuxPaneId: "%1",
          },
        },
        activeTerminalId: "pane",
      };

      const result = merge(persisted, { sessions: {}, activeTerminalId: null });
      expect(result.sessions.transport).toBeUndefined();
      expect(result.sessions.window).toBeDefined();
      expect(result.sessions.window.backendKind).toBe("tmux-window");
      expect(result.sessions.window.restoredFromBackendKind).toBe("tmux-window");
      expect(result.sessions.window.tmuxControlSessionId).toBeUndefined();
      expect(result.sessions.window.tmuxWindowId).toBe("@1");
      expect(result.sessions.pane).toBeDefined();
      expect(result.sessions.pane.backendKind).toBe("tmux-pane");
      expect(result.sessions.pane.restoredFromBackendKind).toBe("tmux-pane");
      expect(result.sessions.pane.tmuxControlSessionId).toBeUndefined();
      expect(result.sessions.pane.tmuxWindowId).toBe("@1");
      expect(result.sessions.pane.tmuxPaneId).toBe("%1");
      expect(result.activeTerminalId).toBe("pane");
    });
  });
});
