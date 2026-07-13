export function ToolCallPanel() {
  return (
    <aside style={{ width: 260, borderLeft: "1px solid var(--border, #333)", padding: 8 }}>
      <h3>Tool calls</h3>
      <small style={{ opacity: 0.6 }}>Streaming of tool calls is deferred to a later milestone.</small>
    </aside>
  );
}
