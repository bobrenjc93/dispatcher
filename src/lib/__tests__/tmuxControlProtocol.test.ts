import { describe, expect, it } from "vitest";
import {
  buildTmuxNewWindowCommand,
  buildTmuxPaneCaptureCommand,
  buildTmuxPaneCursorCommand,
  buildTmuxPaneSnapshotCommand,
  buildTmuxWindowSnapshotCommand,
  encodeTmuxSendKeysHex,
  normalizeTmuxPasteBufferText,
  parseTmuxPaneSnapshot,
  parseTmuxWindowSnapshot,
  quoteTmuxCommandArgument,
  selectTmuxWindowSnapshot,
  unescapeTmuxOutput,
} from "../tmuxControlProtocol";

describe("tmuxControlProtocol", () => {
  it("unescapes tmux octal output sequences", () => {
    expect(unescapeTmuxOutput("\\033[?2004hhello\\015\\012")).toBe("\u001b[?2004hhello\r\n");
  });

  it("decodes octal-escaped multibyte UTF-8 sequences as bytes, not code points", () => {
    // tmux escapes each raw byte separately: "é" = 0xC3 0xA9 = \303\251
    expect(unescapeTmuxOutput("\\303\\251")).toBe("é");
    // "中" = 0xE4 0xB8 0xAD, "😀" = 0xF0 0x9F 0x98 0x80
    expect(unescapeTmuxOutput("a\\344\\270\\255b\\360\\237\\230\\200c")).toBe("a中b😀c");
  });

  it("replaces octal-escaped invalid UTF-8 bytes instead of corrupting neighbors", () => {
    expect(unescapeTmuxOutput("Q\\377Z")).toBe("Q�Z");
  });

  it("leaves text without octal escapes untouched", () => {
    expect(unescapeTmuxOutput("plain text é😀 tail")).toBe("plain text é😀 tail");
    expect(unescapeTmuxOutput("not octal \\9 \\x41")).toBe("not octal \\9 \\x41");
  });

  it("does not treat a truncated trailing escape as octal", () => {
    expect(unescapeTmuxOutput("abc\\01")).toBe("abc\\01");
    expect(unescapeTmuxOutput("abc\\")).toBe("abc\\");
  });

  it("encodes input bytes into hex chunks for send-keys -H", () => {
    expect(encodeTmuxSendKeysHex("A€", 16)).toEqual(["41 e2 82 ac"]);
  });

  it("quotes tmux command arguments without allowing parser expansion", () => {
    expect(quoteTmuxCommandArgument('~/$HOME/"x"\\y\nz\r\t\u001b')).toBe(
      '"\\~/\\$HOME/\\"x\\"\\\\y\\nz\\r\\t\\e"'
    );
  });

  it("normalizes pasted text to tmux paste-buffer line endings", () => {
    expect(normalizeTmuxPasteBufferText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("parses tmux window snapshots", () => {
    expect(parseTmuxWindowSnapshot("@1\tshell\t1\t*")).toEqual({
      windowId: "@1",
      title: "shell",
      isActive: true,
      flags: "*",
    });
  });

  it("parses tmux pane snapshots", () => {
    expect(parseTmuxPaneSnapshot("@1\t%3\t0\t12\t80\t24\t0\t/tmp/project")).toEqual({
      windowId: "@1",
      paneId: "%3",
      left: 0,
      top: 12,
      width: 80,
      height: 24,
      isActive: false,
      cwd: "/tmp/project",
      cursorX: 0,
      cursorY: 0,
      alternateOn: false,
      historySize: 0,
    });
  });

  it("parses tmux pane snapshots with cursor and alternate-screen metadata", () => {
    expect(parseTmuxPaneSnapshot("@1\t%3\t0\t12\t80\t24\t1\t/tmp/project\t5\t9\t1\t123")).toEqual({
      windowId: "@1",
      paneId: "%3",
      left: 0,
      top: 12,
      width: 80,
      height: 24,
      isActive: true,
      cwd: "/tmp/project",
      cursorX: 5,
      cursorY: 9,
      alternateOn: true,
      historySize: 123,
    });
  });

  it("selects the requested tmux window snapshot when tmux returns multiple rows", () => {
    expect(selectTmuxWindowSnapshot([
      "@1\tbash\t0\t-",
      "@2\tbash\t1\t*",
    ], "@2")).toEqual({
      windowId: "@2",
      title: "bash",
      isActive: true,
      flags: "*",
    });
  });

  it("builds hydrate pane commands across all windows for attach flows", () => {
    expect(buildTmuxWindowSnapshotCommand()).toBe(
      'list-windows -F "#{window_id}\\t#{window_name}\\t#{window_active}\\t#{window_flags}"'
    );
    expect(buildTmuxWindowSnapshotCommand("@24")).toBe(
      'display-message -p -t @24 "#{window_id}\\t#{window_name}\\t#{window_active}\\t#{window_flags}"'
    );
    expect(buildTmuxPaneSnapshotCommand({ allWindows: true })).toBe(
      'list-panes -a -F "#{window_id}\\t#{pane_id}\\t#{pane_left}\\t#{pane_top}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{pane_current_path}\\t#{cursor_x}\\t#{cursor_y}\\t#{alternate_on}\\t#{history_size}"'
    );
    expect(buildTmuxPaneSnapshotCommand({ targetWindowId: "@24" })).toBe(
      'list-panes -t @24 -F "#{window_id}\\t#{pane_id}\\t#{pane_left}\\t#{pane_top}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{pane_current_path}\\t#{cursor_x}\\t#{cursor_y}\\t#{alternate_on}\\t#{history_size}"'
    );
    expect(buildTmuxPaneCursorCommand("%3")).toBe(
      'display-message -p -t %3 "#{cursor_x}\\t#{cursor_y}"'
    );
    expect(buildTmuxPaneCaptureCommand({ paneId: "%3" })).toBe("capture-pane -p -e -C -S -50000 -t %3");
    expect(buildTmuxPaneCaptureCommand({ paneId: "%3", historySize: 42 })).toBe(
      "capture-pane -p -e -C -S -42 -t %3"
    );
    expect(buildTmuxPaneCaptureCommand({ paneId: "%3", historySize: 0 })).toBe(
      "capture-pane -p -e -C -t %3"
    );
    expect(buildTmuxPaneCaptureCommand({ paneId: "%3", includeHistory: false })).toBe(
      "capture-pane -p -e -C -t %3"
    );
    expect(buildTmuxPaneCaptureCommand({ paneId: "%3", alternateScreen: true })).toBe(
      "capture-pane -p -e -C -a -q -t %3"
    );
  });

  it("builds new-window commands that preserve the current title", () => {
    expect(buildTmuxNewWindowCommand({
      targetWindowId: "@24",
      title: "Feature A",
      inheritCurrentPanePath: true,
    })).toBe('new-window -a -t @24 -n "Feature A" -c "#{pane_current_path}"');

    expect(buildTmuxNewWindowCommand({
      targetWindowId: "@24",
      title: "   ",
      inheritCurrentPanePath: false,
    })).toBe("new-window -a -t @24");
  });
});
