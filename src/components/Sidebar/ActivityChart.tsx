import { useEffect, useMemo, useState } from "react";
import {
  ACTIVITY_HISTORY_WINDOW_MS,
  getActivityHistoryStartedAt,
  replayInactivity,
  type ActivityEvent,
  type ActivityHistory,
  type ActivitySample,
} from "../../lib/activityHistory";
import { formatInactivityChangePercent } from "../../lib/inactivityThreshold";
import { builtInChangePercent } from "../../lib/viewportSignature";

/**
 * A tab's recent output, drawn against the setting being edited.
 *
 * One bar per time its output was judged, as tall as the share of the screen
 * it changed; the dashed line is the threshold, and the shaded stretches are
 * when the tab would have counted as inactive, each led by a hatched one the
 * length of the duration -- the quiet it had to sit through first, which is
 * how the duration shows up on the chart. All of it is replayed against
 * the numbers in the dialog as they are typed, so "would 5% for a minute have
 * stopped those false alarms?" is answered by looking rather than by waiting
 * a day to find out.
 */

const GREEN = "#00c853";
const BROWN = "#8b6b3f";
const GRAY = "#7b8794";
const AMBER = "#d29922";
const BLUE = "#58a6ff";

const WIDTH = 528;
const HEIGHT = 168;
const MARGIN = { left: 40, right: 10, top: 16, bottom: 20 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

const RANGES = [
  { label: "2m", ms: 2 * 60_000 },
  { label: "10m", ms: 10 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "2h", ms: 2 * 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
  { label: "24h", ms: ACTIVITY_HISTORY_WINDOW_MS },
] as const;

/**
 * The view that shows the setting: ten minutes, or the shortest range with
 * room for the duration and the quiet after it when that is longer. Opening on
 * ten minutes for a two-hour threshold showed none of what the setting does.
 */
function rangeForInactivity(inactivityMs: number): number {
  return (
    RANGES.find((range) => range.ms >= RANGES[1].ms && range.ms >= inactivityMs * 1.5)
    ?? RANGES[RANGES.length - 1]
  ).ms;
}

/*
 * Log-like, because the interesting values span four orders of magnitude: a
 * spinner moves a few hundredths of a percent, an agent printing a diff moves
 * tens. On a straight scale every threshold anybody would pick sits on the
 * floor.
 */
const SCALE_FLOOR = 0.01;
const SCALE_TOP = Math.log10(1 + 100 / SCALE_FLOOR);
function scaleY(percent: number): number {
  const fraction = Math.log10(1 + Math.max(0, percent) / SCALE_FLOOR) / SCALE_TOP;
  return MARGIN.top + PLOT_HEIGHT * (1 - Math.min(1, fraction));
}
const Y_TICKS = [0.1, 1, 10, 100];

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes === 0 || hours >= 10 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const rest = seconds % 60;
  return rest === 0 || minutes >= 10 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function formatPercent(value: number): string {
  if (value === 0) {
    return "0%";
  }
  if (value < 0.01) {
    return "<0.01%";
  }
  return formatInactivityChangePercent(value);
}

const SAMPLE_VERDICTS: Record<ActivitySample["kind"], string> = {
  work: "counts",
  small: "below threshold",
  numbers: "numbers only",
  blank: "went blank",
  identical: "no change",
  baseline: "first look",
};

const EVENT_LABELS: Record<ActivityEvent["kind"], string> = {
  inactive: "went inactive",
  active: "active again",
  chime: "chimed",
  push: "pushed to phone",
  input: "you typed",
};

/** Under the setting being previewed, which is not always the one it was judged by. */
function verdictFor(sample: ActivitySample, counted: boolean): string {
  if (counted) {
    return "counts";
  }
  return sample.kind === "work" ? SAMPLE_VERDICTS.small : SAMPLE_VERDICTS[sample.kind];
}

function sampleColor(sample: ActivitySample, counted: boolean): string {
  if (counted) {
    return GREEN;
  }
  if (sample.kind === "numbers") {
    return BLUE;
  }
  if (sample.kind === "small" || sample.kind === "work") {
    return AMBER;
  }
  return GRAY;
}

export function ActivityChart(props: {
  history: ActivityHistory;
  changePercent: number | undefined;
  inactivityMs: number;
  isReplica: boolean;
}) {
  const { history, changePercent, inactivityMs } = props;
  const [now, setNow] = useState(() => Date.now());
  // Follows the duration being typed until a range is picked by hand.
  const [pickedRangeMs, setPickedRangeMs] = useState<number | null>(null);
  const rangeMs = pickedRangeMs ?? rangeForInactivity(inactivityMs);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const replay = useMemo(
    () => replayInactivity({ history, changePercent, inactivityMs, now }),
    [history, changePercent, inactivityMs, now]
  );

  if (history.samples.length === 0 && history.events.length === 0) {
    return (
      <p className="activity-chart-empty">
        {props.isReplica
          ? "This tab's history is kept on the desktop. Open this dialog there to see it."
          : `This tab has not printed since ${formatClock(getActivityHistoryStartedAt())}, when Dispatcher started keeping its history. Each time it prints, the share of the screen that changed will show up here.`}
      </p>
    );
  }

  const start = now - rangeMs;
  const scaleX = (at: number) => MARGIN.left + PLOT_WIDTH * ((at - start) / rangeMs);
  const latestCells = history.samples[history.samples.length - 1]?.cells ?? 0;
  const thresholdPercent = changePercent ?? (latestCells > 0 ? builtInChangePercent(latestCells) : null);
  const thresholdLabel = changePercent !== undefined
    ? formatInactivityChangePercent(changePercent)
    : thresholdPercent !== null
      ? `default ${formatInactivityChangePercent(thresholdPercent)}`
      : "default";
  const thresholdPhrase = changePercent !== undefined
    ? `at least ${formatInactivityChangePercent(changePercent)} of the screen changes`
    : "more than a spinner or clock changes";

  const lastSpan = replay.spans[replay.spans.length - 1];
  const openSpan = lastSpan?.end === null ? lastSpan : null;
  const summary = replay.inactiveAt !== null
    ? `Active. Goes inactive in ${formatAgo(replay.inactiveAt - now)} unless ${thresholdPhrase}.`
    : openSpan
      ? `Inactive since ${formatClock(openSpan.start)} (${formatAgo(now - openSpan.start)} ago). Comes back when ${thresholdPhrase}.`
      : "Not enough history yet to say.";

  const rows: Array<
    | { type: "sample"; at: number; sample: ActivitySample; counted: boolean }
    | { type: "event"; at: number; event: ActivityEvent }
  > = [
    ...history.samples.map((sample, index) => ({
      type: "sample" as const,
      at: sample.at,
      sample,
      counted: replay.counted[index] ?? false,
    })),
    ...history.events.map((event) => ({ type: "event" as const, at: event.at, event })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 60);

  return (
    <div className="activity-chart">
      <div className="activity-chart-header">
        <span className="activity-chart-summary">{summary}</span>
        <span className="activity-chart-ranges" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.label}
              type="button"
              className={`activity-chart-range${range.ms === rangeMs ? " is-active" : ""}`}
              onClick={() => setPickedRangeMs(range.ms)}
            >
              {range.label}
            </button>
          ))}
        </span>
      </div>
      <svg
        className="activity-chart-plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Screen change over time against the inactivity threshold"
      >
        <defs>
          <pattern id="activity-chart-wait" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={BROWN} strokeWidth="2.5" opacity={0.45} />
          </pattern>
        </defs>

        {replay.waits.map((wait) => {
          const x1 = Math.max(MARGIN.left, scaleX(wait.start));
          const x2 = Math.min(WIDTH - MARGIN.right, scaleX(wait.end));
          if (x2 <= x1) {
            return null;
          }
          const label = formatAgo(inactivityMs);
          return (
            <g key={`wait-${wait.start}`}>
              <rect x={x1} y={MARGIN.top} width={x2 - x1} height={PLOT_HEIGHT} fill="url(#activity-chart-wait)" />
              {x2 - x1 >= label.length * 6 + 8 && (
                <text x={(x1 + x2) / 2} y={MARGIN.top + 11} textAnchor="middle" className="activity-chart-wait-label">
                  {label}
                </text>
              )}
              <title>
                {wait.end > now
                  ? `Quiet since ${formatClock(wait.start)}; inactive at ${formatClock(wait.end)} unless something counts`
                  : `Quiet ${formatClock(wait.start)} – ${formatClock(wait.end)}, the ${label} before going inactive`}
              </title>
            </g>
          );
        })}

        {replay.spans.map((span) => {
          const x1 = Math.max(MARGIN.left, scaleX(span.start));
          const x2 = Math.min(WIDTH - MARGIN.right, scaleX(span.end ?? now));
          if (x2 <= x1) {
            return null;
          }
          return (
            <rect
              key={`span-${span.start}`}
              x={x1}
              y={MARGIN.top}
              width={x2 - x1}
              height={PLOT_HEIGHT}
              fill={BROWN}
              opacity={0.28}
            >
              <title>
                {`Inactive ${formatClock(span.start)} – ${span.end === null ? "now" : formatClock(span.end)}`}
              </title>
            </rect>
          );
        })}

        {Y_TICKS.map((tick) => (
          <g key={`tick-${tick}`}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={scaleY(tick)}
              y2={scaleY(tick)}
              stroke="currentColor"
              opacity={0.12}
            />
            <text x={MARGIN.left - 5} y={scaleY(tick) + 3} textAnchor="end" className="activity-chart-axis">
              {`${tick}%`}
            </text>
          </g>
        ))}
        <line
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={MARGIN.top + PLOT_HEIGHT}
          y2={MARGIN.top + PLOT_HEIGHT}
          stroke="currentColor"
          opacity={0.3}
        />

        {history.samples.map((sample, index) => {
          if (sample.at < start) {
            return null;
          }
          const counted = replay.counted[index] ?? false;
          const x = scaleX(sample.at);
          const base = MARGIN.top + PLOT_HEIGHT;
          const top = sample.kind === "baseline" ? MARGIN.top : Math.min(base - 2, scaleY(sample.percent));
          return (
            <line
              key={`sample-${sample.at}-${index}`}
              x1={x}
              x2={x}
              y1={base}
              y2={top}
              stroke={sampleColor(sample, counted)}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={sample.kind === "baseline" ? "2 2" : undefined}
            >
              <title>
                {`${formatClock(sample.at)} · ${formatPercent(sample.percent)} of the screen (${sample.changedTextChars} chars, ${sample.changedTextRows} rows) · ${verdictFor(sample, counted)}`}
              </title>
            </line>
          );
        })}

        {thresholdPercent !== null && (
          <g>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={scaleY(thresholdPercent)}
              y2={scaleY(thresholdPercent)}
              stroke="var(--accent)"
              strokeDasharray="5 4"
              strokeWidth={1.25}
            />
            <text
              x={WIDTH - MARGIN.right - 2}
              y={scaleY(thresholdPercent) - 4}
              textAnchor="end"
              className="activity-chart-threshold-label"
            >
              {thresholdLabel}
            </text>
          </g>
        )}

        {history.events.map((event, index) => {
          if (event.at < start) {
            return null;
          }
          const x = scaleX(event.at);
          const key = `event-${event.kind}-${event.at}-${index}`;
          const title = <title>{`${formatClock(event.at)} · ${EVENT_LABELS[event.kind]}`}</title>;
          switch (event.kind) {
            case "inactive":
              return (
                <path key={key} d={`M${x - 4} ${MARGIN.top - 9}H${x + 4}L${x} ${MARGIN.top - 2}Z`} fill={BROWN}>
                  {title}
                </path>
              );
            case "active":
              return (
                <path key={key} d={`M${x - 4} ${MARGIN.top - 2}H${x + 4}L${x} ${MARGIN.top - 9}Z`} fill={GREEN}>
                  {title}
                </path>
              );
            case "chime":
            case "push":
              return (
                <g key={key}>
                  <line
                    x1={x}
                    x2={x}
                    y1={MARGIN.top}
                    y2={MARGIN.top + PLOT_HEIGHT}
                    stroke="var(--accent)"
                    strokeWidth={1}
                    opacity={0.7}
                  />
                  {event.kind === "chime"
                    ? <circle cx={x} cy={MARGIN.top - 6} r={3.5} fill="var(--accent)" />
                    : <rect x={x - 3.5} y={MARGIN.top - 9.5} width={7} height={7} fill="var(--accent)" />}
                  {title}
                </g>
              );
            case "input":
              return (
                <line
                  key={key}
                  x1={x}
                  x2={x}
                  y1={MARGIN.top + PLOT_HEIGHT}
                  y2={MARGIN.top + PLOT_HEIGHT + 5}
                  stroke={BLUE}
                  strokeWidth={2}
                >
                  {title}
                </line>
              );
          }
        })}

        {[1, 0.5, 0].map((fraction) => (
          <text
            key={`x-${fraction}`}
            x={MARGIN.left + PLOT_WIDTH * (1 - fraction)}
            y={HEIGHT - 4}
            textAnchor={fraction === 1 ? "start" : fraction === 0 ? "end" : "middle"}
            className="activity-chart-axis"
          >
            {fraction === 0 ? "now" : `-${formatAgo(rangeMs * fraction)}`}
          </text>
        ))}
      </svg>
      <div className="activity-chart-legend">
        <span><i style={{ background: GREEN }} />counts</span>
        <span><i style={{ background: AMBER }} />below threshold</span>
        <span><i style={{ background: BLUE }} />numbers only</span>
        <span><i className="is-hatched" />quiet, before inactive</span>
        <span><i style={{ background: BROWN, opacity: 0.6 }} />inactive</span>
        <span><i className="is-round" style={{ background: "var(--accent)" }} />chime</span>
        <span><i style={{ background: "var(--accent)" }} />push</span>
      </div>
      <div className="activity-chart-table" role="table" aria-label="Recent judgments">
        {rows.map((row, index) => (
          <div
            key={`${row.type}-${row.at}-${index}`}
            className={`activity-chart-row${row.type === "event" ? " is-event" : ""}`}
            role="row"
          >
            <span role="cell">{formatClock(row.at)}</span>
            {row.type === "sample" ? (
              <>
                <span role="cell">
                  {row.sample.kind === "baseline" || row.sample.kind === "identical"
                    ? "—"
                    : `${formatPercent(row.sample.percent)} · ${row.sample.changedTextChars} chars / ${row.sample.changedTextRows} rows`}
                </span>
                <span role="cell" style={{ color: sampleColor(row.sample, row.counted) }}>
                  {verdictFor(row.sample, row.counted)}
                </span>
              </>
            ) : (
              <>
                <span role="cell" />
                <span role="cell">{EVENT_LABELS[row.event.kind]}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <p className="activity-chart-note">
        Each bar is one look at the screen after the tab printed, measured from the last screen that counted.
        Changing the threshold replays this history, so it is close but not exact.
      </p>
    </div>
  );
}
