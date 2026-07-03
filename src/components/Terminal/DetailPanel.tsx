import { StatusDot } from "../common/StatusDot";
import { EditableText } from "../common/EditableText";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useFontStore } from "../../stores/useFontStore";
import { isDisconnectedTmuxPlaceholderTerminal, renameTmuxTerminal } from "../../lib/tmuxControl";

interface DetailPanelProps {
  terminalId: string;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onCollapse?: () => void;
  style?: React.CSSProperties;
}

export function DetailPanel({
  terminalId,
  onSplitHorizontal,
  onSplitVertical,
  onCollapse,
  style,
}: DetailPanelProps) {
  const session = useTerminalStore((s) => s.sessions[terminalId]);
  const updateTitle = useTerminalStore((s) => s.updateTitle);
  const updateNotes = useTerminalStore((s) => s.updateNotes);
  const fontSize = useFontStore((s) => s.fontSize);

  if (!session) return null;

  const splitDisabled = isDisconnectedTmuxPlaceholderTerminal(terminalId);
  const splitDisabledTitle = splitDisabled
    ? "Reconnect with tmux -CC a before splitting this tab"
    : undefined;

  return (
    <div className="detail-panel" style={style}>
      <div className="detail-panel-header">
        <div className="detail-panel-title-row">
          <StatusDot terminalId={terminalId} />
          <EditableText
            value={session.title}
            onChange={(v) => {
              void renameTmuxTerminal(terminalId, v)
                .then((handled) => {
                  if (!handled) {
                    updateTitle(terminalId, v);
                  }
                })
                .catch(() => {
                  updateTitle(terminalId, v);
                });
            }}
            className="detail-panel-title"
          />
        </div>
        <div className="detail-panel-actions">
          {onCollapse && (
            <button onClick={onCollapse} title="Collapse Notes Panel">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M9 3L5 7L9 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          <button
            onClick={onSplitHorizontal}
            title={splitDisabledTitle ?? "Split Right (⌘D)"}
            disabled={splitDisabled}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
          <button
            onClick={onSplitVertical}
            title={splitDisabledTitle ?? "Split Down (⌘⇧D)"}
            disabled={splitDisabled}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="detail-panel-section detail-panel-notes-section">
        <label className="detail-panel-label">Notes</label>
        <textarea
          className="detail-panel-notes"
          style={{ fontSize }}
          value={session.notes}
          placeholder="Write notes about this terminal..."
          onChange={(e) => updateNotes(terminalId, e.target.value)}
          onKeyDown={(e) => {
            // Let tab-cycling shortcuts (Cmd+Shift+[/]) bubble to the global handler
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
              return;
            }
            e.stopPropagation();
          }}
        />
      </div>
    </div>
  );
}
