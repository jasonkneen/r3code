// The Environments page (ConnectionsSettings view="environments"): the "This app" section, then
// "Environments" with its Add environment dialog and one row per environment: the one this app is
// connected to and the saved ones. Adding an environment saves it beside the live connection.
import { savedEnvironments as savedEnvironmentList } from "./environments/savedEnvironments";
import { AutocompleteEmpty, AutocompleteItem, AutocompletePopup, autocompleteShortcutLabel, createAutocomplete } from "../../components/Autocomplete";
import { Clipboard, effect, openUrl, Scroll, signal, Text, View } from "nsh";
import { errorToast, showToast } from "../../components/toast";
import { Switch } from "nsh/base";
import { DialogInput as Input } from "../../components/DialogInput";
import { backendBearer, backendError, backendStatus, backendUrl, configureBackend, requestBackend, subscribeBackend, connectionBlocked, fetchEnvironmentDescriptor, localServerEngine } from "../../store";
import { loadSessionBearer } from "../../backend/sessionCredential";
import { ServerUpdateAction } from "../../environments/ServerUpdateAction";
import { runOutdatedHostUpdate } from "../../environments/outdatedHostUpdate";
import { environmentAttempts, environmentConfigs, environmentConnections, reconnectEnvironment, requestEnvironment, subscribeEnvironment } from "../../environments/connectionManager";
import { connectionDiagnosisText, presentConnectionDiagnosis, type ConnectionDiagnosis } from "../../environments/connectionDiagnosis";
import { record } from "../../backend/client";
import { SettingsButton, SettingsRow, SettingsSection } from "../../components/SettingsLayout";
import { DialogField, SettingsDialog } from "../../components/SettingsDialog";
import { SettingsIcon } from "./SettingsIcon";
import { serverEnvironment } from "./settingsState";
import { discoverSshHosts, ensureSshEnvironment, formatDesktopSshConnectionError, pickLocalTunnelPort, resolveTypedSshTarget, type SshEnvironmentDeps } from "../../environments/sshEnvironment";
import { sshDeps } from "../../environments/sshSaved";
import type { DiscoveredSshHost } from "../../environments/ssh";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { CloudEnvironmentConnectRows } from "../../cloud/CloudEnvironmentConnectList";
import { pendingT3ConnectRemoval, RemoveT3ConnectEnvironmentDialog } from "../../cloud/RemoveT3ConnectEnvironmentDialog";
import { parseAccessSession, sessionHolds, type AccessSession } from "./environments/accessSession";
import { PAIRING_SCOPE_OPTIONS } from "./environments/accessClients";
import { sessionPermissionsUnavailableMessage } from "./environments/connectionsLogic";
import { CLIENT_APP_VERSION, resolveVersionMismatch } from "../../components/coordinators/connection.logic";
import { EnvironmentRow, RowMenu } from "./environments/EnvironmentRow";
import { LoadBalancingSettings, type LoadBalancingEnvironment } from "./providers/LoadBalancingSettings";
import { PullRequestRoutingSettings, type PullRequestRoutingEnvironment } from "./environments/PullRequestRoutingSettings";
import { SearchAnchor as PullRequestRoutingAnchor } from "./SearchAnchor";
import { LocalEnvironmentSetting } from "./environments/LocalEnvironment";
import { LinkedEnvironmentsHost } from "./environments/LinkedEnvironments";
import { EnvironmentRoutesList } from "./environments/EnvironmentRoutesList";
import {
  addEnvironment,
  addEnvironmentRoute,
  environmentMcpUrl,
  environmentStatuses,
  hostToServerAddress,
  loadSavedEnvironments,
  parsePairingUrlFields,
  probeAllSavedEnvironments,
  removeSavedEnvironment,
  savedEnvironmentStatus,
  savedEnvironments,
  setSavedEnvironmentEnabled,
  addSshEnvironment,
  type SavedEnvironment,
} from "./environments/savedEnvironments";

export { hostToServerAddress, parsePairingUrlFields };

const addOpen = signal(false);
const addHost = signal("");
const addCode = signal("");
const addError = signal("");
const adding = signal(false);
const removing = signal<SavedEnvironment | null>(null);
/** AddEnvironmentDialog's routeTarget: the saved environment a new route is for. */
const routeTarget = signal<SavedEnvironment | null>(null);
/** AddEnvironmentDialog's savedBackendMode, and the SSH mode's fields and discovered hosts. */
const addMode = signal<"remote" | "ssh">("remote");
const sshHost = signal("");
const sshUser = signal("");
const sshPort = signal("");
const sshHosts = signal<DiscoveredSshHost[] | null>(null);
const sshHostsOpen = signal(false);

async function loadSshHosts() {
  if (sshHosts() !== null) return;
  try { sshHosts.set(await discoverSshHosts()); } catch { sshHosts.set([]); }
}
/** AddEnvironmentDialog.tsx unsavedDiscoveredSshHosts: hosts a saved SSH environment already uses (its alias, or for a
 * known-hosts entry its address) are not offered again. */
