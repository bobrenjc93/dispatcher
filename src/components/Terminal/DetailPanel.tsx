import { StatusDot } from "../common/StatusDot";
import { EditableText } from "../common/EditableText";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useFontStore } from "../../stores/useFontStore";

interface DetailPanelProps {
  terminalId: string;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  style?: React.CSSProperties;
}

export function DetailPanel({
  terminalId,
  onSplitHorizontal,
  onSplitVertical,
  style,
}: DetailPanelProps) {
  const session = useTerminalStore((s) => s.sessions[terminalId]);
  const updateTitle = useTerminalStore((s) => s.updateTitle);
  const updateNotes = useTerminalStore((s) => s.updateNotes);
  const fontSize = useFontStore((s) => s.fontSize);

  if (!session) return null;

  return (
    <div className="detail-panel" style={style}>
      <div className="detail-panel-header">
        <div className="detail-panel-title-row">
          <StatusDot terminalId={terminalId} />
          <EditableText
            value={session.title}
            onChange={(v) => updateTitle(terminalId, v)}
            className="detail-panel-title"
          />
        </div>
        <div className="detail-panel-actions">
          <button onClick={onSplitHorizontal} title="Split Right (⌘D)">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
          <button onClick={onSplitVertical} title="Split Down (⌘⇧D)">
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
