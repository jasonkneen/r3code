// T3 Connect sign-in on this native client. The reference opens Clerk's sign-in modal
// (useT3ConnectAuthPrompt -> clerk.openSignIn) and shows "Sign in to T3 Connect" in the Settings sidebar
// (T3ConnectSidebarSignIn). Clerk JS does not run in this app, so the sign-in page is the hosted /connect
// route in a WebView, finished through the public CLI OAuth app's loopback redirect (connectAuth.ts).
import { Image, signal, Text, token, View, WebView } from "nsh";
import logInIcon from "../icons/log-in.svg";
import { openAccountPage } from "./AccountPages";
import type { WebViewNavigation } from "nsh";
import { SettingsDialog } from "../components/SettingsDialog";
import { showToast } from "../components/toast/toastState";
import { readConnectCallback } from "./connectAuth";
import { beginConnectSignIn, cancelPendingConnectSignIn, connectAuthState, loadConnectSession, type ConnectSignInRequest } from "./connectSession";
import { hasCloudPublicConfig } from "./publicConfig";

const pending = signal<ConnectSignInRequest | null>(null);
let finishing = false;

export const connectSignInOpen = () => pending() !== null;

/** useT3ConnectAuthPrompt.openAuthPrompt. */
export async function openConnectSignIn(): Promise<void> {
  if (pending() !== null) return;
  try {
    finishing = false;
    pending.set(await beginConnectSignIn());
  } catch (error) {
    showToast({ type: "error", title: "Could not start sign-in", description: error instanceof Error ? error.message : String(error) });
  }
}

export function closeConnectSignIn(): void {
  finishing = false;
  pending.set(null);
  cancelPendingConnectSignIn();
}

/** Every navigation of the sign-in WebView: the loopback callback ends the flow. */
export function handleConnectNavigation(url: string): boolean {
  const request = pending();
  if (!request || finishing) return false;
  const result = readConnectCallback(url, request.state);
  if (result === null) return false;
  finishing = true;
  if (result.kind !== "code") {
    finishing = false;
    pending.set(null);
    cancelPendingConnectSignIn();
    showToast({ type: "error", title: "Could not sign in to T3 Connect", description: result.kind === "invalid" ? "Invalid T3 Connect authorization callback." : result.message });
    return true;
  }
  void request.finish(result.code).then(
    () => {
      if (pending() === request) {
        finishing = false;
        pending.set(null);
      }
    },
    (error) => {
      if (pending() === request) {
        finishing = false;
        pending.set(null);
        showToast({ type: "error", title: "Could not sign in to T3 Connect", description: error instanceof Error ? error.message : String(error) });
      }
    },
  );
  return true;
}

export function ConnectSignInDialogHost() {
  return () => {
    const request = pending();
    if (!request) return null;
    const onNavigation = (event: WebViewNavigation) => { if (event?.url) handleConnectNavigation(event.url); };
    return (
      <SettingsDialog open width={512} title="Sign in to T3 Connect" onClose={closeConnectSignIn}>
        <View class="h-[560px] overflow-hidden rounded-lg border border-border">
          <WebView src={request.url} class="flex-1" onLoadStart={onNavigation} onNavigationStateChange={onNavigation} onLoad={onNavigation} />
        </View>
      </SettingsDialog>
    );
  };
}

/** T3ConnectSidebarSignIn: shown while signed out, when the public config exists. The reference mounts it in the
 * Settings sidebar nav (SettingsSidebarNav.tsx:439). */
export function T3ConnectSidebarSignIn() {
  void loadConnectSession();
  return () => {
    if (!hasCloudPublicConfig() || connectAuthState().status !== "signed-out") return null;
    return (
      <View
        role="button"
        accessibilityLabel="Sign in to T3 Connect"
        class="h-8 flex-row items-center gap-2 rounded-lg px-2 hover:bg-sidebar-row-hover"
        onPress={() => void openConnectSignIn()}
      >
        <Image src={logInIcon} style={{ width: 16, height: 16, tintColor: token("sidebar-foreground") }} />
        <Text class="text-sm text-sidebar-foreground">Sign in to T3 Connect</Text>
      </View>
    );
  };
}

/** T3ConnectSidebarAvatar: the signed-in account's button (Clerk UserButton, size-7), opening the account pages. */
export function T3ConnectSidebarAvatar() {
  void loadConnectSession();
  return () => {
    const auth = connectAuthState();
    if (!hasCloudPublicConfig() || auth.status !== "signed-in") return null;
    const initial = (auth.identity ?? "?").trim().charAt(0).toUpperCase() || "?";
    return (
      <View role="button" accessibilityLabel={auth.identity ? `Open account for ${auth.identity}` : "Open account"} onPress={() => openAccountPage()}
        class="mb-1 self-start rounded-lg p-1 hover:bg-sidebar-row-hover">
        <View class="size-7 items-center justify-center rounded-full bg-primary">
          <Text class="text-xs font-semibold text-primary-foreground">{initial}</Text>
        </View>
      </View>
    );
  };
}