export function unsavedSshHosts<T extends { alias: string; hostname: string; username: string | null; port: number | null; source: string }>(hosts: readonly T[], saved: readonly { ssh?: { target: { alias: string; hostname: string; username: string | null; port: number | null } } }[]): T[] {
  const keys = new Set<string>();
  for (const environment of saved) {
    if (!environment.ssh) continue;
    keys.add(environment.ssh.target.alias);
    keys.add(sshAddress(environment.ssh.target));
  }
  return hosts.filter((host) => !keys.has(host.alias) && (host.source === "ssh-config" || !keys.has(sshAddress(host))));
}
const unsavedHosts = () => unsavedSshHosts(sshHosts() ?? [], savedEnvironmentList());
const filteredSshHosts = () => filterDiscoveredSshHosts(unsavedHosts(), sshHost());

/** filterDiscoveredSshHosts (state/desktopSshHosts.ts): alias prefix matches first, then alias or hostname substrings. */
export function filterDiscoveredSshHosts<T extends { alias: string; hostname: string }>(hosts: readonly T[], query: string): readonly T[] {
  const text = query.trim().toLowerCase();
  if (text.length === 0) return hosts;
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const host of hosts) {
    const alias = host.alias.toLowerCase();
    if (alias.startsWith(text)) prefix.push(host);
    else if (alias.includes(text) || host.hostname.toLowerCase().includes(text)) substring.push(host);
  }
  return [...prefix, ...substring];
}

/** handleSelectSshHostSuggestion: a picked host fills the alias, user and port, then connects at once. */
const sshHostAutocomplete = createAutocomplete<DiscoveredSshHost>({
  items: () => filteredSshHosts(),
  open: () => sshHostsOpen(),
  setOpen: (open) => sshHostsOpen.set(open),
  onSelect: (host) => {
    if (adding()) return;
    sshHost.set(host.alias);
    sshUser.set(host.username ?? "");
    sshPort.set(host.port === null ? "" : String(host.port));
    void submitSshAdd();
  },
});
const sshAddress = (host: { alias: string; hostname: string; username: string | null; port: number | null }) => `${host.username ? `${host.username}@` : ""}${host.hostname}${host.port !== null ? `:${host.port}` : ""}`;

/** Tests fill the SSH fields without typing. */
export function setSshDraftForTest(draft: { host: string; user?: string; port?: string }) { sshHost.set(draft.host); sshUser.set(draft.user ?? ""); sshPort.set(draft.port ?? ""); sshHosts.set([]); }
export const sshAddErrorForTest = () => addError();

/** handleAddSavedBackend, SSH mode: launch or reuse the host's server, tunnel to it, pair, and save it. */
/** provisionDesktopSshEnvironment's bootstrap failure: a reused remote server on another build answers 500 to the pairing. */
export function sshPairingVersionError(error: unknown, descriptor: Record<string, unknown> | null, appVersion: unknown): unknown {
  const serverVersion = descriptor?.serverVersion;
  const label = typeof descriptor?.label === "string" ? descriptor.label : null;
  if (!(error instanceof Error) || !/\(HTTP 500\)/.test(error.message) || label === null || typeof serverVersion !== "string" || typeof appVersion !== "string" || serverVersion === appVersion) return error;
  return new Error(`${label} runs T3 Code ${serverVersion}, but this desktop is ${appVersion}, and that server could not accept its pairing. Restart the T3 server on ${label} so it runs ${appVersion}, then retry.`);
}

export async function submitSshAdd(deps: { ensure?: typeof ensureSshEnvironment; deps?: () => SshEnvironmentDeps; save?: typeof addSshEnvironment; describe?: (address: string) => Promise<Record<string, unknown> | null> } = {}) {
  if (adding()) return;
  adding.set(true);
  addError.set("");
  try {
    const target = resolveTypedSshTarget({ host: sshHost(), username: sshUser(), port: sshPort() }, sshHosts() ?? []);
    const localPort = pickLocalTunnelPort();
    const boot = await (deps.ensure ?? ensureSshEnvironment)(target, localPort, (deps.deps ?? sshDeps)(), { issuePairingToken: true });
    const address = hostToServerAddress(boot.wsBaseUrl);
    // platform.ts provisionDesktopSshEnvironment: no credential blocks; the label is the host's descriptor label, else the alias.
    if (!address || !boot.pairingToken) throw new Error("The SSH environment did not issue a pairing credential.");
    const descriptor = await (deps.describe ?? fetchEnvironmentDescriptor)(address).catch(() => null);
    const label = (typeof descriptor?.label === "string" && descriptor.label.trim()) || target.alias;
    try {
      await (deps.save ?? addSshEnvironment)({ label, address, pairingToken: boot.pairingToken, ssh: { target, localPort } });
    } catch (error) {
      throw sshPairingVersionError(error, descriptor, serverEnvironment()?.serverVersion);
    }
    closeAdd();
    showToast({ type: "success", title: "Environment connected", description: `${target.alias} is ready over an SSH-managed tunnel.` });
  } catch (error) {
    addError.set(formatDesktopSshConnectionError(error));
  } finally {
    adding.set(false);
  }
}

