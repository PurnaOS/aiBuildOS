/**
 * One build session's stream, opened from Now (RQ-0021, ST-0038). Tab id: `session:<sessionId>`.
 *
 * A placeholder until ST-0038 lands.
 */
export function SessionTab(_props: { projectId: string; sessionId: string }): React.JSX.Element {
  return <p className="p-6 text-sm text-neutral-500">This build has nothing to show yet.</p>;
}