function closeAdd() {
  addOpen.set(false);
  addMode.set("remote");
  sshHost.set(""); sshUser.set(""); sshPort.set(""); sshHostsOpen.set(false);
  routeTarget.set(null);
  addError.set("");
  addHost.set("");
  addCode.set("");
}

async function submitAdd() {
  if (adding()) return;
  adding.set(true);
  addError.set("");
  try {
    const target = routeTarget();
    if (target) {
      await addEnvironmentRoute(target.id, { host: addHost(), pairingCode: addCode() });
      showToast({ type: "success", title: "Route added", description: `${target.label} now has another way to connect.` });
      closeAdd();
      return;
    }
    const result = await addEnvironment({ host: addHost(), pairingCode: addCode() });
    if (result === "saved") showToast({ type: "success", title: "Backend added", description: "The environment is saved and will reconnect on app startup." });
    closeAdd();
  } catch (error) {
    addError.set(error instanceof Error ? error.message : "Failed to add backend.");
  } finally {
    adding.set(false);
  }
}

const primaryStatusText = () =>
  backendStatus() === "connected" ? "Connected" : backendStatus() === "connecting" ? "Connecting" : backendStatus() === "error" ? "Connection failed" : "Not connected";

/** SavedBackendListRow's Copy MCP URL item and its toasts. */
function mcpUrlItem(address: string) {
  const url = environmentMcpUrl(address);
  if (url === null) return [];
  return [{
    label: "Copy MCP URL",
    onSelect: () => {
      void Clipboard.writeText(url)
        .then(() => showToast({ type: "success", title: "MCP URL copied", description: `Add it to an agent, e.g. claude mcp add --transport http t3 ${url}` }))
        .catch((error: unknown) => errorToast("Could not copy MCP URL", error instanceof Error ? error.message : String(error)));
    },
  }];
}

/** SavedBackendListRow's Copy trace ID item, shown while the last failure named one. */
function traceIdItem(traceId: string | undefined) {
  if (!traceId) return [];
  return [{
    label: "Copy trace ID",
    onSelect: () => {
      void Clipboard.writeText(traceId)
        .then(() => showToast({ type: "success", title: "Trace ID copied", description: traceId }))
        .catch((error: unknown) => errorToast("Could not copy trace ID", error instanceof Error ? error.message : String(error)));
    },
  }];
}

function primaryEnvironmentLabel(): string {
  const value = serverEnvironment()?.label;
  if (localServerEngine() === "r3" && (typeof value !== "string" || value.length === 0 || value === "T3 Code")) {
    return "R3 Code";
  }
  return typeof value === "string" && value.length > 0 ? value : "Primary environment";
}

/** The environment this app is connected to (the web lists it under Access; here it is how it is reconnected or disconnected). */
function PrimaryEnvironmentRow() {
  const isR3RustServer = () => localServerEngine() === "r3";
  const label = () => primaryEnvironmentLabel();
  const local = () => /^wss?:\/\/(localhost|127\.|\[::1\])/i.test(backendUrl());
  const address = () => { try { return new URL(backendUrl()).host; } catch { return backendUrl(); } };
  // A server behind this client names its version after the status (SavedEnvironmentRows' subtitleText).
  const mismatch = () => { if (isR3RustServer()) return null; const version = serverEnvironment()?.serverVersion; return backendStatus() === "connected" ? resolveVersionMismatch(typeof version === "string" ? version : null) : null; };
  const engineTag = () => {
    if (!isR3RustServer()) return mismatch()?.serverVersion ?? null;
    const version = serverEnvironment()?.serverVersion;
    return typeof version === "string" && version.length > 0 ? `R3 Rust · ${version}` : "R3 Rust";
  };
  return (
    <EnvironmentRow
      kind={local() ? "desktop" : "server"}
      label={label()}
      subtitle={[local() ? "This machine" : address(), primaryStatusText(), engineTag()].filter((part): part is string => part !== null).join(" · ")}
      subtitleTone={backendStatus() === "error" ? "error" : "muted"}
      below={backendError() ? <Text class="text-xs text-destructive-foreground">{backendError()}</Text> : mismatch() ? <Text class="text-xs text-muted-foreground">{`Update available: ${mismatch()!.serverVersion} → ${mismatch()!.clientVersion}`}</Text> : null}
      testID="Environment row (primary)"
    >
      {/* SavedEnvironmentRows: a server behind the protocol gate gets OutdatedServerUpdateAction (bare-socket update). */}
      {connectionBlocked()?.serverUpdateRequired ? <SettingsButton label="Update" onPress={() => void runOutdatedHostUpdate({ key: "primary", serverLabel: `${label()} server`, endpoint: backendUrl(), bearer: backendBearer(), descriptor: connectionBlocked()!.descriptor, targetVersion: CLIENT_APP_VERSION }, { toast: (toast) => showToast(toast), reconnect: () => configureBackend(backendUrl()) })} /> : null}
      {mismatch() ? <ServerUpdateAction environmentKey="primary" serverLabel={label()} targetVersion={mismatch()!.clientVersion} config={{ environment: serverEnvironment() }} url={backendUrl()} bearer={async () => backendBearer()} request={(method, payload) => requestBackend(method, payload, { timeoutMs: Infinity })} subscribe={subscribeBackend} fromVersion={String(serverEnvironment()?.serverVersion ?? "") || undefined} /> : null}
      <RowMenu
        label={label()}
        items={[
          { label: "Reconnect", onSelect: () => configureBackend(backendUrl()) },
          ...mcpUrlItem(backendUrl()),
          { label: "Disconnect", onSelect: () => configureBackend(""), destructive: true, separatorBefore: true },
        ]}
      />
    </EnvironmentRow>
  );
}

/** SessionPermissions with routeContext: what this client's session on a saved environment may do, read from that
 * environment's `GET /api/auth/session` with its saved bearer. */
export function SavedSessionPermissions(props: { url: string; connected: boolean; read?: (url: string) => Promise<unknown> }) {
  const session = signal<AccessSession | "failed" | null>(null);
  const read = props.read ?? (async (url: string) => {
    const bearer = await loadSessionBearer(url);
    if (!bearer) return null;
    const endpoint = new URL(url);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.pathname = "/api/auth/session"; endpoint.search = ""; endpoint.hash = "";
    const response = await fetch(endpoint.toString(), { headers: { authorization: `Bearer ${bearer}` } });
    return response.ok ? await response.json() : null;
  });
  if (props.connected) void read(props.url).then((value) => session.set(parseAccessSession(value) ?? "failed"), () => session.set("failed"));
  const ready = () => { const value = session(); return value !== null && value !== "failed" && value.authenticated ? value : null; };
  return () => ready() ? (
    <View class="gap-3 py-3">
      <Text class="text-xs text-muted-foreground">These permissions apply to your active route. Other routes may have different permissions.</Text>
      <View class="flex-row flex-wrap gap-x-6 gap-y-2">
        {PAIRING_SCOPE_OPTIONS.map((option) => (
          <View class="w-[45%] flex-row items-start justify-between gap-3">
            <Text class="text-xs text-foreground">{option.title}</Text>
            <Text class="shrink-0 text-xs text-muted-foreground">{sessionHolds(ready()!, option.scope) ? "Allowed" : "Not granted"}</Text>
          </View>
        ))}
      </View>
    </View>
  ) : (
    <Text class="py-3 text-xs text-muted-foreground">
      {sessionPermissionsUnavailableMessage({ connected: props.connected, failed: session() === "failed", rejected: session() !== null && session() !== "failed" && !(session() as AccessSession).authenticated })}
    </Text>
  );
}

const HOP_MARK = { ok: "\u2713", failed: "\u2715", unchecked: "\u2013" } as const;
const HOP_NOTE = { ok: "", failed: "Failed", unchecked: "Not checked" } as const;

/** useConnectionDiagnosis for a saved environment: null while it is connected, off, or has not failed. */
export function savedEnvironmentDiagnosis(environment: SavedEnvironment): ConnectionDiagnosis | null {
  if (!environment.enabled) return null;
  const live = environmentConnections()[environment.id];
  if (!live || live.phase === "connected" || live.phase === "unsupported") return null;
  const attempt = environmentAttempts()[environment.id];
  if (!attempt) return null;
  const version = record(environmentConfigs()[environment.id]?.environment)?.serverVersion;
  return presentConnectionDiagnosis({
    hostLabel: environment.label,
    state: { network: "unknown", phase: live.phase === "error" ? "blocked" : "backoff", attempt: attempt.attempt, lastFailure: attempt.lastFailure, retryAt: attempt.retryAt },
    via: "direct",
    serverVersion: typeof version === "string" ? version : null,
  });
}

/** ConnectionDiagnosisSummary: the headline, the retry state and the Details toggle. */
function DiagnosisSummary(props: { diagnosis: ConnectionDiagnosis; retryAt: number | null; attempt: number; expanded: boolean; onToggle: () => void }) {
  const nowSecond = signal(Date.now());
  effect(() => {
    if (props.retryAt === null) return;
    nowSecond.set(Date.now());
    const timer = setInterval(() => nowSecond.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const seconds = () => (props.retryAt === null ? 0 : Math.ceil((props.retryAt - nowSecond()) / 1000));
  return (
    <View class="gap-0.5">
      <Text class="text-xs text-destructive-foreground">{props.diagnosis.headline}</Text>
      <View class="flex-row flex-wrap items-center gap-1">
        {props.retryAt !== null ? <Text class="text-xs text-muted-foreground">{seconds() > 0 ? `retrying in ${seconds()}s` : "retrying"}</Text> : null}
        {props.retryAt !== null && props.attempt > 0 ? <Text class="text-xs text-muted-foreground">·</Text> : null}
        {props.attempt > 0 ? <Text class="text-xs text-muted-foreground">{`attempt ${props.attempt}`}</Text> : null}
        {props.retryAt !== null || props.attempt > 0 ? <Text class="text-xs text-muted-foreground">·</Text> : null}
        <View role="button" accessibilityLabel="Details" accessibilityState={{ expanded: props.expanded }} onPress={props.onToggle} class="flex-row items-center gap-0.5">
          <Text class="text-xs text-muted-foreground">Details</Text>
          <View style={{ transform: props.expanded ? "rotate(90deg)" : "rotate(0deg)" }}><SettingsIcon name="play" size={7} /></View>
        </View>
      </View>
    </View>
  );
}

/** ConnectionDiagnosisPanel: the hops in order, what to try, the facts, and Retry now / Copy diagnostics. */
export function DiagnosisPanel(props: { hostLabel: string; diagnosis: ConnectionDiagnosis; onRetry: () => void; copy?: (text: string) => Promise<void> }) {
  const copy = () => {
    void (props.copy ?? ((text: string) => Clipboard.writeText(text)))(connectionDiagnosisText(props.hostLabel, props.diagnosis))
      .then(() => showToast({ type: "success", title: "Diagnostics copied" }))
      .catch((error: unknown) => errorToast("Could not copy diagnostics", error instanceof Error ? error.message : String(error)));
  };
  return (
    <View class="mx-4 mb-3 gap-3 border-t border-border-50 pt-2" testID="Connection diagnosis">
      <View class="gap-0.5">
        {props.diagnosis.hops.map((hop) => (
          <View class="flex-row gap-2">
            <Text class={`w-3 text-center text-xs ${hop.result === "failed" ? "text-destructive-foreground" : "text-muted-foreground"}`}>{HOP_MARK[hop.result]}</Text>
            <Text class={`text-xs ${hop.result === "ok" ? "text-foreground" : hop.result === "failed" ? "text-destructive-foreground" : "text-muted-foreground"}`}>{hop.label}</Text>
            {HOP_NOTE[hop.result] ? <Text class={`text-xs ${hop.result === "failed" ? "text-destructive-foreground" : "text-muted-foreground"}`}>{HOP_NOTE[hop.result]}</Text> : null}
          </View>
        ))}
      </View>
      <View class="gap-0.5">
        <Text class="text-xs font-medium text-foreground">What to try</Text>
        {props.diagnosis.steps.map((step, index) => <Text class="pl-1 text-xs text-muted-foreground">{`${index + 1}. ${step}`}</Text>)}
        {props.diagnosis.moreInfoUrl ? <Text role="link" accessibilityLabel="More info" onPress={() => void openUrl(props.diagnosis.moreInfoUrl!).catch(() => undefined)} class="text-xs text-muted-foreground underline">More info</Text> : null}
      </View>
      <View class="gap-0.5">
        {props.diagnosis.facts.map(([label, value]) => (
          <View class="flex-row gap-3"><Text class="w-24 font-mono text-xs text-muted-foreground">{label}</Text><Text class="min-w-0 flex-1 font-mono text-xs text-foreground">{value}</Text></View>
        ))}
      </View>
      <View class="flex-row flex-wrap gap-2">
        <SettingsButton label="Retry now" onPress={props.onRetry} />
        <SettingsButton label="Copy diagnostics" onPress={copy} />
      </View>
    </View>
  );
}

/** SavedBackendListRow. */
function SavedEnvironmentRow(props: { environment: SavedEnvironment }) {
  const environment = props.environment;
  const routesOpen = signal(false);
  const permissionsOpen = signal(false);
  const diagnosisOpen = signal(false);
  const current = () => savedEnvironments().find((item) => item.id === environment.id) ?? environment;
  const diagnosis = () => savedEnvironmentDiagnosis(current());
  const status = () => savedEnvironmentStatus(savedEnvironments().find((item) => item.id === environment.id) ?? environment, environmentStatuses()[environment.id]);
  const enabled = () => (savedEnvironments().find((item) => item.id === environment.id) ?? environment).enabled;
  const config = () => environmentConfigs()[environment.id];
  const mismatch = () => { const version = record(config()?.environment)?.serverVersion; return enabled() && typeof version === "string" ? resolveVersionMismatch(version) : null; };
  return (
    <View>
    <EnvironmentRow
      kind="server"
      label={environment.label}
      subtitle={[environment.label, status().text, mismatch()?.serverVersion ?? null].filter((part): part is string => part !== null).join(" · ")}
      below={diagnosis() ? <DiagnosisSummary diagnosis={diagnosis()!} retryAt={environmentAttempts()[environment.id]?.retryAt ?? null} attempt={environmentAttempts()[environment.id]?.attempt ?? 0} expanded={diagnosisOpen()} onToggle={() => diagnosisOpen.set(!diagnosisOpen())} /> : mismatch() ? <Text class="text-xs text-muted-foreground">{`Update available: ${mismatch()!.serverVersion} → ${mismatch()!.clientVersion}`}</Text> : null}
      subtitleTone={status().tone}
      subtitleTooltip={`${enabled() ? status().text : "Switched off"}${mismatch() ? `\nUpdate available: ${mismatch()!.serverVersion} → ${mismatch()!.clientVersion}` : ""}`}
      dimmed={!enabled()}
      testID={`Environment row ${environment.label}`}
    >
      <Switch
        checked={enabled()}
        onChange={(event: { checked?: boolean; value?: boolean }) => setSavedEnvironmentEnabled(environment.id, Boolean(event?.checked ?? event?.value))}
        accessibilityLabel={`${enabled() ? "Switch off" : "Switch on"} ${environment.label}`}
        testID={`${enabled() ? "Switch off" : "Switch on"} ${environment.label}`}
        class="h-4 w-7 items-center"
        trackClass="h-4 w-6.5 justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out"
        thumbClass="size-3 rounded-full bg-background checked:translate-x-2.5 transition-transform duration-150 ease-in-out"
      />
      {mismatch() ? <ServerUpdateAction environmentKey={environment.id} serverLabel={environment.label} targetVersion={mismatch()!.clientVersion} config={config()} url={environment.url} bearer={() => loadSessionBearer(environment.url)} request={(method, payload) => requestEnvironment(environment.id, method, payload, { timeoutMs: Infinity })} subscribe={(method, payload, onValue, onError) => subscribeEnvironment(environment.id, method, payload, onValue, onError)} /> : null}
      <RowMenu label={environment.label} items={[...(enabled() ? [{ label: "Reconnect", onSelect: () => reconnectEnvironment(environment.id) }] : []), { label: routesOpen() ? "Hide routes" : "Routes", onSelect: () => routesOpen.set(!routesOpen()) }, { label: permissionsOpen() ? "Hide permissions" : "Permissions", onSelect: () => permissionsOpen.set(!permissionsOpen()) }, ...mcpUrlItem(environment.url), ...traceIdItem(environmentStatuses()[environment.id]?.traceId), { label: "Remove from this device…", onSelect: () => requestRemoveEnvironment(environment), destructive: true, separatorBefore: true }]} />
    </EnvironmentRow>
    {routesOpen() ? <EnvironmentRoutesList environment={environment} onAddRoute={() => { addError.set(""); routeTarget.set(environment); addOpen.set(true); }} /> : null}
    {diagnosis() && diagnosisOpen() ? <DiagnosisPanel hostLabel={environment.label} diagnosis={diagnosis()!} onRetry={() => reconnectEnvironment(environment.id)} /> : null}
    {permissionsOpen() ? <View class="mx-4 border-t border-border-50"><SavedSessionPermissions url={environment.url} connected={enabled() && (environmentConnections()[environment.id]?.phase === "connected" || environmentStatuses()[environment.id]?.phase === "connected")} /></View> : null}
    </View>
  );
}

/** EmptyRemoteEnvironments (cloud disabled). */
function EmptyRemoteEnvironments() {
  return (
    <View class="min-h-52 items-center justify-center gap-3 p-6">
      <View class="size-10 items-center justify-center rounded-lg border border-border-60"><SettingsIcon name="chevrons-left-right-ellipsis" size={20} /></View>
      <View class="items-center gap-1">
        <Text class="text-base font-semibold text-foreground">No saved remote environments</Text>
        <Text class="text-sm text-muted-foreground">{hasCloudPublicConfig() ? "Click “Add environment” to pair another environment, or connect one from T3 Connect." : "Click “Add environment” to pair another environment."}</Text>
      </View>
    </View>
  );
}

function ModeCard(props: { mode: "remote" | "ssh"; title: string; description: string; icon: string }) {
  const selected = () => addMode() === props.mode;
  return (
    <View class={`min-h-24 min-w-0 flex-1 flex-row items-start gap-3 rounded-lg border p-4 ${selected() ? "border-ring bg-accent-50" : "border-border-60 hover:bg-muted-40"}`} role="button" accessibilityLabel={props.title} accessibilityState={{ selected: selected() }} disabled={adding()} onPress={() => { addMode.set(props.mode); addError.set(""); if (props.mode === "ssh") void loadSshHosts(); }}>
      <View class="mt-0.5 size-8 items-center justify-center rounded-md border border-border-70"><SettingsIcon name={props.icon} size={16} /></View>
      <View class="min-w-0 flex-1">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <Text class="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</Text>
      </View>
    </View>
  );
}

/** renderSshFields: the host (with the hosts from ~/.ssh/config and known_hosts), username and port. */
function SshFields() {
  return (
    <View class="gap-3">
      <DialogField label="SSH host or alias">
        <Input accessibilityLabel="SSH host or alias" value={sshHost()} placeholder="Search hosts or type devbox" autoCapitalize="none" autoCorrect={false} disabled={adding()}
          onChange={(event) => { sshHost.set(event.value); sshHostsOpen.set(true); addError.set(""); }}
          onFocus={() => { void loadSshHosts(); sshHostAutocomplete.onFocus(); }} onBlur={sshHostAutocomplete.onBlur}
          onSubmit={() => { if (sshHostAutocomplete.highlighted() < 0 && sshHost().trim()) void submitSshAdd(); }} class={FIELD_CLASS} />
        {/* AddEnvironmentDialog.tsx: the popup shows while hosts load or there are discovered hosts (hasSshHostSuggestionContent). */}
        {sshHostsOpen() && (sshHosts() === null || unsavedHosts().length > 0) ? (
          <AutocompletePopup label="SSH hosts">
            {sshHosts() === null ? <Text class="px-3 py-2 text-xs text-muted-foreground">Loading hosts…</Text>
              : filteredSshHosts().length === 0 ? <AutocompleteEmpty>{`No hosts match "${sshHost().trim()}".`}</AutocompleteEmpty>
              : filteredSshHosts().map((host, index) => (
                <AutocompleteItem label={host.alias} highlighted={sshHostAutocomplete.highlighted() === index} onHover={() => sshHostAutocomplete.highlighted.set(index)} onPress={() => sshHostAutocomplete.pick(host)} class="h-8 min-h-8">
                  <Text class="min-w-0 truncate text-sm font-medium text-popover-foreground">{host.alias}</Text>
                  {sshAddress(host) !== host.alias ? <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{sshAddress(host)}</Text> : <View class="flex-1" />}
                  {autocompleteShortcutLabel(index) ? <Text class="shrink-0 text-xs tracking-widest text-muted-foreground-70">{autocompleteShortcutLabel(index)!}</Text> : null}
                </AutocompleteItem>
              ))}
          </AutocompletePopup>
        ) : null}
      </DialogField>
      <View class="flex-row gap-3">
        <DialogField label="Username" class="min-w-0 flex-1">
          <Input accessibilityLabel="Username" value={sshUser()} placeholder="root" autoCapitalize="none" autoCorrect={false} disabled={adding()} onChange={(event) => sshUser.set(event.value)} onSubmit={() => void submitSshAdd()} class={FIELD_CLASS} />
        </DialogField>
        <DialogField label="Port" class="w-40">
          <Input accessibilityLabel="Port" value={sshPort()} placeholder="22" disabled={adding()} onChange={(event) => sshPort.set(event.value)} onSubmit={() => void submitSshAdd()} class={FIELD_CLASS} />
        </DialogField>
      </View>
    </View>
  );
}

const FIELD_CLASS = "h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";

function AddEnvironmentDialog() {
  return (
    <SettingsDialog
      open={addOpen()}
      onClose={closeAdd}
      title={routeTarget() ? `Add a route to ${routeTarget()!.label}` : "Add Environment"}
      description={routeTarget() ? "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine." : "Pair another environment to this client."}
      width={768}
      testID="Add Environment dialog"
    >
      <View class="gap-4">
        <View class="flex-row gap-3">
          <ModeCard mode="remote" title="Remote link" description="Enter a backend host and pairing code." icon="chevrons-left-right-ellipsis" />
          {!routeTarget() ? <ModeCard mode="ssh" title="SSH" description="Use local SSH config, agent, and tunnels for the backend." icon="terminal" /> : null}
        </View>
        {addMode() === "ssh" ? <SshFields /> : <View class="gap-3">
          <View class="flex-row gap-3">
            <DialogField label="Host" class="min-w-0 flex-1">
              <Input
                accessibilityLabel="Host"
                value={addHost()}
                placeholder="backend.example.com"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={adding()}
                onChange={(event) => {
                  const parsed = parsePairingUrlFields(event.value);
                  if (parsed) { addHost.set(parsed.host); addCode.set(parsed.pairingCode); } else addHost.set(event.value);
                  addError.set("");
                }}
                onSubmit={() => void submitAdd()}
                class={FIELD_CLASS}
              />
            </DialogField>
            <DialogField label="Pairing code" class="w-40">
              <Input
                accessibilityLabel="Pairing code"
                value={addCode()}
                placeholder="PAIRCODE"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={adding()}
                onChange={(event) => addCode.set(event.value)}
                onSubmit={() => void submitAdd()}
                class={FIELD_CLASS}
              />
            </DialogField>
          </View>
          <Text class="text-2xs text-muted-foreground">Paste a full pairing URL here to fill both fields automatically.</Text>
        </View>}
        {addError() ? <Text class="text-xs text-destructive-foreground">{addError()}</Text> : null}
        <View
          role="button"
          accessibilityLabel="Confirm add environment"
          disabled={adding()}
          onPress={() => void (addMode() === "ssh" ? submitSshAdd() : submitAdd())}
          class="h-8 w-full flex-row items-center justify-center gap-1.5 rounded-lg border border-input bg-background hover:bg-accent"
        >
          <SettingsIcon name="plus" size={14} />
          <Text class="text-sm font-medium text-foreground">{adding() ? "Adding…" : routeTarget() ? "Add route" : "Add environment"}</Text>
        </View>
      </View>
    </SettingsDialog>
  );
}

/** ConnectionsSettings handleRemoveSavedBackend: a T3 Connect route (with the T3 Connect config present) gets its own confirm. */
function requestRemoveEnvironment(environment: SavedEnvironment) {
  if (environment.relay && hasCloudPublicConfig()) pendingT3ConnectRemoval.set({ id: environment.id, label: environment.label, relayEnvironmentId: environment.relay.environmentId });
  else removing.set(environment);
}

function RemoveEnvironmentDialog() {
  return (
    <SettingsDialog
      open={removing() !== null}
      onClose={() => removing.set(null)}
      title={`Remove ${removing()?.label ?? "environment"} from this device?`}
      description="This forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved."
      footer={
        <>
          <SettingsButton label="Cancel" onPress={() => removing.set(null)} />
          <SettingsButton
            label="Remove from this device"
            tone="destructive"
            onPress={() => { const target = removing(); removing.set(null); if (target) void removeSavedEnvironment(target.id); }}
          />
        </>
      }
    />
  );
}

export function EnvironmentsSection() {
  void loadSavedEnvironments().then(() => probeAllSavedEnvironments());
  const empty = () => savedEnvironments().length === 0;
  return (
    <SettingsSection
      title="Environments"
      headerAction={
        <View
          role="button"
          accessibilityLabel="Add environment"
          onPress={() => { addError.set(""); addOpen.set(true); }}
          class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent"
        >
          <SettingsIcon name="plus" size={12} />
          <Text class="text-xs font-medium text-muted-foreground">Add environment</Text>
        </View>
      }
    >
      {backendUrl() ? <PrimaryEnvironmentRow /> : null}
      {backendUrl() && !empty() ? <View class="h-px bg-border-50" /> : null}
      <Each of={savedEnvironments()} key={(item) => item.id}>
        {(item) => (
          <View>
            <SavedEnvironmentRow environment={item()} />
            <View class="h-px bg-border-50" />
          </View>
        )}
      </Each>
      {hasCloudPublicConfig() ? (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={typeof serverEnvironment()?.environmentId === "string" ? (serverEnvironment()!.environmentId as string) : null}
          savedEnvironments={() => savedEnvironments().map((item) => ({ environmentId: item.relay?.environmentId ?? item.id, relayManaged: item.relay !== undefined, connection: environmentConnections()[item.id] ?? { phase: "available", error: null } }))}
          empty={<EmptyRemoteEnvironments />}
        />
      ) : empty() ? <EmptyRemoteEnvironments /> : null}
    </SettingsSection>
  );
}

/** Every environment this app lists: the live one and the saved ones, as the load balancing rows take them. */
function balancingEnvironments(): LoadBalancingEnvironment[] {
  const live: LoadBalancingEnvironment[] = backendUrl()
    ? [{ environmentId: backendUrl(), label: primaryEnvironmentLabel(), subtitle: primaryStatusText(), kind: "desktop" }]
    : [];
  return [...live, ...savedEnvironments().map((item): LoadBalancingEnvironment => ({ environmentId: item.url, label: item.label, subtitle: item.label, kind: "server" }))];
}

/** The same environments with their saved routes, which key pull request routing trust (pullRequestRoutingConnectionKey). */
function routingEnvironments(): PullRequestRoutingEnvironment[] {
  const live: PullRequestRoutingEnvironment[] = backendUrl()
    ? [{ environmentId: backendUrl(), label: primaryEnvironmentLabel(), subtitle: primaryStatusText(), kind: "desktop", urls: [backendUrl()] }]
    : [];
  return [...live, ...savedEnvironments().map((item): PullRequestRoutingEnvironment => ({ environmentId: item.url, label: item.label, subtitle: item.label, kind: "server", urls: item.ssh ? [`ssh://${item.ssh.target.alias}/${item.ssh.target.hostname}/${item.ssh.target.username ?? ""}/${item.ssh.target.port ?? ""}`] : [item.url, ...(item.alternateUrls ?? [])] }))];
}

export function ConnectionSettings() {
  return (
    <>
      <SettingsSection title="This app">
        <LocalEnvironmentSetting />
      </SettingsSection>
      <EnvironmentsSection />
      <LinkedEnvironmentsHost />
      <LoadBalancingSettings environments={balancingEnvironments()} />
      <PullRequestRoutingAnchor path="/settings/connections" id="pull-request-routing"><PullRequestRoutingSettings environments={routingEnvironments()} /></PullRequestRoutingAnchor>
      <AddEnvironmentDialog />
      <RemoveEnvironmentDialog />
      {hasCloudPublicConfig() ? <RemoveT3ConnectEnvironmentDialog onConfirm={(target) => { pendingT3ConnectRemoval.set(null); void removeSavedEnvironment(target.id); }} /> : null}
    </>
  );
}
